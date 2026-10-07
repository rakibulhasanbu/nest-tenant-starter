import type { Tenant } from "@/database/schema/tenants.js";

/**
 * Domain events other modules may react to. Today they are delivered in-process
 * by @nestjs/event-emitter; the names and payloads are the contract that would
 * move to a message broker if tenants ever become their own service.
 */
export const TenantEvents = {
    CREATED: "tenant.created",
    APPROVED: "tenant.approved",
    REJECTED: "tenant.rejected",
    SUSPENDED: "tenant.suspended",
    REACTIVATED: "tenant.reactivated",
    MEMBERSHIP_ADDED: "membership.added",
    DELETED: "tenant.deleted",
    SETTINGS_UPDATED: "platform.settings-updated",
} as const;

export interface TenantCreatedEvent {
    tenant: Tenant;
    ownerId: string;
    ownerEmail: string;
}

export interface TenantReviewedEvent {
    tenant: Tenant;
    /** The address of whoever created the tenant, who is told the outcome. */
    ownerEmail: string | null;
    /** The super admin who made the change. */
    actorId: string;
}

export interface MembershipAddedEvent {
    tenant: Tenant;
    userId: string;
    userEmail: string;
}

export interface TenantDeletedEvent {
    tenant: Tenant;
}

export interface PlatformSettingsUpdatedEvent {
    actorId: string;
    /** Only the fields that were changed. */
    changes: Record<string, unknown>;
}
