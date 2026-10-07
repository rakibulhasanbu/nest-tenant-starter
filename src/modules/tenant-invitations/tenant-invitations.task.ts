import { Injectable, Logger } from "@nestjs/common";
import { Cron, CronExpression } from "@nestjs/schedule";
import { TenantInvitationsService } from "@/modules/tenant-invitations/tenant-invitations.service.js";

@Injectable()
export class TenantInvitationsTask {
    private readonly logger = new Logger(TenantInvitationsTask.name);

    constructor(private readonly invitationsService: TenantInvitationsService) {}

    /** Morning, not hourly: a reminder at 3am helps nobody. Safe on several instances — each invitation is claimed once. */
    @Cron(CronExpression.EVERY_DAY_AT_9AM)
    async sendReminders(): Promise<void> {
        const sent = await this.invitationsService.sendDueReminders();
        if (sent > 0) {
            this.logger.log(`Sent ${sent} owner-invite reminder(s)`);
        }
    }

    @Cron(CronExpression.EVERY_DAY_AT_MIDNIGHT)
    async removeAbandoned(): Promise<void> {
        const removed = await this.invitationsService.cleanupAbandoned();
        if (removed > 0) {
            this.logger.log(`Removed ${removed} tenant(s) whose owner never accepted the invitation`);
        }
    }
}
