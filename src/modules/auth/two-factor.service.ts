import { BadRequestException, Injectable } from "@nestjs/common";
import { ConfigService } from "@nestjs/config";
import { generateSecret, generateURI, verifySync } from "otplib";
import * as QRCode from "qrcode";
import { decrypt, encrypt } from "@/common/utils/encryption.util.js";
import { generateRecoveryCodes, hashToken } from "@/common/utils/token.util.js";
import type { Env } from "@/config/env.schema.js";
import { PrismaService } from "@/database/prisma.service.js";

@Injectable()
export class TwoFactorService {
    constructor(
        private readonly prisma: PrismaService,
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

        await this.prisma.user.update({
            where: { id: userId },
            data: { twoFactorSecret: encrypt(secret, this.getEncryptionKey()) },
        });

        const qrCodeDataUrl = await QRCode.toDataURL(otpauthUrl);
        return { otpauthUrl, qrCodeDataUrl };
    }

    /** Confirms the pending secret with a live code, turns 2FA on, and issues recovery codes (shown once). */
    async enable(userId: string, code: string): Promise<{ recoveryCodes: string[] }> {
        const user = await this.prisma.user.findUniqueOrThrow({ where: { id: userId } });
        if (!user.twoFactorSecret) {
            throw new BadRequestException("Call the 2FA setup endpoint first");
        }

        const secret = decrypt(user.twoFactorSecret, this.getEncryptionKey());
        if (!verifySync({ token: code, secret }).valid) {
            throw new BadRequestException("Invalid authenticator code");
        }

        const recoveryCodes = generateRecoveryCodes();
        await this.prisma.user.update({
            where: { id: userId },
            data: {
                twoFactorEnabled: true,
                twoFactorRecoveryCodes: recoveryCodes.map(hashToken),
                // Spend the enrolling code too, so it cannot immediately be replayed at login.
                twoFactorLastUsedStep: currentTimeStep(),
            },
        });

        return { recoveryCodes };
    }

    async disable(userId: string): Promise<void> {
        await this.prisma.user.update({
            where: { id: userId },
            data: { twoFactorEnabled: false, twoFactorSecret: null, twoFactorRecoveryCodes: [] },
        });
    }

    /**
     * A TOTP code is valid for its whole 30-second step, so verifying it alone
     * lets anyone who observes one use it again within that window. Each accepted
     * step is recorded and never accepted twice — the conditional update also
     * makes two simultaneous attempts with the same code resolve to one winner.
     */
    async verifyCode(userId: string, code: string): Promise<boolean> {
        const user = await this.prisma.user.findUniqueOrThrow({ where: { id: userId } });
        if (!user.twoFactorSecret) {
            return false;
        }

        const secret = decrypt(user.twoFactorSecret, this.getEncryptionKey());
        if (!verifySync({ token: code, secret }).valid) {
            return false;
        }

        const step = currentTimeStep();
        const { count } = await this.prisma.user.updateMany({
            where: {
                id: userId,
                OR: [{ twoFactorLastUsedStep: null }, { twoFactorLastUsedStep: { lt: step } }],
            },
            data: { twoFactorLastUsedStep: step },
        });

        return count > 0;
    }

    /** One-time use — the matched code is removed from the stored set on success. */
    async verifyRecoveryCode(userId: string, code: string): Promise<boolean> {
        const user = await this.prisma.user.findUniqueOrThrow({ where: { id: userId } });
        const hash = hashToken(code.toUpperCase());
        if (!user.twoFactorRecoveryCodes.includes(hash)) {
            return false;
        }

        await this.prisma.user.update({
            where: { id: userId },
            data: { twoFactorRecoveryCodes: user.twoFactorRecoveryCodes.filter((stored) => stored !== hash) },
        });

        return true;
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
