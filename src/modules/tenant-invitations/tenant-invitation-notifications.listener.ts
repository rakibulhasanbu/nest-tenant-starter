import { Inject, Injectable, Logger } from "@nestjs/common";
import { ConfigService } from "@nestjs/config";
import { OnEvent } from "@nestjs/event-emitter";
import type { Env } from "@/config/env.schema.js";
import { EMAIL_SENDER, type EmailSender } from "@/integrations/email/email-sender.interface.js";
import {
    TenantInvitationEvents,
    type TenantInvitationAbandonedEvent,
} from "@/modules/tenant-invitations/tenant-invitation.events.js";

/** Turns invitation events into mails for the super admin. A failed mail never fails what triggered it. */
@Injectable()
export class TenantInvitationNotificationsListener {
    private readonly logger = new Logger(TenantInvitationNotificationsListener.name);

    constructor(
        @Inject(EMAIL_SENDER) private readonly emailSender: EmailSender,
        private readonly configService: ConfigService<Env, true>,
    ) {}

    @OnEvent(TenantInvitationEvents.ABANDONED)
    async onAbandoned(event: TenantInvitationAbandonedEvent): Promise<void> {
        try {
            await this.emailSender.sendTenantInvitationAbandoned({
                to: this.configService.get("ADMIN_EMAIL", { infer: true }),
                tenantName: event.tenantName,
                tenantSlug: event.tenantSlug,
                ownerEmail: event.email,
            });
        } catch (error) {
            this.logger.error(`Notification failed: ${(error as Error).message}`);
        }
    }
}
