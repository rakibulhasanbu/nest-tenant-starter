import { Injectable, Logger } from "@nestjs/common";
import { ConfigService } from "@nestjs/config";
import { Cron, CronExpression } from "@nestjs/schedule";
import type { Env } from "@/config/env.schema.js";
import { EmailTokensService } from "@/modules/auth/email-tokens.service.js";
import { TokensService } from "@/modules/auth/tokens.service.js";
import { UsersService } from "@/modules/users/users.service.js";

/** Refresh tokens and email codes had nothing removing rows from them, so they accumulated forever. */
const REVOKED_REFRESH_TOKEN_RETENTION_DAYS = 7;

@Injectable()
export class AuthCleanupTask {
    private readonly logger = new Logger(AuthCleanupTask.name);

    constructor(
        private readonly tokensService: TokensService,
        private readonly emailTokensService: EmailTokensService,
        private readonly usersService: UsersService,
        private readonly configService: ConfigService<Env, true>,
    ) {}

    @Cron(CronExpression.EVERY_HOUR)
    async purgeExpiredAuthArtifacts(): Promise<void> {
        const [refreshTokens, emailTokens] = await Promise.all([
            this.tokensService.purgeExpired(REVOKED_REFRESH_TOKEN_RETENTION_DAYS),
            this.emailTokensService.purgeExpired(),
        ]);

        if (refreshTokens + emailTokens > 0) {
            this.logger.log(`Purged ${refreshTokens} refresh token(s), ${emailTokens} email token(s)`);
        }
    }

    /**
     * Ends the grace period on accounts their owners deleted. Without this the
     * rows live forever, and because `email` and `username` are unique, the
     * address stays permanently unusable — someone who deletes their account
     * could never sign up again. Daily rather than hourly: the window is measured
     * in days, so nothing is gained by checking more often.
     */
    @Cron(CronExpression.EVERY_DAY_AT_3AM)
    async purgeExpiredDeletedUsers(): Promise<void> {
        const graceDays = this.configService.get("DELETED_USER_GRACE_DAYS", { infer: true });
        const count = await this.usersService.purgeExpiredDeleted(graceDays);

        if (count > 0) {
            this.logger.log(`Purged ${count} user(s) whose ${graceDays}-day deletion grace period had expired`);
        }
    }
}
