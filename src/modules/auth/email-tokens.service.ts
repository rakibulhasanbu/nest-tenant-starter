import { Injectable } from "@nestjs/common";
import { ConfigService } from "@nestjs/config";
import { generateOtpCode, hashToken } from "@/common/utils/token.util.js";
import type { Env } from "@/config/env.schema.js";
import { InjectDrizzle } from "@nestjs/drizzle";
import { and, eq, lt, sql } from "drizzle-orm";
import type { Database } from "@/database/database.type.js";
import { emailTokens } from "@/database/schema/auth.js";
import { EmailTokenType } from "@/database/schema/enums.js";

const MAX_ATTEMPTS = 5;
const RESEND_COOLDOWN_MS = 60 * 1000;

@Injectable()
export class EmailTokensService {
    constructor(
        @InjectDrizzle() private readonly db: Database,
        private readonly configService: ConfigService<Env, true>,
    ) {}

    /** Returns null (no code issued/sent) while a still-valid code is within its resend cooldown. */
    async issueVerifyEmailToken(userId: string): Promise<string | null> {
        const ttlMinutes = this.configService.get("EMAIL_VERIFICATION_TTL_MINUTES", { infer: true });
        return this.issue(userId, EmailTokenType.VERIFY_EMAIL, ttlMinutes * 60 * 1000);
    }

    /** Returns null (no code issued/sent) while a still-valid code is within its resend cooldown. */
    async issueResetPasswordToken(userId: string): Promise<string | null> {
        const ttlMinutes = this.configService.get("PASSWORD_RESET_TTL_MINUTES", { infer: true });
        return this.issue(userId, EmailTokenType.RESET_PASSWORD, ttlMinutes * 60 * 1000);
    }

    /** Returns null (no code issued/sent) while a still-valid code is within its resend cooldown. */
    async issueDeleteAccountToken(userId: string): Promise<string | null> {
        const ttlMinutes = this.configService.get("DELETE_ACCOUNT_OTP_TTL_MINUTES", { infer: true });
        return this.issue(userId, EmailTokenType.DELETE_ACCOUNT, ttlMinutes * 60 * 1000);
    }

    /** Returns null (no code issued/sent) while a still-valid code is within its resend cooldown. */
    async issueReactivateAccountToken(userId: string): Promise<string | null> {
        const ttlMinutes = this.configService.get("REACTIVATE_ACCOUNT_OTP_TTL_MINUTES", { infer: true });
        return this.issue(userId, EmailTokenType.REACTIVATE_ACCOUNT, ttlMinutes * 60 * 1000);
    }

    /** Owner invites live for days, not minutes: the recipient may not open the mail right away. Returns null while a still-valid code is within its resend cooldown. */
    async issueInviteToken(userId: string): Promise<{ code: string; expiresAt: Date } | null> {
        const ttlDays = this.configService.get("TENANT_INVITE_TTL_DAYS", { infer: true });
        const ttlMs = ttlDays * 24 * 60 * 60 * 1000;
        const code = await this.issue(userId, EmailTokenType.INVITE, ttlMs);
        return code ? { code, expiresAt: new Date(Date.now() + ttlMs) } : null;
    }

    /** Checks the code for this user+type, tracks failed attempts, and marks it used on success. */
    async consume(userId: string, type: EmailTokenType, code: string): Promise<boolean> {
        const record = await this.find(userId, type);

        if (!record || record.usedAt || record.expiresAt < new Date() || record.attempts >= MAX_ATTEMPTS) {
            return false;
        }

        if (record.codeHash !== hashToken(code)) {
            await this.db
                .update(emailTokens)
                .set({ attempts: sql`${emailTokens.attempts} + 1` })
                .where(eq(emailTokens.id, record.id));
            return false;
        }

        await this.db.update(emailTokens).set({ usedAt: new Date() }).where(eq(emailTokens.id, record.id));

        return true;
    }

    /** Removes codes that can no longer be redeemed; returns how many were deleted. */
    async purgeExpired(): Promise<number> {
        const deleted = await this.db
            .delete(emailTokens)
            .where(lt(emailTokens.expiresAt, new Date()))
            .returning({ id: emailTokens.id });

        return deleted.length;
    }

    private async issue(userId: string, type: EmailTokenType, ttlMs: number): Promise<string | null> {
        const existing = await this.find(userId, type);
        const isActiveAndFresh =
            existing &&
            !existing.usedAt &&
            existing.expiresAt > new Date() &&
            existing.createdAt.getTime() > Date.now() - RESEND_COOLDOWN_MS;
        if (isActiveAndFresh) {
            return null;
        }

        const { code, codeHash } = generateOtpCode();
        const expiresAt = new Date(Date.now() + ttlMs);

        await this.db
            .insert(emailTokens)
            .values({ userId, type, codeHash, expiresAt })
            .onConflictDoUpdate({
                target: [emailTokens.userId, emailTokens.type],
                set: { codeHash, expiresAt, usedAt: null, attempts: 0 },
            });

        return code;
    }

    private async find(userId: string, type: EmailTokenType) {
        const [token] = await this.db
            .select()
            .from(emailTokens)
            .where(and(eq(emailTokens.userId, userId), eq(emailTokens.type, type)))
            .limit(1);

        return token;
    }
}
