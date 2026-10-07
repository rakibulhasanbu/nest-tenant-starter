import { defineRelations } from "drizzle-orm";
import * as auth from "@/database/schema/auth.js";
import * as authorization from "@/database/schema/authorization.js";
import * as tenants from "@/database/schema/tenants.js";
import * as tenantRequests from "@/database/schema/tenant-requests.js";
import * as tenantInvitations from "@/database/schema/tenant-invitations.js";
import * as auditLogs from "@/database/schema/audit-logs.js";
import * as users from "@/database/schema/users.js";

export const schema = { ...users, ...tenants, ...tenantRequests, ...tenantInvitations, ...auditLogs, ...authorization, ...auth };

export const relations = defineRelations(schema, r => ({
    users: {
        profile: r.one.userProfiles({ from: r.users.id, to: r.userProfiles.userId }),
        notificationPreferences: r.one.notificationPreferences({
            from: r.users.id,
            to: r.notificationPreferences.userId,
        }),
        memberships: r.many.tenantMemberships(),
        platformAdmin: r.one.platformAdmins({ from: r.users.id, to: r.platformAdmins.userId }),
        refreshTokens: r.many.refreshTokens(),
        emailTokens: r.many.emailTokens(),
        socialIdentities: r.many.socialIdentities(),
    },
    userProfiles: {
        user: r.one.users({ from: r.userProfiles.userId, to: r.users.id, optional: false }),
    },
    notificationPreferences: {
        user: r.one.users({ from: r.notificationPreferences.userId, to: r.users.id, optional: false }),
    },
    platformAdmins: {
        user: r.one.users({ from: r.platformAdmins.userId, to: r.users.id, optional: false }),
    },
    tenants: {
        memberships: r.many.tenantMemberships(),
        roles: r.many.roles(),
    },
    tenantMemberships: {
        tenant: r.one.tenants({ from: r.tenantMemberships.tenantId, to: r.tenants.id, optional: false }),
        user: r.one.users({ from: r.tenantMemberships.userId, to: r.users.id, optional: false }),
        roleAssignments: r.many.membershipRoles({
            from: [r.tenantMemberships.tenantId, r.tenantMemberships.userId],
            to: [r.membershipRoles.tenantId, r.membershipRoles.userId],
        }),
    },
    membershipRoles: {
        membership: r.one.tenantMemberships({
            from: [r.membershipRoles.tenantId, r.membershipRoles.userId],
            to: [r.tenantMemberships.tenantId, r.tenantMemberships.userId],
            optional: false,
        }),
        role: r.one.roles({ from: r.membershipRoles.roleId, to: r.roles.id, optional: false }),
    },
    roles: {
        tenant: r.one.tenants({ from: r.roles.tenantId, to: r.tenants.id, optional: false }),
        assignments: r.many.membershipRoles(),
        permissions: r.many.rolePermissions(),
    },
    rolePermissions: {
        role: r.one.roles({ from: r.rolePermissions.roleId, to: r.roles.id, optional: false }),
        permission: r.one.permissions({
            from: r.rolePermissions.permissionKey,
            to: r.permissions.key,
            optional: false,
        }),
    },
    permissions: {
        roles: r.many.rolePermissions(),
    },
    refreshTokens: {
        user: r.one.users({ from: r.refreshTokens.userId, to: r.users.id, optional: false }),
    },
    emailTokens: {
        user: r.one.users({ from: r.emailTokens.userId, to: r.users.id, optional: false }),
    },
    socialIdentities: {
        user: r.one.users({ from: r.socialIdentities.userId, to: r.users.id, optional: false }),
    },
}));

export type Relations = typeof relations;
