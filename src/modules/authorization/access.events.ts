/**
 * Who may do what inside a tenant changed. Announced so that anything which needs
 * a trail of it (the audit log today) can subscribe without the admin services
 * knowing it exists.
 */
export const AccessEvents = {
    ROLES_ASSIGNED: "membership.roles-assigned",
    MEMBERSHIP_STATUS_CHANGED: "membership.status-changed",
    ROLE_CREATED: "role.created",
    ROLE_UPDATED: "role.updated",
    ROLE_DELETED: "role.deleted",
} as const;

interface AccessChangeBase {
    tenantId: string;
    actorId: string;
}

export interface RolesAssignedEvent extends AccessChangeBase {
    userId: string;
    roleSlugs: string[];
}

export interface MembershipStatusChangedEvent extends AccessChangeBase {
    userId: string;
    status: string;
}

export interface RoleChangedEvent extends AccessChangeBase {
    roleSlug: string;
    /** What was edited, for an update. */
    changes?: Record<string, unknown>;
}
