import { Injectable, UnauthorizedException } from "@nestjs/common";
import { ConfigService } from "@nestjs/config";
import { JwtService } from "@nestjs/jwt";
import ms from "ms";
import { randomUUID } from "node:crypto";
import { generateOpaqueToken, hashToken } from "@/common/utils/token.util.js";
import type { DeviceInfo } from "@/common/utils/device.util.js";
import type { Env } from "@/config/env.schema.js";
import { InjectDrizzle } from "@nestjs/drizzle";
import { and, eq, gt, isNotNull, isNull, lt, or } from "drizzle-orm";
import type { Database } from "@/database/database.type.js";
import { exchangeCodes, refreshTokens, type RefreshToken } from "@/database/schema/auth.js";
import type { User } from "@/database/schema/users.js";

/**
 * Deliberately carries no roles or permissions — only identity, the tenant the
 * session is for, and two version markers the guard re-validates on every
 * request. Authorization data baked into a token cannot be revoked before it
 * expires; a version number can.
 */
export interface AccessTokenPayload {
    sub: string;
    email: string;
    /**
     * The tenant this session acts in — the *only* tenant authority the guard trusts.
     * `null` marks a platform (super admin) session.
     */
    tenantId: string | null;
    /** Snapshot of the membership's permVersion at issue time (0 for platform sessions). Stale value ⇒ access changed. */
    permVersion: number;
    /** Snapshot of User.tokenVersion at issue time. Stale value ⇒ the session was killed. */
    tokenVersion: number;
    /**
     * The refresh-token family this access token belongs to — i.e. which login
     * it came from. It survives rotation, so it is the only stable handle a
     * caller has on its own session; `GET /auth/sessions` uses it to mark the
     * row the caller is sitting on.
     *
     * Not a credential: the opaque refresh token is what proves anything, and
     * revoking a family still requires being signed in as its owner.
     *
     * Optional because access tokens minted before this existed are still valid
     * until they expire; treat `undefined` as "cannot tell which session".
     */
    sessionId?: string;
}

export interface IssuedTokenPair {
    accessToken: string;
    refreshToken: string;
}

export interface IssuedRefreshToken {
    token: string;
    /** Pass back into issueRefreshToken on the next rotation to keep the chain intact. */
    familyId: string;
}

/**
 * Outcome of presenting a refresh token.
 *
 * `reused` is the interesting one: the token was real but had already been
 * rotated away. Either it leaked or a client replayed it, and neither case can
 * be told apart from the other — so the whole rotation chain is dropped.
 */
export type RefreshTokenConsumption =
    { outcome: "valid"; record: RefreshTokenWithUser } | { outcome: "reused"; userId: string } | { outcome: "invalid" };

type RefreshTokenWithUser = RefreshToken & { user: User };

@Injectable()
export class TokensService {
    constructor(
        private readonly jwtService: JwtService,
        private readonly configService: ConfigService<Env, true>,
        @InjectDrizzle() private readonly db: Database,
    ) {}

    signAccessToken(payload: AccessTokenPayload): string {
        return this.jwtService.sign(payload, {
            secret: this.configService.get("JWT_ACCESS_SECRET", { infer: true }),
            expiresIn: this.configService.get("JWT_ACCESS_TTL", { infer: true }),
        });
    }

    /** Omitting `familyId` starts a new chain — i.e. a fresh login rather than a rotation. */
    async issueRefreshToken(
        userId: string,
        tenantId: string | null,
        context: { userAgent?: string; ipAddress?: string; device: DeviceInfo },
        familyId?: string,
    ): Promise<IssuedRefreshToken> {
        const { token, tokenHash } = generateOpaqueToken();
        const ttlMs = ms(this.configService.get("JWT_REFRESH_TTL", { infer: true }) as ms.StringValue);
        const family = familyId ?? randomUUID();

        await this.db.insert(refreshTokens).values({
            userId,
            tenantId,
            tokenHash,
            familyId: family,
            userAgent: context.userAgent,
            ipAddress: context.ipAddress,
            deviceType: context.device.deviceType,
            deviceName: context.device.deviceName,
            expiresAt: new Date(Date.now() + ttlMs),
        });

        return { token, familyId: family };
    }

    /**
     * Validates a refresh token and revokes it — call issueRefreshToken again with
     * the returned familyId to rotate.
     *
     * Rotation alone is not enough to make a stolen token harmless: whoever
     * refreshes second simply fails, which means a thief who gets there first
     * silently takes over the session and the real user is the one logged out.
     * Recognising the already-spent token is what turns that round the right way.
     */
    async consumeRefreshToken(rawToken: string): Promise<RefreshTokenConsumption> {
        const tokenHash = hashToken(rawToken);

        const record = await this.db.query.refreshTokens.findFirst({
            where: { tokenHash },
            with: { user: true },
        });

        if (!record) {
            return { outcome: "invalid" };
        }

        if (record.revokedAt) {
            await this.revokeFamily(record.familyId);
            return { outcome: "reused", userId: record.userId };
        }

        if (record.expiresAt < new Date()) {
            return { outcome: "invalid" };
        }

        // Claim the token atomically. Losing this race means a concurrent request
        // just spent it — a client double-tapping refresh, not a leak, so the
        // family is left alone.
        const claimed = await this.db
            .update(refreshTokens)
            .set({ revokedAt: new Date(), lastUsedAt: new Date() })
            .where(and(eq(refreshTokens.id, record.id), isNull(refreshTokens.revokedAt)))
            .returning({ id: refreshTokens.id });

        return claimed.length === 0 ? { outcome: "invalid" } : { outcome: "valid", record };
    }

    /** Reads a live refresh token's tenant without spending it (see AuthService.refresh). */
    async peekRefreshToken(rawToken: string): Promise<{ tenantId: string | null } | null> {
        const record = await this.db.query.refreshTokens.findFirst({
            where: { tokenHash: hashToken(rawToken), revokedAt: { isNull: true }, expiresAt: { gt: new Date() } },
            columns: { tenantId: true },
        });
        return record ?? null;
    }

    /** Drops an entire rotation chain — every token descended from one login. */
    async revokeFamily(familyId: string): Promise<void> {
        await this.db
            .update(refreshTokens)
            .set({ revokedAt: new Date() })
            .where(and(eq(refreshTokens.familyId, familyId), isNull(refreshTokens.revokedAt)));
    }

    async revokeRefreshToken(rawToken: string): Promise<void> {
        const tokenHash = hashToken(rawToken);
        await this.db
            .update(refreshTokens)
            .set({ revokedAt: new Date() })
            .where(and(eq(refreshTokens.tokenHash, tokenHash), isNull(refreshTokens.revokedAt)));
    }

    /** Revokes every session of the user, or only those in one tenant when `tenantId` is given. */
    async revokeAllRefreshTokens(userId: string, tenantId?: string): Promise<void> {
        await this.db
            .update(refreshTokens)
            .set({ revokedAt: new Date() })
            .where(
                and(
                    eq(refreshTokens.userId, userId),
                    tenantId ? eq(refreshTokens.tenantId, tenantId) : undefined,
                    isNull(refreshTokens.revokedAt),
                ),
            );
    }

    /** A user's live sessions across every tenant, or only one tenant's when `tenantId` is given. */
    listActiveSessions(userId: string, tenantId?: string) {
        return this.db.query.refreshTokens.findMany({
            where: {
                userId,
                ...(tenantId ? { tenantId } : {}),
                revokedAt: { isNull: true },
                expiresAt: { gt: new Date() },
            },
            orderBy: { lastUsedAt: "desc" },
        });
    }

    async revokeSessionById(userId: string, sessionId: string, tenantId?: string): Promise<void> {
        await this.db
            .update(refreshTokens)
            .set({ revokedAt: new Date() })
            .where(
                and(
                    eq(refreshTokens.id, sessionId),
                    eq(refreshTokens.userId, userId),
                    tenantId ? eq(refreshTokens.tenantId, tenantId) : undefined,
                    isNull(refreshTokens.revokedAt),
                ),
            );
    }

    /**
     * One-time code that lets a user already signed in on one tenant host start a
     * session on another (each subdomain is a separate origin). Only the hash is
     * stored; it is spent on first use.
     */
    async issueExchangeCode(userId: string, tenantId: string): Promise<string> {
        const { token, tokenHash } = generateOpaqueToken();
        const ttlSeconds = this.configService.get("TENANT_EXCHANGE_TTL_SECONDS", { infer: true });

        await this.db.insert(exchangeCodes).values({
            userId,
            tenantId,
            codeHash: tokenHash,
            expiresAt: new Date(Date.now() + ttlSeconds * 1000),
        });

        return token;
    }

    /** Reads an exchange code's tenant without spending it, so a wrong-host attempt cannot burn a valid code. */
    async peekExchangeCode(code: string): Promise<{ userId: string; tenantId: string } | null> {
        const found = await this.db.query.exchangeCodes.findFirst({
            where: { codeHash: hashToken(code), usedAt: { isNull: true }, expiresAt: { gt: new Date() } },
            columns: { userId: true, tenantId: true },
        });
        return found ?? null;
    }

    async consumeExchangeCode(code: string): Promise<{ userId: string; tenantId: string } | null> {
        const [claimed] = await this.db
            .update(exchangeCodes)
            .set({ usedAt: new Date() })
            .where(
                and(
                    eq(exchangeCodes.codeHash, hashToken(code)),
                    isNull(exchangeCodes.usedAt),
                    gt(exchangeCodes.expiresAt, new Date()),
                ),
            )
            .returning({ userId: exchangeCodes.userId, tenantId: exchangeCodes.tenantId });

        return claimed ?? null;
    }

    /** Short-lived token proving a password check passed while the user still has to pick one of several tenants. */
    signTenantSelectionToken(userId: string): string {
        return this.jwtService.sign(
            { sub: userId, purpose: "tenant-select" },
            {
                secret: this.configService.get("JWT_ACCESS_SECRET", { infer: true }),
                expiresIn: this.configService.get("TENANT_SELECTION_TTL", { infer: true }),
            },
        );
    }

    verifyTenantSelectionToken(token: string): string {
        try {
            const payload = this.jwtService.verify<{ sub: string; purpose: string }>(token, {
                secret: this.configService.get("JWT_ACCESS_SECRET", { infer: true }),
            });
            if (payload.purpose !== "tenant-select") {
                throw new UnauthorizedException("Invalid tenant selection token");
            }
            return payload.sub;
        } catch {
            throw new UnauthorizedException("Invalid or expired tenant selection token");
        }
    }

    /** Short-lived token proving a password check passed, so a 2FA code can be requested next without re-authenticating. */
    signTwoFactorToken(userId: string): string {
        return this.jwtService.sign(
            { sub: userId, purpose: "2fa" },
            {
                secret: this.configService.get("JWT_ACCESS_SECRET", { infer: true }),
                expiresIn: this.configService.get("TWO_FACTOR_LOGIN_TTL", { infer: true }),
            },
        );
    }

    /** Removes spent and long-expired rows; returns how many were deleted. */
    async purgeExpired(revokedRetentionDays: number): Promise<number> {
        const revokedCutoff = new Date(Date.now() - revokedRetentionDays * 24 * 60 * 60 * 1000);

        const deleted = await this.db
            .delete(refreshTokens)
            .where(or(lt(refreshTokens.expiresAt, new Date()), lt(refreshTokens.revokedAt, revokedCutoff)))
            .returning({ id: refreshTokens.id });
        const spentCodes = await this.db
            .delete(exchangeCodes)
            .where(or(lt(exchangeCodes.expiresAt, new Date()), isNotNull(exchangeCodes.usedAt)))
            .returning({ id: exchangeCodes.id });

        return deleted.length + spentCodes.length;
    }

    verifyTwoFactorToken(token: string): string {
        try {
            const payload = this.jwtService.verify<{ sub: string; purpose: string }>(token, {
                secret: this.configService.get("JWT_ACCESS_SECRET", { infer: true }),
            });
            if (payload.purpose !== "2fa") {
                throw new UnauthorizedException("Invalid two-factor token");
            }
            return payload.sub;
        } catch {
            throw new UnauthorizedException("Invalid or expired two-factor token");
        }
    }
}
