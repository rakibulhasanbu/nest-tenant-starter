import { Inject, Injectable, Logger } from "@nestjs/common";
import { ConfigService } from "@nestjs/config";
import { OnEvent } from "@nestjs/event-emitter";
import type { Env } from "@/config/env.schema.js";
import { TenantStatus } from "@/database/schema/enums.js";
import { EMAIL_SENDER, type EmailSender } from "@/integrations/email/email-sender.interface.js";
import {
    TenantEvents,
    type MembershipAddedEvent,
    type TenantCreatedEvent,
    type TenantReviewedEvent,
} from "@/modules/tenants/tenant.events.js";
import { TenantsService } from "@/modules/tenants/tenants.service.js";

/**
 * Turns tenant domain events into emails. Kept apart from TenantsService on
 * purpose: the service only announces what happened; whether and how anyone is
 * told is a separate concern that could move to its own service unchanged.
 * A failed email must never fail the action that triggered it.
 */
@Injectable()
export class TenantNotificationsListener {
    private readonly logger = new Logger(TenantNotificationsListener.name);

    constructor(
        @Inject(EMAIL_SENDER) private readonly emailSender: EmailSender,
        private readonly configService: ConfigService<Env, true>,
        private readonly tenantsService: TenantsService,
    ) {}

    @OnEvent(TenantEvents.CREATED)
    async onCreated({ tenant, ownerEmail }: TenantCreatedEvent): Promise<void> {
        if (tenant.status !== TenantStatus.PENDING_APPROVAL) {
            return;
        }

        await this.safely(() =>
            this.emailSender.sendTenantPendingApproval({
                to: this.configService.get("ADMIN_EMAIL", { infer: true }),
                tenantName: tenant.name,
                tenantSlug: tenant.slug,
                ownerEmail,
            }),
        );
    }

    @OnEvent(TenantEvents.APPROVED)
    async onApproved({ tenant, ownerEmail }: TenantReviewedEvent): Promise<void> {
        if (!ownerEmail) {
            return;
        }
        await this.safely(() =>
            this.emailSender.sendTenantApproved({
                to: ownerEmail,
                tenantName: tenant.name,
                url: this.tenantsService.urlFor(tenant.slug),
            }),
        );
    }

    @OnEvent(TenantEvents.REJECTED)
    async onRejected({ tenant, ownerEmail }: TenantReviewedEvent): Promise<void> {
        if (!ownerEmail) {
            return;
        }
        await this.safely(() =>
            this.emailSender.sendTenantRejected({
                to: ownerEmail,
                tenantName: tenant.name,
                reason: tenant.rejectionReason,
            }),
        );
    }

    @OnEvent(TenantEvents.MEMBERSHIP_ADDED)
    async onMembershipAdded({ tenant, userEmail }: MembershipAddedEvent): Promise<void> {
        await this.safely(() =>
            this.emailSender.sendMembershipAdded({
                to: userEmail,
                tenantName: tenant.name,
                url: this.tenantsService.urlFor(tenant.slug),
            }),
        );
    }

    private async safely(send: () => Promise<void>): Promise<void> {
        try {
            await send();
        } catch (error) {
            this.logger.error(`Notification failed: ${(error as Error).message}`);
        }
    }
}
