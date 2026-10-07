import {
    BadRequestException,
    ConflictException,
    ForbiddenException,
    HttpException,
    HttpStatus,
    Inject,
    Injectable,
    NotFoundException,
    UnauthorizedException,
} from "@nestjs/common";
import { ConfigService } from "@nestjs/config";
import * as argon2 from "argon2";
import { randomUUID } from "node:crypto";
import { assertTenantUsable } from "@/common/tenant/tenant-state.util.js";
import type { HostContext } from "@/common/types/host-context.type.js";
import { ROLE_SLUGS } from "@/common/authorization/role-templates.constant.js";
import { resolveDeviceInfo } from "@/common/utils/device.util.js";
import type { Env } from "@/config/env.schema.js";
import { AuthProvider, EmailTokenType, MembershipStatus, TenantStatus, UserStatus } from "@/database/schema/enums.js";
import type { Tenant } from "@/database/schema/tenants.js";
import { EMAIL_SENDER, type EmailSender } from "@/integrations/email/email-sender.interface.js";
import { EmailTokensService } from "@/modules/auth/email-tokens.service.js";
import { GoogleAuthService } from "@/modules/auth/google-auth.service.js";
import { SocialIdentitiesService } from "@/modules/auth/social-identities.service.js";
import { TwoFactorService } from "@/modules/auth/two-factor.service.js";
import type { SignupInput } from "@/modules/auth/dto/signup.schema.js";
import type { SigninInput } from "@/modules/auth/dto/signin.schema.js";
import { TokensService } from "@/modules/auth/tokens.service.js";
import { UsersService, type UserWithProfile } from "@/modules/users/users.service.js";
import { PermissionsService } from "@/modules/authorization/permissions.service.js";
import { MembershipsService } from "@/modules/tenants/memberships.service.js";
import { TenantsService } from "@/modules/tenants/tenants.service.js";
import { toPublicUser, type PublicUser } from "@/modules/users/users.mapper.js";

/**
 * Which tenant a login is for. The host wins (`acme.example.com`); clients with no
 * subdomain (mobile, the apex site) may name one in the request body instead.
 */
export interface TenantTarget {
    host: HostContext;
    tenantSlug?: string;
}

export interface LoginContext {
    userAgent?: string;
    ipAddress?: string;
    target?: TenantTarget;
}

export interface SessionTenant {
    id: string;
    slug: string;
    name: string;
    url: string;
}

export interface Session {
    accessToken: string;
    refreshToken: string;
    /** The organization this session acts in; `null` for the platform console. */
    tenant: SessionTenant | null;
}

export interface TenantChoice {
    slug: string;
    name: string;
    status: TenantStatus;
    url: string;
}

/** Signin matched several usable organizations: pick one with POST /auth/select-tenant. */
export interface TenantSelectionRequired {
    tenantSelectionRequired: true;
    selectionToken: string;
    tenants: TenantChoice[];
}

export type SessionOutcome = Session | TenantSelectionRequired;

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
        private readonly tenantsService: TenantsService,
        private readonly membershipsService: MembershipsService,
    ) {}

    /** Lazily built once — see burnPasswordComparison. */
    private decoyPasswordHash?: Promise<string>;

    /**
     * Signing up creates the account *and* the organization it owns. The slug is
     * validated first so a taken subdomain fails before any account exists.
     */
    async signup(input: SignupInput): Promise<{ user: PublicUser; tenant: SessionTenant & { status: TenantStatus } }> {
        await this.tenantsService.assertSelfSignupAllowed();

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

        await this.tenantsService.assertSlugAvailable(input.tenantSlug);

        const passwordHash = await argon2.hash(input.password);
        const user = await this.usersService.createUser({
            email: input.email,
            passwordHash,
            name: input.name,
            phone: input.phone,
        });

        const tenant = await this.tenantsService.createForOwner(user.id, {
            name: input.tenantName,
            slug: input.tenantSlug,
        });

        await this.sendVerificationEmail(user.id, user.email);

        return {
            user: toPublicUser(user, [ROLE_SLUGS.OWNER, ROLE_SLUGS.USER]),
            tenant: { ...this.toSessionTenant(tenant), status: tenant.status },
        };
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

        return this.startSession(user, context, { deviceType: input.deviceType, deviceName: input.deviceName });
    }

    async refresh(
        rawRefreshToken: string,
        context: LoginContext,
        explicitDevice?: { deviceType?: string; deviceName?: string },
    ) {
        // Host first, token second: a refresh sent to the wrong tenant's host must be
        // refused *without* spending the token, or one misrouted request would end
        // the user's session.
        const live = await this.tokensService.peekRefreshToken(rawRefreshToken);
        if (live) {
            this.assertRefreshHost(context, live.tenantId);
        }

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

        this.assertRefreshHost(context, record.tenantId);

        if (record.tenantId === null) {
            if (!(await this.permissionsService.resolvePlatform(record.user.id))) {
                throw new UnauthorizedException("Invalid or expired refresh token");
            }
            // Same family: this is a rotation of an existing login, not a new one.
            return this.issuePlatformSession(record.user, context, explicitDevice, record.familyId);
        }

        const tenant = await this.tenantsService.findById(record.tenantId);
        if (!tenant) {
            throw new UnauthorizedException("Invalid or expired refresh token");
        }

        return this.issueTenantSession(record.user, tenant, context, explicitDevice, record.familyId);
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
        return this.startSession(verified, context, explicitDevice);
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
        return this.redeemPasswordCode(
            EmailTokenType.RESET_PASSWORD,
            "Invalid or expired reset code",
            email,
            code,
            newPassword,
            context,
            explicitDevice,
        );
    }

    /** Completes a tenant-owner invite: the emailed code proves the address, the new password is their first. Signs them in. */
    async acceptInvite(
        email: string,
        code: string,
        newPassword: string,
        context: LoginContext,
        explicitDevice?: { deviceType?: string; deviceName?: string },
    ) {
        return this.redeemPasswordCode(
            EmailTokenType.INVITE,
            "Invalid or expired invitation code",
            email,
            code,
            newPassword,
            context,
            explicitDevice,
        );
    }

    private async redeemPasswordCode(
        type: EmailTokenType,
        failureMessage: string,
        email: string,
        code: string,
        newPassword: string,
        context: LoginContext,
        explicitDevice?: { deviceType?: string; deviceName?: string },
    ) {
        const user = await this.usersService.findByEmail(email);
        if (!user || !this.isReachableAccount(user) || !(await this.emailTokensService.consume(user.id, type, code))) {
            // Deliberately the same error as a bad code: a suspended account must
            // not be able to tell its suspension apart from a wrong code.
            throw new BadRequestException(failureMessage);
        }

        const passwordHash = await argon2.hash(newPassword);
        await this.usersService.setPassword(user.id, passwordHash);
        await this.usersService.markEmailVerified(user.id);
        await this.tokensService.revokeAllRefreshTokens(user.id);
        // Refresh tokens are revoked above, but access tokens already in the wild
        // stay signature-valid until they expire — bumping tokenVersion kills those too.
        await this.permissionsService.bumpTokenVersion(user.id);

        const refreshed = await this.usersService.findByIdOrThrow(user.id);
        return this.startSession(refreshed, context, explicitDevice);
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

    /**
     * `newTenant` is only needed the first time: a Google identity that has no
     * account yet becomes one together with the organization it owns.
     */
    async loginWithGoogle(idToken: string, context: LoginContext, newTenant?: { name: string; slug: string }) {
        const profile = await this.googleAuthService.verifyIdToken(idToken);
        if (!profile.emailVerified) {
            throw new UnauthorizedException("Google account email is not verified");
        }

        const identity = await this.socialIdentitiesService.findByProviderAccount(
            AuthProvider.GOOGLE,
            profile.providerAccountId,
        );

        const user = identity ? identity.user : await this.linkOrCreateGoogleUser(profile, newTenant);

        if (user.deletedAt) {
            await this.offerReactivation(user.id, user.email, user.deletedAt);
        }

        if (user.status === UserStatus.SUSPENDED) {
            throw new UnauthorizedException("This account is not available");
        }

        return this.startSession(user, context);
    }

    private async linkOrCreateGoogleUser(
        profile: { providerAccountId: string; email: string; name?: string },
        newTenant?: { name: string; slug: string },
    ) {
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

        // A brand-new Google account would be created together with a tenant.
        await this.tenantsService.assertSelfSignupAllowed();

        if (!newTenant) {
            throw new BadRequestException({
                code: "TENANT_DETAILS_REQUIRED",
                message: "Creating a new account needs an organization name and slug",
            });
        }
        await this.tenantsService.assertSlugAvailable(newTenant.slug);

        const user = await this.usersService.createUser({
            email: profile.email,
            name: profile.name,
            status: UserStatus.ACTIVE,
            emailVerifiedAt: new Date(),
        });
        await this.socialIdentitiesService.link(user.id, AuthProvider.GOOGLE, profile.providerAccountId, profile.email);
        await this.tenantsService.createForOwner(user.id, newTenant);
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
        await this.assertNotSoleOwner(user.id);

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

        await this.assertNotSoleOwner(user.id);

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
     * An organization must always keep an owner, so the last one cannot walk away
     * by deleting their account — ownership has to be handed over first.
     */
    private async assertNotSoleOwner(userId: string): Promise<void> {
        const sole = await this.membershipsService.tenantsWhereSoleOwner(userId);
        if (sole.length > 0) {
            throw new ConflictException({
                code: "SOLE_OWNER",
                message: "Transfer ownership of your organizations before deleting your account",
                tenantIds: sole,
            });
        }
    }

    /**
     * Adds someone to a tenant. A new address gets an account with an unusable
     * placeholder password and an emailed reset code — completing the reset both
     * sets a real password and proves they own the address. An address that
     * already has an account is simply added as a member: identity is global, so
     * there is nothing to create, and they keep their existing credentials.
     */
    async invite(tenantId: string, actorId: string, email: string, roleSlugs: string[]): Promise<PublicUser> {
        const existing = await this.usersService.findByEmail(email);

        if (existing?.deletedAt) {
            throw new ConflictException(
                "This address belongs to an account awaiting deletion — its owner must reactivate it, or the grace period must run out first",
            );
        }

        if (existing) {
            await this.membershipsService.add(tenantId, existing.id, roleSlugs, actorId);
            const member = await this.membershipsService.get(tenantId, existing.id);
            return toPublicUser(existing, member?.roleIds ?? []);
        }

        const placeholderPassword = await argon2.hash(randomUUID());
        const user = await this.usersService.createUser({
            email,
            passwordHash: placeholderPassword,
        });
        await this.membershipsService.add(tenantId, user.id, roleSlugs, actorId);

        const code = await this.emailTokensService.issueResetPasswordToken(user.id);
        if (code) {
            await this.emailSender.sendResetPassword({ to: user.email, code });
        }

        const member = await this.membershipsService.get(tenantId, user.id);
        return toPublicUser(user, member?.roleIds ?? []);
    }

    /**
     * Finds or creates the account that will own a tenant the super admin is
     * about to create. A new address gets an unusable placeholder password until
     * the invite is accepted; `isNew` tells the caller which email to send.
     */
    async prepareTenantOwner(email: string): Promise<{ user: UserWithProfile; isNew: boolean }> {
        const existing = await this.usersService.findByEmail(email);

        if (existing?.deletedAt) {
            throw new ConflictException(
                "This address belongs to an account awaiting deletion — its owner must reactivate it, or the grace period must run out first",
            );
        }
        if (existing) {
            return { user: existing, isNew: false };
        }

        const user = await this.usersService.createUser({ email, passwordHash: await argon2.hash(randomUUID()) });
        return { user, isNew: true };
    }

    /** Emails the owner their invitation code. Throws while the previous one is inside its resend cooldown. */
    async sendTenantOwnerInvite(user: { id: string; email: string }, tenant: Tenant): Promise<void> {
        const issued = await this.emailTokensService.issueInviteToken(user.id);
        if (!issued) {
            throw new HttpException(
                {
                    code: "INVITE_RESEND_COOLDOWN",
                    message: "An invitation was just sent — wait a minute before resending",
                },
                HttpStatus.TOO_MANY_REQUESTS,
            );
        }

        await this.emailSender.sendTenantOwnerInvite({
            to: user.email,
            tenantName: tenant.name,
            url: this.tenantsService.urlFor(tenant.slug),
            code: issued.code,
            expiresAt: issued.expiresAt,
        });
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

        return this.startSession(user, context, explicitDevice);
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

    private isReachableAccount(user: Pick<UserWithProfile, "status" | "deletedAt">): boolean {
        return !user.deletedAt && user.status !== UserStatus.SUSPENDED;
    }

    private async sendVerificationEmail(userId: string, email: string): Promise<void> {
        const code = await this.emailTokensService.issueVerifyEmailToken(userId);
        if (code) {
            await this.emailSender.sendVerifyEmail({ to: email, code });
        }
    }

    /**
     * Decides which organization a freshly authenticated user is signing in to and
     * issues the session for it. The host wins, then an explicit slug; with neither,
     * the user's memberships decide — one usable tenant signs straight in, several
     * return a picker, none returns the reason (pending approval, suspended, ...).
     */
    private async startSession(
        user: Pick<UserWithProfile, "id" | "email" | "tokenVersion">,
        context: LoginContext,
        explicitDevice?: { deviceType?: string; deviceName?: string },
    ): Promise<SessionOutcome> {
        const target = context.target;
        const kind = target?.host.kind ?? "apex";

        if (kind === "platform") {
            // Same message as a wrong password: the platform host must not reveal who the super admin is.
            if (!(await this.permissionsService.resolvePlatform(user.id))) {
                throw new UnauthorizedException("Invalid email or password");
            }
            return this.issuePlatformSession(user, context, explicitDevice);
        }

        const slug = target?.host.tenant?.slug ?? target?.tenantSlug;
        if (slug) {
            const tenant = await this.tenantsService.findBySlug(slug);
            if (!tenant) {
                throw new NotFoundException({ code: "TENANT_NOT_FOUND", message: "Organization not found" });
            }
            try {
                return await this.issueTenantSession(user, tenant, context, explicitDevice);
            } catch (error) {
                // Pending/rejected/suspended: the client shows every organization's state, not just this one's.
                if (error instanceof ForbiddenException && /^(TENANT_|MEMBERSHIP_)/.test(codeOf(error))) {
                    const all = await this.tenantsService.listForUser(user.id);
                    throw new ForbiddenException({
                        ...(error.getResponse() as Record<string, unknown>),
                        tenants: all.map(({ slug, name, status, url }) => ({ slug, name, status, url })),
                    });
                }
                throw error;
            }
        }

        const memberships = await this.tenantsService.listForUser(user.id);
        if (memberships.length === 0) {
            throw new ForbiddenException({
                code: "NO_ORGANIZATION",
                message: "This account does not belong to any organization",
            });
        }

        const usable = memberships.filter(
            tenant => tenant.status === TenantStatus.ACTIVE && tenant.membershipStatus === MembershipStatus.ACTIVE,
        );
        const choices: TenantChoice[] = memberships.map(({ slug, name, status, url }) => ({ slug, name, status, url }));

        if (usable.length === 1) {
            const tenant = await this.tenantsService.findByIdOrThrow(usable[0]!.id);
            return this.issueTenantSession(user, tenant, context, explicitDevice);
        }

        if (usable.length > 1) {
            return {
                tenantSelectionRequired: true,
                selectionToken: this.tokensService.signTenantSelectionToken(user.id),
                tenants: choices,
            };
        }

        // Nothing usable: report the most useful reason, with the list so the client can show every organization's state.
        const reason =
            memberships.find(tenant => tenant.status === TenantStatus.PENDING_APPROVAL) ??
            memberships.find(tenant => tenant.status === TenantStatus.SUSPENDED) ??
            memberships[0]!;
        try {
            assertTenantUsable(reason.status, reason.rejectionReason);
        } catch (error) {
            if (error instanceof ForbiddenException) {
                const body = error.getResponse() as Record<string, unknown>;
                throw new ForbiddenException({ ...body, tenants: choices });
            }
            throw error;
        }
        throw new ForbiddenException({
            code: "MEMBERSHIP_SUSPENDED",
            message: "Your access to this organization has been suspended",
            tenants: choices,
        });
    }

    /**
     * A session belongs to the host it was issued for: refreshing a tenant session
     * on another tenant's subdomain, or a platform session off the platform host,
     * would only hand out a token the guard rejects later.
     */
    private assertRefreshHost(context: LoginContext, tenantId: string | null): void {
        const host = context.target?.host;
        if (!host) {
            return;
        }

        if (tenantId === null) {
            if (host.kind !== "platform") {
                throw new ForbiddenException({
                    code: "PLATFORM_HOST_REQUIRED",
                    message: "Platform sessions can only be used on the platform host",
                });
            }
            return;
        }

        this.assertHostAllows(context, tenantId);
    }

    /** Second step after signin returned a picker: the user names the organization they want. */
    async selectTenant(
        selectionToken: string,
        tenantSlug: string,
        context: LoginContext,
        explicitDevice?: { deviceType?: string; deviceName?: string },
    ): Promise<Session> {
        const userId = this.tokensService.verifyTenantSelectionToken(selectionToken);
        const user = await this.usersService.findById(userId);
        if (!user || user.deletedAt || user.status !== UserStatus.ACTIVE) {
            throw new UnauthorizedException("This account is not available");
        }

        const tenant = await this.tenantsService.findBySlug(tenantSlug);
        if (!tenant) {
            throw new NotFoundException({ code: "TENANT_NOT_FOUND", message: "Organization not found" });
        }
        this.assertHostAllows(context, tenant.id);

        return this.issueTenantSession(user, tenant, context, explicitDevice);
    }

    /**
     * Lets a signed-in user move to another of their organizations without typing
     * a password again. Each tenant host is a separate origin, so instead of a
     * session this hands back a one-time code the target host redeems.
     */
    async createTenantSwitch(userId: string, tenantSlug: string) {
        const tenant = await this.tenantsService.findBySlug(tenantSlug);
        if (!tenant) {
            throw new NotFoundException({ code: "TENANT_NOT_FOUND", message: "Organization not found" });
        }

        const membership = await this.membershipsService.findMembership(tenant.id, userId);
        if (!membership) {
            throw new ForbiddenException({
                code: "NOT_A_MEMBER",
                message: "You are not a member of this organization",
            });
        }
        assertTenantUsable(tenant.status, tenant.rejectionReason);
        this.assertMembershipUsable(membership.status);

        return {
            tenant: this.toSessionTenant(tenant),
            exchangeCode: await this.tokensService.issueExchangeCode(userId, tenant.id),
        };
    }

    /** Redeems a code from {@link createTenantSwitch}. */
    async exchange(
        code: string,
        context: LoginContext,
        explicitDevice?: { deviceType?: string; deviceName?: string },
    ): Promise<Session> {
        // Host check before the code is spent, so a wrong-host attempt cannot burn it.
        const pending = await this.tokensService.peekExchangeCode(code);
        if (!pending) {
            throw new UnauthorizedException("Invalid or expired exchange code");
        }
        this.assertHostAllows(context, pending.tenantId);

        const claimed = await this.tokensService.consumeExchangeCode(code);
        if (!claimed) {
            throw new UnauthorizedException("Invalid or expired exchange code");
        }

        const user = await this.usersService.findById(claimed.userId);
        if (!user || user.deletedAt || user.status !== UserStatus.ACTIVE) {
            throw new UnauthorizedException("This account is not available");
        }

        const tenant = await this.tenantsService.findByIdOrThrow(claimed.tenantId);
        this.assertHostAllows(context, tenant.id);

        return this.issueTenantSession(user, tenant, context, explicitDevice);
    }

    /** A request on a tenant subdomain may only act for that tenant; the platform host acts for none. */
    private assertHostAllows(context: LoginContext, tenantId: string): void {
        const host = context.target?.host;
        if (host?.kind === "platform" || (host?.kind === "tenant" && host.tenant?.id !== tenantId)) {
            throw new ForbiddenException({
                code: "TENANT_MISMATCH",
                message: "This request is for a different organization",
            });
        }
    }

    private assertMembershipUsable(status: MembershipStatus): void {
        if (status === MembershipStatus.SUSPENDED) {
            throw new ForbiddenException({
                code: "MEMBERSHIP_SUSPENDED",
                message: "Your access to this organization has been suspended",
            });
        }
    }

    /**
     * Issues a session for one organization after checking the user may enter it.
     * Stamps the membership's version markers into the access token: the guard
     * compares them on every request, so a later role change or session kill
     * invalidates this token immediately instead of at expiry.
     */
    private async issueTenantSession(
        user: Pick<UserWithProfile, "id" | "email" | "tokenVersion">,
        tenant: Tenant,
        context: LoginContext,
        explicitDevice?: { deviceType?: string; deviceName?: string },
        familyId?: string,
    ): Promise<Session> {
        this.assertHostAllows(context, tenant.id);

        const membership = await this.membershipsService.findMembership(tenant.id, user.id);
        if (!membership) {
            throw new ForbiddenException({
                code: "NOT_A_MEMBER",
                message: "You are not a member of this organization",
            });
        }
        assertTenantUsable(tenant.status, tenant.rejectionReason);
        this.assertMembershipUsable(membership.status);

        const { refreshToken, sessionId } = await this.issueRefreshToken(
            user.id,
            tenant.id,
            context,
            explicitDevice,
            familyId,
        );
        const accessToken = this.tokensService.signAccessToken({
            sub: user.id,
            email: user.email,
            tenantId: tenant.id,
            permVersion: membership.permVersion,
            tokenVersion: user.tokenVersion,
            sessionId,
        });

        return { accessToken, refreshToken, tenant: this.toSessionTenant(tenant) };
    }

    private async issuePlatformSession(
        user: Pick<UserWithProfile, "id" | "email" | "tokenVersion">,
        context: LoginContext,
        explicitDevice?: { deviceType?: string; deviceName?: string },
        familyId?: string,
    ): Promise<Session> {
        const { refreshToken, sessionId } = await this.issueRefreshToken(
            user.id,
            null,
            context,
            explicitDevice,
            familyId,
        );
        const accessToken = this.tokensService.signAccessToken({
            sub: user.id,
            email: user.email,
            tenantId: null,
            permVersion: 0,
            tokenVersion: user.tokenVersion,
            sessionId,
        });

        return { accessToken, refreshToken, tenant: null };
    }

    /**
     * The refresh token goes first because it decides the family id, and the
     * access token has to carry that id to know which session it belongs to.
     */
    private async issueRefreshToken(
        userId: string,
        tenantId: string | null,
        context: LoginContext,
        explicitDevice?: { deviceType?: string; deviceName?: string },
        familyId?: string,
    ) {
        const device = resolveDeviceInfo(context.userAgent, explicitDevice);
        const { token, familyId: sessionId } = await this.tokensService.issueRefreshToken(
            userId,
            tenantId,
            { userAgent: context.userAgent, ipAddress: context.ipAddress, device },
            familyId,
        );

        return { refreshToken: token, sessionId };
    }

    private toSessionTenant(tenant: Pick<Tenant, "id" | "slug" | "name">): SessionTenant {
        return { id: tenant.id, slug: tenant.slug, name: tenant.name, url: this.tenantsService.urlFor(tenant.slug) };
    }
}

function codeOf(error: ForbiddenException): string {
    const body = error.getResponse();
    return typeof body === "object" && body !== null ? String((body as { code?: string }).code ?? "") : "";
}
