import { BadRequestException, ConflictException, Inject, Injectable, UnauthorizedException } from "@nestjs/common";
import { ConfigService } from "@nestjs/config";
import * as argon2 from "argon2";
import { randomUUID } from "node:crypto";
import { resolveDeviceInfo } from "@/common/utils/device.util.js";
import type { Env } from "@/config/env.schema.js";
import { AuthProvider, EmailTokenType, UserStatus } from "@/database/schema/enums.js";
import { EMAIL_SENDER, type EmailSender } from "@/integrations/email/email-sender.interface.js";
import { EmailTokensService } from "@/modules/auth/email-tokens.service.js";
import { GoogleAuthService } from "@/modules/auth/google-auth.service.js";
import { SocialIdentitiesService } from "@/modules/auth/social-identities.service.js";
import { TwoFactorService } from "@/modules/auth/two-factor.service.js";
import type { SignupInput } from "@/modules/auth/dto/signup.schema.js";
import type { SigninInput } from "@/modules/auth/dto/signin.schema.js";
import { TokensService } from "@/modules/auth/tokens.service.js";
import { UsersService, type UserWithRoles } from "@/modules/users/users.service.js";
import { PermissionsService } from "@/modules/authorization/permissions.service.js";
import { toPublicUser, type PublicUser } from "@/modules/users/users.mapper.js";

export interface LoginContext {
    userAgent?: string;
    ipAddress?: string;
}

@Injectable()
export class AuthService {
    constructor(
        private readonly usersService: UsersService,
        private readonly tokensService: TokensService,
        private readonly emailTokensService: EmailTokensService,
        private readonly socialIdentitiesService: SocialIdentitiesService,
        private readonly googleAuthService: GoogleAuthService,
        private readonly twoFactorService: TwoFactorService,
        private readonly permissionsService: PermissionsService,
        private readonly configService: ConfigService<Env, true>,
        @Inject(EMAIL_SENDER) private readonly emailSender: EmailSender,
    ) {}

    /** Lazily built once — see burnPasswordComparison. */
    private decoyPasswordHash?: Promise<string>;

    async signup(input: SignupInput): Promise<{ user: PublicUser }> {
        const existing = await this.usersService.findByEmail(input.email);
        if (existing?.deletedAt) {
            // The row is still there (grace period), so the unique email would
            // reject this signup. Offering the account back beats a dead-end
            // 409 the owner cannot act on.
            await this.offerReactivation(existing.id, existing.email, existing.deletedAt);
        }
        if (existing) {
            throw new ConflictException("An account with this email already exists");
        }

        const passwordHash = await argon2.hash(input.password);
        const user = await this.usersService.createUser({
            email: input.email,
            passwordHash,
            name: input.name,
            phone: input.phone,
        });

        await this.sendVerificationEmail(user.id, user.email);

        return { user: toPublicUser(user) };
    }

    async signin(input: SigninInput, context: LoginContext) {
        const user = await this.usersService.findByEmail(input.email);
        if (!user) {
            // Returning here immediately made an unknown address answer in a
            // millisecond while a known one paid for an Argon2 verify — the reply
            // is identical either way, but the clock gave the answer away.
            await this.burnPasswordComparison(input.password);
            throw new UnauthorizedException("Invalid email or password");
        }

        if (user.lockedUntil && user.lockedUntil > new Date()) {
            throw new UnauthorizedException("Account temporarily locked due to too many failed attempts");
        }

        if (user.status === UserStatus.SUSPENDED) {
            throw new UnauthorizedException("This account has been suspended");
        }

        if (!user.password) {
            throw new UnauthorizedException(
                "This account signs in with Google — set a password from account settings to use this method",
            );
        }

        const passwordValid = await argon2.verify(user.password, input.password);
        if (!passwordValid) {
            await this.usersService.recordFailedLogin(
                user.id,
                this.configService.get("LOGIN_MAX_ATTEMPTS", { infer: true }),
                this.configService.get("LOGIN_LOCKOUT_MINUTES", { infer: true }),
            );
            throw new UnauthorizedException("Invalid email or password");
        }

        // Reset before the verification bail-out: the password was correct, so the
        // failure counter has to clear here too or an unverified user accumulates
        // strikes and locks themselves out while signing in correctly.
        await this.usersService.resetFailedLogin(user.id);

        // Only now, with the password proven, is it safe to admit the account is
        // awaiting deletion — checking earlier would let anyone probe an address
        // for it. Deletion is self-service, so whoever holds the password is the
        // person entitled to undo it.
        if (user.deletedAt) {
            await this.offerReactivation(user.id, user.email, user.deletedAt);
        }

        if (user.status === UserStatus.PENDING_VERIFICATION) {
            await this.sendVerificationEmail(user.id, user.email);
            throw new UnauthorizedException({
                code: "EMAIL_NOT_VERIFIED",
                message: "Please verify your email before logging in",
            });
        }

        if (user.twoFactorEnabled) {
            return { twoFactorRequired: true as const, twoFactorToken: this.tokensService.signTwoFactorToken(user.id) };
        }

        return this.issueSession(user, context, {
            deviceType: input.deviceType,
            deviceName: input.deviceName,
        });
    }

    async refresh(
        rawRefreshToken: string,
        context: LoginContext,
        explicitDevice?: { deviceType?: string; deviceName?: string },
    ) {
        const consumption = await this.tokensService.consumeRefreshToken(rawRefreshToken);

        if (consumption.outcome === "reused") {
            // consumeRefreshToken has already dropped the rotation chain. Bumping
            // the token version closes the access-token window too, so a thief who
            // refreshed first loses the session instead of inheriting it.
            await this.permissionsService.bumpTokenVersion(consumption.userId);
            throw new UnauthorizedException("This session was ended for security reasons — please sign in again");
        }

        if (consumption.outcome === "invalid") {
            throw new UnauthorizedException("Invalid or expired refresh token");
        }

        const { record } = consumption;
        if (record.user.deletedAt || record.user.status !== UserStatus.ACTIVE) {
            throw new UnauthorizedException("Invalid or expired refresh token");
        }

        // Same family: this is a rotation of an existing login, not a new one.
        return this.issueSession(record.user, context, explicitDevice, record.familyId);
    }

    async logout(rawRefreshToken: string): Promise<void> {
        await this.tokensService.revokeRefreshToken(rawRefreshToken);
    }

    /** Verifying implies the user just proved control of the account, so it also signs them in. */
    async verifyEmail(
        email: string,
        code: string,
        context: LoginContext,
        explicitDevice?: { deviceType?: string; deviceName?: string },
    ) {
        const user = await this.usersService.findByEmail(email);
        if (
            !user ||
            !this.isReachableAccount(user) ||
            !(await this.emailTokensService.consume(user.id, EmailTokenType.VERIFY_EMAIL, code))
        ) {
            throw new BadRequestException("Invalid or expired verification code");
        }
        const verified = await this.usersService.markEmailVerified(user.id);
        // The guard authorizes against the account's status, so the cached
        // principal has to drop its now-stale PENDING_VERIFICATION copy.
        await this.permissionsService.invalidateCache(user.id);
        return this.issueSession(verified, context, explicitDevice);
    }

    async resendVerification(email: string): Promise<void> {
        const user = await this.usersService.findByEmail(email);
        if (!user || user.status !== UserStatus.PENDING_VERIFICATION) {
            return; // don't reveal whether the account exists
        }
        await this.sendVerificationEmail(user.id, user.email);
    }

    async forgotPassword(email: string): Promise<void> {
        const user = await this.usersService.findByEmail(email);
        if (!user || !this.isReachableAccount(user)) {
            return; // don't reveal whether the account exists
        }

        const code = await this.emailTokensService.issueResetPasswordToken(user.id);
        if (code) {
            await this.emailSender.sendResetPassword({ to: user.email, code });
        }
    }

    /**
     * Also used for the admin-invite flow: an invited admin has no password
     * yet, so completing this reset both sets their password and verifies
     * the account (proving ownership of the invited email address).
     *
     * Consuming the code proves account ownership, so this also signs the user in.
     */
    async resetPassword(
        email: string,
        code: string,
        newPassword: string,
        context: LoginContext,
        explicitDevice?: { deviceType?: string; deviceName?: string },
    ) {
        const user = await this.usersService.findByEmail(email);
        if (
            !user ||
            !this.isReachableAccount(user) ||
            !(await this.emailTokensService.consume(user.id, EmailTokenType.RESET_PASSWORD, code))
        ) {
            // Deliberately the same error as a bad code: a suspended account must
            // not be able to tell its suspension apart from a wrong code.
            throw new BadRequestException("Invalid or expired reset code");
        }

        const passwordHash = await argon2.hash(newPassword);
        await this.usersService.setPassword(user.id, passwordHash);
        await this.usersService.markEmailVerified(user.id);
        await this.tokensService.revokeAllRefreshTokens(user.id);
        // Refresh tokens are revoked above, but access tokens already in the wild
        // stay signature-valid until they expire — bumping tokenVersion kills those too.
        await this.permissionsService.bumpTokenVersion(user.id);

        const refreshed = await this.usersService.findByIdOrThrow(user.id);
        return this.issueSession(refreshed, context, explicitDevice);
    }

    async changePassword(userId: string, currentPassword: string, newPassword: string): Promise<void> {
        const user = await this.usersService.findById(userId);
        if (!user || user.deletedAt) {
            throw new UnauthorizedException("Invalid credentials");
        }

        if (!user.password) {
            throw new BadRequestException("No password set yet — use the set-password endpoint instead");
        }

        const passwordValid = await argon2.verify(user.password, currentPassword);
        if (!passwordValid) {
            throw new UnauthorizedException("Current password is incorrect");
        }

        const isSamePassword = await argon2.verify(user.password, newPassword);
        if (isSamePassword) {
            throw new BadRequestException("New password must be different from the current password");
        }

        const passwordHash = await argon2.hash(newPassword);
        await this.usersService.setPassword(userId, passwordHash);
        await this.tokensService.revokeAllRefreshTokens(userId);
        await this.permissionsService.bumpTokenVersion(userId);
    }

    /** For social-only accounts (no password yet) to add password login as a second method. */
    async setPassword(userId: string, newPassword: string): Promise<void> {
        const user = await this.usersService.findById(userId);
        if (!user || user.deletedAt) {
            throw new UnauthorizedException("Invalid credentials");
        }

        if (user.password) {
            throw new BadRequestException("Password already set — use change-password instead");
        }

        const passwordHash = await argon2.hash(newPassword);
        await this.usersService.setPassword(userId, passwordHash);
    }

    async loginWithGoogle(idToken: string, context: LoginContext) {
        const profile = await this.googleAuthService.verifyIdToken(idToken);
        if (!profile.emailVerified) {
            throw new UnauthorizedException("Google account email is not verified");
        }

        const identity = await this.socialIdentitiesService.findByProviderAccount(
            AuthProvider.GOOGLE,
            profile.providerAccountId,
        );

        const user = identity ? identity.user : await this.linkOrCreateGoogleUser(profile);

        if (user.deletedAt) {
            await this.offerReactivation(user.id, user.email, user.deletedAt);
        }

        if (user.status === UserStatus.SUSPENDED) {
            throw new UnauthorizedException("This account is not available");
        }

        return this.issueSession(user, context);
    }

    private async linkOrCreateGoogleUser(profile: { providerAccountId: string; email: string; name?: string }) {
        const existingUser = await this.usersService.findByEmail(profile.email);

        if (existingUser) {
            if (existingUser.deletedAt) {
                // Bail before linking: a deleted account must be restored first,
                // or this call would quietly attach an identity to a row the
                // purge job is about to remove.
                await this.offerReactivation(existingUser.id, existingUser.email, existingUser.deletedAt);
            }

            // The account is allowed one identity per provider. Reaching here with
            // a different one means a second Google account shares this email
            // address; saying so beats the raw constraint violation the database
            // would otherwise raise.
            const linked = await this.socialIdentitiesService.findByUserAndProvider(
                existingUser.id,
                AuthProvider.GOOGLE,
            );

            if (linked) {
                throw new ConflictException("This account is already linked to a different Google account");
            }

            await this.socialIdentitiesService.link(
                existingUser.id,
                AuthProvider.GOOGLE,
                profile.providerAccountId,
                profile.email,
            );
            if (!existingUser.emailVerifiedAt) {
                await this.usersService.markEmailVerified(existingUser.id);
                await this.permissionsService.invalidateCache(existingUser.id);
            }
            await this.emailSender.sendAccountLinked({ to: existingUser.email, provider: "Google" });
            return existingUser;
        }

        const user = await this.usersService.createUser({
            email: profile.email,
            name: profile.name,
            status: UserStatus.ACTIVE,
            emailVerifiedAt: new Date(),
        });
        await this.socialIdentitiesService.link(user.id, AuthProvider.GOOGLE, profile.providerAccountId, profile.email);
        return user;
    }

    /**
     * `currentSessionId` is the caller's own refresh-token family, taken from
     * their access token. Without `isCurrent` the client cannot tell which row
     * is the device in the user's hand, so "sign out" is a coin flip.
     */
    async listSessions(userId: string, currentSessionId?: string) {
        const sessions = await this.tokensService.listActiveSessions(userId);
        return sessions.map(({ tokenHash: _tokenHash, ...session }) => ({
            ...session,
            isCurrent: currentSessionId !== undefined && session.familyId === currentSessionId,
        }));
    }

    async revokeSession(userId: string, sessionId: string): Promise<void> {
        await this.tokensService.revokeSessionById(userId, sessionId);
    }

    async revokeAllSessions(userId: string): Promise<void> {
        await this.tokensService.revokeAllRefreshTokens(userId);
        await this.permissionsService.bumpTokenVersion(userId);
    }

    async requestAccountDeletion(userId: string): Promise<void> {
        const user = await this.usersService.findById(userId);
        if (!user || user.deletedAt) {
            throw new UnauthorizedException("Invalid credentials");
        }

        const code = await this.emailTokensService.issueDeleteAccountToken(user.id);
        if (code) {
            await this.emailSender.sendDeleteAccountCode({ to: user.email, code });
        }
    }

    /** Consuming the code proves intent + account ownership, then soft-deletes and logs the user out everywhere. */
    async deleteAccount(userId: string, code: string): Promise<void> {
        const user = await this.usersService.findById(userId);
        if (!user || user.deletedAt) {
            throw new UnauthorizedException("Invalid credentials");
        }

        if (!(await this.emailTokensService.consume(user.id, EmailTokenType.DELETE_ACCOUNT, code))) {
            throw new BadRequestException("Invalid or expired confirmation code");
        }

        await this.usersService.softDelete(user.id);
        await this.tokensService.revokeAllRefreshTokens(user.id);
        await this.permissionsService.bumpTokenVersion(user.id);

        const graceDays = this.configService.get("DELETED_USER_GRACE_DAYS", { infer: true });
        await this.emailSender.sendAccountDeleted({ to: user.email, graceDays });
    }

    /**
     * Creates an account with the given roles and emails a reset code. The
     * placeholder password is unusable by design — completing the reset is what
     * both sets a real password and proves the invitee owns the address.
     */
    async invite(email: string, roleIds: string[]): Promise<PublicUser> {
        const existing = await this.usersService.findByEmail(email);
        if (existing) {
            throw new ConflictException(
                existing.deletedAt
                    ? "This address belongs to an account awaiting deletion — its owner must reactivate it, or the grace period must run out first"
                    : "An account with this email already exists",
            );
        }

        const placeholderPassword = await argon2.hash(randomUUID());
        const user = await this.usersService.createUser({
            email,
            passwordHash: placeholderPassword,
            roleIds,
        });

        const code = await this.emailTokensService.issueResetPasswordToken(user.id);
        if (code) {
            await this.emailSender.sendResetPassword({ to: user.email, code });
        }

        return toPublicUser(user);
    }

    /**
     * Refused while 2FA is already on. Issuing a fresh secret here would leave the
     * account enrolled against a secret nobody has yet, so the old behaviour was
     * effectively "turn 2FA off" — bypassing disableTwoFactor, which deliberately
     * demands the password plus a live code. Turning 2FA off must stay one path.
     */
    async setupTwoFactor(userId: string) {
        const user = await this.usersService.findById(userId);
        if (!user || user.deletedAt) {
            throw new UnauthorizedException("Invalid credentials");
        }

        if (user.twoFactorEnabled) {
            throw new ConflictException("Two-factor authentication is already enabled — disable it first to re-enrol");
        }

        return this.twoFactorService.setup(user.id, user.email);
    }

    async enableTwoFactor(userId: string, code: string) {
        return this.twoFactorService.enable(userId, code);
    }

    /**
     * The password check is skipped for accounts that have none — Google-only
     * users. Requiring it there made 2FA impossible to turn off once
     * enabled, with no recovery path short of a support ticket; the authenticator
     * code is the strongest proof those accounts can offer.
     */
    async disableTwoFactor(userId: string, password: string | undefined, code: string): Promise<void> {
        const user = await this.usersService.findById(userId);
        if (!user || user.deletedAt) {
            throw new UnauthorizedException("Invalid credentials");
        }

        if (user.password) {
            if (!password) {
                throw new BadRequestException("Your password is required to disable two-factor authentication");
            }

            const passwordValid = await argon2.verify(user.password, password);
            if (!passwordValid) {
                throw new UnauthorizedException("Incorrect password");
            }
        }

        const codeValid = await this.twoFactorService.verifyCode(userId, code);
        if (!codeValid) {
            throw new BadRequestException("Invalid authenticator code");
        }

        await this.twoFactorService.disable(userId);
    }

    /** Second step of a two-factor login — exchanges the short-lived token from signin() plus a TOTP or recovery code for a session. */
    async loginWithTwoFactor(
        twoFactorToken: string,
        code: string | undefined,
        recoveryCode: string | undefined,
        context: LoginContext,
        explicitDevice?: { deviceType?: string; deviceName?: string },
    ) {
        const userId = this.tokensService.verifyTwoFactorToken(twoFactorToken);
        const user = await this.usersService.findById(userId);
        if (!user || user.deletedAt || user.status !== UserStatus.ACTIVE) {
            throw new UnauthorizedException("This account is not available");
        }

        if (user.lockedUntil && user.lockedUntil > new Date()) {
            throw new UnauthorizedException("Account temporarily locked due to too many failed attempts");
        }

        const verified = recoveryCode
            ? await this.twoFactorService.verifyRecoveryCode(user.id, recoveryCode)
            : await this.twoFactorService.verifyCode(user.id, code!);

        if (!verified) {
            // Six digits is a small enough space that IP-based throttling alone
            // leaves it brute-forceable from a spread of addresses; the account
            // itself has to lock, exactly as it does for a wrong password.
            await this.usersService.recordFailedLogin(
                user.id,
                this.configService.get("LOGIN_MAX_ATTEMPTS", { infer: true }),
                this.configService.get("LOGIN_LOCKOUT_MINUTES", { infer: true }),
            );
            throw new UnauthorizedException("Invalid two-factor code");
        }

        await this.usersService.resetFailedLogin(user.id);

        return this.issueSession(user, context, explicitDevice);
    }

    /**
     * Spends roughly what a real password check spends, so the time taken cannot
     * be used to tell a registered address from an unregistered one. The hash is
     * built once and reused; its plaintext is discarded, so nothing can match it.
     */
    private async burnPasswordComparison(candidate: string): Promise<void> {
        this.decoyPasswordHash ??= argon2.hash(randomUUID());

        try {
            await argon2.verify(await this.decoyPasswordHash, candidate);
        } catch {
            // A malformed candidate is not interesting here; the cost has been paid.
        }
    }

    /**
     * Whether an account may still be acted on through an emailed code. Suspended
     * and soft-deleted accounts are excluded: the verification and password-reset
     * flows both end in a signed-in session, so letting either run would hand back
     * access that was deliberately taken away.
     */
    /**
     * Undoes a deletion the owner asked for. Deliberately issues no session: the
     * code proves control of the mailbox and nothing more, so an account with a
     * password or 2FA still has to clear those on the next sign-in.
     */
    async reactivateAccount(email: string, code: string): Promise<void> {
        const user = await this.usersService.findByEmail(email);
        if (
            !user ||
            !user.deletedAt ||
            user.status === UserStatus.SUSPENDED ||
            !(await this.emailTokensService.consume(user.id, EmailTokenType.REACTIVATE_ACCOUNT, code))
        ) {
            // One error for every cause, so a suspended account cannot tell its
            // suspension apart from a wrong code.
            throw new BadRequestException("Invalid or expired reactivation code");
        }

        await this.usersService.restore(user.id);
        // The guard caches `isDeleted`, so the stale copy has to go or the
        // restored account keeps being refused until the TTL runs out.
        await this.permissionsService.invalidateCache(user.id);
    }

    /**
     * Ends the request for an account still inside its deletion grace period:
     * mails the code that undoes the deletion and answers with a machine-readable
     * marker, so a client can route to the reactivation screen instead of showing
     * a 409 the user has no way to act on.
     *
     * Every caller reaches here having already established the caller is the
     * owner (correct password, verified Google identity) or that the address is
     * unusable anyway (signup) — so this never reveals anything new.
     */
    private async offerReactivation(userId: string, email: string, deletedAt: Date): Promise<never> {
        const graceDays = this.configService.get("DELETED_USER_GRACE_DAYS", { infer: true });
        const graceEndsAt = new Date(deletedAt.getTime() + graceDays * 24 * 60 * 60 * 1000);

        const code = await this.emailTokensService.issueReactivateAccountToken(userId);
        if (code) {
            await this.emailSender.sendReactivateAccount({ to: email, code, graceEndsAt });
        }

        throw new ConflictException({
            code: "ACCOUNT_PENDING_DELETION",
            message: "This account is scheduled for deletion — check your email for a code to reactivate it",
            graceEndsAt: graceEndsAt.toISOString(),
        });
    }

    private isReachableAccount(user: Pick<UserWithRoles, "status" | "deletedAt">): boolean {
        return !user.deletedAt && user.status !== UserStatus.SUSPENDED;
    }

    private async sendVerificationEmail(userId: string, email: string): Promise<void> {
        const code = await this.emailTokensService.issueVerifyEmailToken(userId);
        if (code) {
            await this.emailSender.sendVerifyEmail({ to: email, code });
        }
    }

    /**
     * Stamps the user's current version markers into the access token. The guard
     * compares them on every request, so any later role change or session kill
     * invalidates this token immediately instead of at expiry.
     */
    private async issueSession(
        user: Pick<UserWithRoles, "id" | "email" | "permVersion" | "tokenVersion">,
        context: LoginContext,
        explicitDevice?: { deviceType?: string; deviceName?: string },
        familyId?: string,
    ) {
        const device = resolveDeviceInfo(context.userAgent, explicitDevice);
        // The refresh token goes first because it decides the family id, and the
        // access token has to carry that id to know which session it belongs to.
        const { token: refreshToken, familyId: sessionId } = await this.tokensService.issueRefreshToken(
            user.id,
            {
                userAgent: context.userAgent,
                ipAddress: context.ipAddress,
                device,
            },
            familyId,
        );
        const accessToken = this.tokensService.signAccessToken({
            sub: user.id,
            email: user.email,
            permVersion: user.permVersion,
            tokenVersion: user.tokenVersion,
            sessionId,
        });

        return { accessToken, refreshToken };
    }
}
