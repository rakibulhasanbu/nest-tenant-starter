import { ConflictException, Injectable, Logger, NotFoundException } from "@nestjs/common";
import { EventEmitter2 } from "@nestjs/event-emitter";
import { AuthService } from "@/modules/auth/auth.service.js";
import type { CreatePlatformTenantInput } from "@/modules/platform/dto/create-platform-tenant.schema.js";
import { TenantRequestsService } from "@/modules/tenant-requests/tenant-requests.service.js";
import { TenantEvents, type MembershipAddedEvent } from "@/modules/tenants/tenant.events.js";
import { TenantsService } from "@/modules/tenants/tenants.service.js";
import { UsersService } from "@/modules/users/users.service.js";

/**
 * The admin-led way to get a tenant: create it, then invite its owner. Lives in
 * the platform module because it stitches together tenants, auth and requests,
 * none of which may reach into another's tables.
 */
@Injectable()
export class TenantOnboardingService {
    private readonly logger = new Logger(TenantOnboardingService.name);

    constructor(
        private readonly tenantsService: TenantsService,
        private readonly authService: AuthService,
        private readonly requestsService: TenantRequestsService,
        private readonly usersService: UsersService,
        private readonly events: EventEmitter2,
    ) {}

    async createAndInvite(input: CreatePlatformTenantInput, adminId: string) {
        const request = input.requestId ? await this.requestsService.getConvertibleOrThrow(input.requestId) : null;
        const ownerEmail = (input.ownerEmail ?? request?.email)!;

        // Before any account exists, so a bad slug leaves nothing behind.
        await this.tenantsService.assertSlugAvailable(input.slug);

        const { user, isNew } = await this.authService.prepareTenantOwner(ownerEmail);
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
            inviteSent = await this.sendInvite(user, tenant);
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
    async resendInvite(tenantId: string): Promise<void> {
        const tenant = await this.tenantsService.findByIdOrThrow(tenantId);
        const owner = tenant.createdBy ? await this.usersService.findById(tenant.createdBy) : null;
        if (!owner) {
            throw new NotFoundException({
                code: "TENANT_OWNER_NOT_FOUND",
                message: "This tenant has no owner to invite",
            });
        }
        if (owner.emailVerifiedAt) {
            throw new ConflictException({
                code: "INVITE_ALREADY_ACCEPTED",
                message: "The owner has already accepted the invitation",
            });
        }

        await this.authService.sendTenantOwnerInvite(owner, tenant);
    }

    private async sendInvite(
        user: { id: string; email: string },
        tenant: Parameters<AuthService["sendTenantOwnerInvite"]>[1],
    ) {
        try {
            await this.authService.sendTenantOwnerInvite(user, tenant);
            return true;
        } catch (error) {
            this.logger.error(`Invite email failed for tenant ${tenant.slug}: ${(error as Error).message}`);
            return false;
        }
    }
}
