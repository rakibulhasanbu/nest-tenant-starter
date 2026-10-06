import { BadRequestException, Injectable, NotFoundException } from "@nestjs/common";
import { ConfigService } from "@nestjs/config";
import { generateSecret, generateURI, verifySync } from "otplib";
import * as QRCode from "qrcode";
import { decrypt, encrypt } from "@/common/utils/encryption.util.js";
import { generateRecoveryCodes, hashToken } from "@/common/utils/token.util.js";
import type { Env } from "@/config/env.schema.js";
import { InjectDrizzle } from "@nestjs/drizzle";
import { and, eq, isNull, lt, or } from "drizzle-orm";
import type { Database } from "@/database/database.type.js";
import { users } from "@/database/schema/users.js";

@Injectable()
export class TwoFactorService {
    constructor(
        @InjectDrizzle() private readonly db: Database,
        private readonly configService: ConfigService<Env, true>,
    ) {}

    /**
     * Generates a new secret and stores it until confirmed via enable(). Only
     * reachable while 2FA is off (the caller enforces that), and deliberately
     * never writes `twoFactorEnabled` — flipping it off here would be a way to
     * drop 2FA without the password and live code that disable() requires.
     */
    async setup(userId: string, email: string): Promise<{ otpauthUrl: string; qrCodeDataUrl: string }> {
        const secret = generateSecret();
        const otpauthUrl = generateURI({
            issuer: this.configService.get("TWO_FACTOR_APP_NAME", { infer: true }),
            label: email,
            secret,
        });

        await this.db
            .update(users)
            .set({ twoFactorSecret: encrypt(secret, this.getEncryptionKey()) })
            .where(eq(users.id, userId));

        const qrCodeDataUrl = await QRCode.toDataURL(otpauthUrl);
        return { otpauthUrl, qrCodeDataUrl };
    }

    /** Confirms the pending secret with a live code, turns 2FA on, and issues recovery codes (shown once). */
    async enable(userId: string, code: string): Promise<{ recoveryCodes: string[] }> {
        const user = await this.findUserOrThrow(userId);
        if (!user.twoFactorSecret) {
            throw new BadRequestException("Call the 2FA setup endpoint first");
        }

        const secret = decrypt(user.twoFactorSecret, this.getEncryptionKey());
        if (!verifySync({ token: code, secret }).valid) {
            throw new BadRequestException("Invalid authenticator code");
        }

        const recoveryCodes = generateRecoveryCodes();
        await this.db
            .update(users)
            .set({
                twoFactorEnabled: true,
                twoFactorRecoveryCodes: recoveryCodes.map(hashToken),
                // Spend the enrolling code too, so it cannot immediately be replayed at login.
                twoFactorLastUsedStep: currentTimeStep(),
            })
            .where(eq(users.id, userId));

        return { recoveryCodes };
    }

    async disable(userId: string): Promise<void> {
        await this.db
            .update(users)
            .set({ twoFactorEnabled: false, twoFactorSecret: null, twoFactorRecoveryCodes: [] })
            .where(eq(users.id, userId));
    }

    /**
     * A TOTP code is valid for its whole 30-second step, so verifying it alone
     * lets anyone who observes one use it again within that window. Each accepted
     * step is recorded and never accepted twice — the conditional update also
     * makes two simultaneous attempts with the same code resolve to one winner.
     */
    async verifyCode(userId: string, code: string): Promise<boolean> {
        const user = await this.findUserOrThrow(userId);
        if (!user.twoFactorSecret) {
            return false;
        }

        const secret = decrypt(user.twoFactorSecret, this.getEncryptionKey());
        if (!verifySync({ token: code, secret }).valid) {
            return false;
        }

        const step = currentTimeStep();
        const accepted = await this.db
            .update(users)
            .set({ twoFactorLastUsedStep: step })
            .where(
                and(
                    eq(users.id, userId),
                    or(isNull(users.twoFactorLastUsedStep), lt(users.twoFactorLastUsedStep, step)),
                ),
            )
            .returning({ id: users.id });

        return accepted.length > 0;
    }

    /** One-time use — the matched code is removed from the stored set on success. */
    async verifyRecoveryCode(userId: string, code: string): Promise<boolean> {
        const user = await this.findUserOrThrow(userId);
        const hash = hashToken(code.toUpperCase());
        if (!user.twoFactorRecoveryCodes.includes(hash)) {
            return false;
        }

        await this.db
            .update(users)
            .set({ twoFactorRecoveryCodes: user.twoFactorRecoveryCodes.filter(stored => stored !== hash) })
            .where(eq(users.id, userId));

        return true;
    }

    private async findUserOrThrow(userId: string) {
        const [user] = await this.db.select().from(users).where(eq(users.id, userId)).limit(1);

        if (!user) {
            throw new NotFoundException("User not found");
        }

        return user;
    }

    private getEncryptionKey(): string {
        return this.configService.get("TWO_FACTOR_ENCRYPTION_KEY", { infer: true });
    }
}

/** otplib default TOTP period. */
const TOTP_STEP_SECONDS = 30;

/** The time-step a TOTP code belongs to — the unit otplib validates against. */
function currentTimeStep(): number {
    return Math.floor(Date.now() / 1000 / TOTP_STEP_SECONDS);
}
