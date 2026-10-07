import { Inject, Injectable, Logger } from "@nestjs/common";
import { ConfigService } from "@nestjs/config";
import { OnEvent } from "@nestjs/event-emitter";
import type { Env } from "@/config/env.schema.js";
import { EMAIL_SENDER, type EmailSender } from "@/integrations/email/email-sender.interface.js";
import {
    TenantRequestEvents,
    type TenantRequestEvent,
    type TenantRequestReminderEvent,
} from "@/modules/tenant-requests/tenant-request.events.js";

/**
 * Turns registration-request events into mails: the applicant hears about each
 * decision, the super admin hears about new and neglected requests. A failed mail
 * never fails the action that triggered it.
 */
@Injectable()
export class TenantRequestNotificationsListener {
    private readonly logger = new Logger(TenantRequestNotificationsListener.name);

    constructor(
        @Inject(EMAIL_SENDER) private readonly emailSender: EmailSender,
        private readonly configService: ConfigService<Env, true>,
    ) {}

    @OnEvent(TenantRequestEvents.SUBMITTED)
    async onSubmitted({ request }: TenantRequestEvent): Promise<void> {
        await this.safely(() =>
            this.emailSender.sendTenantRequestReceived({ to: request.email, businessName: request.businessName }),
        );
        await this.safely(() =>
            this.emailSender.sendTenantRequestSubmitted({
                to: this.adminEmail(),
                businessName: request.businessName,
                ownerName: request.ownerName,
                ownerEmail: request.email,
            }),
        );
    }

    @OnEvent(TenantRequestEvents.APPROVED)
    async onApproved({ request }: TenantRequestEvent): Promise<void> {
        await this.safely(() =>
            this.emailSender.sendTenantRequestApproved({ to: request.email, businessName: request.businessName }),
        );
    }

    @OnEvent(TenantRequestEvents.REJECTED)
    async onRejected({ request }: TenantRequestEvent): Promise<void> {
        await this.safely(() =>
            this.emailSender.sendTenantRequestRejected({
                to: request.email,
                businessName: request.businessName,
                reason: request.rejectionReason,
            }),
        );
    }

    @OnEvent(TenantRequestEvents.REMINDER_DUE)
    async onReminderDue({ request, stage, reminderNumber }: TenantRequestReminderEvent): Promise<void> {
        await this.safely(() =>
            this.emailSender.sendTenantRequestReminder({
                to: this.adminEmail(),
                businessName: request.businessName,
                ownerEmail: request.email,
                stage,
                reminderNumber,
            }),
        );
    }

    private adminEmail(): string {
        return this.configService.get("ADMIN_EMAIL", { infer: true });
    }

    private async safely(send: () => Promise<void>): Promise<void> {
        try {
            await send();
        } catch (error) {
            this.logger.error(`Notification failed: ${(error as Error).message}`);
        }
    }
}
