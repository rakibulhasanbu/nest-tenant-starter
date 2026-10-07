import { Injectable } from "@nestjs/common";
import { OnEvent } from "@nestjs/event-emitter";
import {
    AccessEvents,
    type MembershipStatusChangedEvent,
    type RoleChangedEvent,
    type RolesAssignedEvent,
} from "@/modules/authorization/access.events.js";
import { AuditService } from "@/modules/audit/audit.service.js";
import {
    TenantInvitationEvents,
    type TenantInvitationAbandonedEvent,
    type TenantInvitationEvent,
} from "@/modules/tenant-invitations/tenant-invitation.events.js";
import { TenantRequestEvents, type TenantRequestEvent } from "@/modules/tenant-requests/tenant-request.events.js";
import {
    TenantEvents,
    type MembershipAddedEvent,
    type PlatformSettingsUpdatedEvent,
    type TenantCreatedEvent,
    type TenantDeletedEvent,
    type TenantReviewedEvent,
} from "@/modules/tenants/tenant.events.js";

/**
 * Maps domain events to audit entries. This is the only place that knows which
 * events are worth a trail and what each one records, so the modules that emit
 * them stay unaware of it. To audit something new, emit an event and add a handler.
 */
@Injectable()
export class AuditListener {
    constructor(private readonly audit: AuditService) {}

    // --- tenant lifecycle ---------------------------------------------------

    @OnEvent(TenantEvents.CREATED)
    onTenantCreated({ tenant, ownerId }: TenantCreatedEvent) {
        return this.audit.record({
            tenantId: tenant.id,
            actorId: ownerId,
            action: "tenant.created",
            targetType: "tenant",
            targetId: tenant.id,
            metadata: { slug: tenant.slug, status: tenant.status },
        });
    }

    @OnEvent(TenantEvents.APPROVED)
    onTenantApproved(event: TenantReviewedEvent) {
        return this.tenantReviewed("tenant.approved", event);
    }

    @OnEvent(TenantEvents.REJECTED)
    onTenantRejected(event: TenantReviewedEvent) {
        return this.tenantReviewed("tenant.rejected", event, { reason: event.tenant.rejectionReason });
    }

    @OnEvent(TenantEvents.SUSPENDED)
    onTenantSuspended(event: TenantReviewedEvent) {
        return this.tenantReviewed("tenant.suspended", event);
    }

    @OnEvent(TenantEvents.REACTIVATED)
    onTenantReactivated(event: TenantReviewedEvent) {
        return this.tenantReviewed("tenant.reactivated", event);
    }

    @OnEvent(TenantEvents.DELETED)
    onTenantDeleted({ tenant }: TenantDeletedEvent) {
        // The tenant's own rows are gone with it, so the record is kept at platform level.
        return this.audit.record({
            tenantId: null,
            actorId: null,
            action: "tenant.deleted",
            targetType: "tenant",
            targetId: tenant.id,
            metadata: { slug: tenant.slug, name: tenant.name },
        });
    }

    @OnEvent(TenantEvents.MEMBERSHIP_ADDED)
    onMembershipAdded({ tenant, userId }: MembershipAddedEvent) {
        return this.audit.record({
            tenantId: tenant.id,
            actorId: null,
            action: "membership.added",
            targetType: "user",
            targetId: userId,
        });
    }

    @OnEvent(TenantEvents.SETTINGS_UPDATED)
    onSettingsUpdated({ actorId, changes }: PlatformSettingsUpdatedEvent) {
        return this.audit.record({
            tenantId: null,
            actorId,
            action: "platform.settings-updated",
            targetType: "platform-settings",
            targetId: "1",
            metadata: changes,
        });
    }

    // --- onboarding ---------------------------------------------------------

    @OnEvent(TenantRequestEvents.SUBMITTED)
    onRequestSubmitted({ request }: TenantRequestEvent) {
        return this.audit.record({
            tenantId: null,
            actorId: null,
            action: "tenant-request.submitted",
            targetType: "tenant-request",
            targetId: request.id,
            metadata: { businessName: request.businessName },
        });
    }

    @OnEvent(TenantRequestEvents.APPROVED)
    onRequestApproved({ request }: TenantRequestEvent) {
        return this.audit.record({
            tenantId: null,
            actorId: request.reviewedBy,
            action: "tenant-request.approved",
            targetType: "tenant-request",
            targetId: request.id,
        });
    }

    @OnEvent(TenantRequestEvents.REJECTED)
    onRequestRejected({ request }: TenantRequestEvent) {
        return this.audit.record({
            tenantId: null,
            actorId: request.reviewedBy,
            action: "tenant-request.rejected",
            targetType: "tenant-request",
            targetId: request.id,
            metadata: { reason: request.rejectionReason },
        });
    }

    @OnEvent(TenantInvitationEvents.CREATED)
    onInvitationCreated(event: TenantInvitationEvent) {
        return this.invitation("tenant-invitation.created", event);
    }

    @OnEvent(TenantInvitationEvents.ACCEPTED)
    onInvitationAccepted(event: TenantInvitationEvent) {
        return this.audit.record({
            tenantId: event.tenantId,
            actorId: event.userId,
            action: "tenant-invitation.accepted",
            targetType: "tenant-invitation",
            targetId: event.invitationId,
        });
    }

    @OnEvent(TenantInvitationEvents.ABANDONED)
    onInvitationAbandoned(event: TenantInvitationAbandonedEvent) {
        // The tenant is already deleted, so this is a platform-level record.
        return this.audit.record({
            tenantId: null,
            actorId: null,
            action: "tenant-invitation.abandoned",
            targetType: "tenant",
            targetId: event.tenantId,
            metadata: { slug: event.tenantSlug, ownerEmail: event.email },
        });
    }

    // --- access inside a tenant ---------------------------------------------

    @OnEvent(AccessEvents.ROLES_ASSIGNED)
    onRolesAssigned({ tenantId, actorId, userId, roleSlugs }: RolesAssignedEvent) {
        return this.audit.record({
            tenantId,
            actorId,
            action: "membership.roles-assigned",
            targetType: "user",
            targetId: userId,
            metadata: { roles: roleSlugs },
        });
    }

    @OnEvent(AccessEvents.MEMBERSHIP_STATUS_CHANGED)
    onMembershipStatusChanged({ tenantId, actorId, userId, status }: MembershipStatusChangedEvent) {
        return this.audit.record({
            tenantId,
            actorId,
            action: "membership.status-changed",
            targetType: "user",
            targetId: userId,
            metadata: { status },
        });
    }

    @OnEvent(AccessEvents.ROLE_CREATED)
    onRoleCreated(event: RoleChangedEvent) {
        return this.role("role.created", event);
    }

    @OnEvent(AccessEvents.ROLE_UPDATED)
    onRoleUpdated(event: RoleChangedEvent) {
        return this.role("role.updated", event);
    }

    @OnEvent(AccessEvents.ROLE_DELETED)
    onRoleDeleted(event: RoleChangedEvent) {
        return this.role("role.deleted", event);
    }

    private tenantReviewed(action: string, { tenant, actorId }: TenantReviewedEvent, metadata: Record<string, unknown> = {}) {
        return this.audit.record({
            tenantId: tenant.id,
            actorId,
            action,
            targetType: "tenant",
            targetId: tenant.id,
            metadata: { slug: tenant.slug, ...metadata },
        });
    }

    private invitation(action: string, event: TenantInvitationEvent) {
        return this.audit.record({
            tenantId: event.tenantId,
            actorId: null,
            action,
            targetType: "tenant-invitation",
            targetId: event.invitationId,
        });
    }

    private role(action: string, { tenantId, actorId, roleSlug, changes }: RoleChangedEvent) {
        return this.audit.record({
            tenantId,
            actorId,
            action,
            targetType: "role",
            targetId: roleSlug,
            metadata: changes ?? {},
        });
    }
}
