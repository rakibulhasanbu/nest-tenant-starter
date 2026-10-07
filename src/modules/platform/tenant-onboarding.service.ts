import { Injectable } from "@nestjs/common";
import { EventEmitter2 } from "@nestjs/event-emitter";
import type { CreatePlatformTenantInput } from "@/modules/platform/dto/create-platform-tenant.schema.js";
import { TenantInvitationsService } from "@/modules/tenant-invitations/tenant-invitations.service.js";
import { TenantRequestsService } from "@/modules/tenant-requests/tenant-requests.service.js";
import { TenantEvents, type MembershipAddedEvent } from "@/modules/tenants/tenant.events.js";
import { TenantsService } from "@/modules/tenants/tenants.service.js";

/**
 * The admin-led way to get a tenant: create it, then invite its owner. Lives in
 * the platform module because it stitches together tenants, invitations and
 * requests, none of which may reach into another's tables.
 */
@Injectable()
export class TenantOnboardingService {
    constructor(
        private readonly tenantsService: TenantsService,
        private readonly invitationsService: TenantInvitationsService,
        private readonly requestsService: TenantRequestsService,
        private readonly events: EventEmitter2,
    ) {}

    async createAndInvite(input: CreatePlatformTenantInput, adminId: string) {
        const request = input.requestId ? await this.requestsService.getConvertibleOrThrow(input.requestId) : null;
        const ownerEmail = (input.ownerEmail ?? request?.email)!;

        // Before any account exists, so a bad slug leaves nothing behind.
        await this.tenantsService.assertSlugAvailable(input.slug);

        const { user, isNew } = await this.invitationsService.prepareOwner(ownerEmail);
        const tenant = await this.tenantsService.createByPlatform(
            user.id,
            { name: input.name, slug: input.slug },
            adminId,
        );

        if (request) {
            await this.requestsService.linkTenant(request.id, tenant.id);
        }

        let inviteSent = true;
        if (isNew) {
            // The tenant exists by now, so a mail failure is reported, not fatal: the admin can resend.
            inviteSent = await this.invitationsService.issue(tenant, user);
        } else {
            this.events.emit(TenantEvents.MEMBERSHIP_ADDED, {
                tenant,
                userId: user.id,
                userEmail: user.email,
            } satisfies MembershipAddedEvent);
        }

        return {
            tenant: { ...tenant, url: this.tenantsService.urlFor(tenant.slug) },
            owner: { id: user.id, email: user.email, isNewAccount: isNew },
            inviteSent,
        };
    }

    /** Re-issues the invitation while the owner has not yet accepted it. */
    resendInvite(tenantId: string): Promise<void> {
        return this.invitationsService.resendForTenant(tenantId);
    }
}
