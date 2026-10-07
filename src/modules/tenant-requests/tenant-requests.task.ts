import { Injectable, Logger } from "@nestjs/common";
import { Cron, CronExpression } from "@nestjs/schedule";
import { TenantRequestsService } from "@/modules/tenant-requests/tenant-requests.service.js";

@Injectable()
export class TenantRequestsTask {
    private readonly logger = new Logger(TenantRequestsTask.name);

    constructor(private readonly requestsService: TenantRequestsService) {}

    /** Morning, not hourly: a reminder at 3am helps nobody. Safe on several instances — each request is claimed once. */
    @Cron(CronExpression.EVERY_DAY_AT_9AM)
    async sendReminders(): Promise<void> {
        const sent = await this.requestsService.sendDueReminders();
        if (sent > 0) {
            this.logger.log(`Reminded the super admin about ${sent} waiting registration request(s)`);
        }
    }

    @Cron(CronExpression.EVERY_DAY_AT_MIDNIGHT)
    async purgeRejected(): Promise<void> {
        const purged = await this.requestsService.purgeRejected();
        if (purged > 0) {
            this.logger.log(`Deleted ${purged} rejected registration request(s) past their retention period`);
        }
    }
}
