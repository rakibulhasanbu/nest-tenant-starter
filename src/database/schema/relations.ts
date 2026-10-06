import { defineRelations } from "drizzle-orm";
import * as auth from "@/database/schema/auth.js";
import * as authorization from "@/database/schema/authorization.js";
import * as users from "@/database/schema/users.js";

export const schema = { ...users, ...authorization, ...auth };

export const relations = defineRelations(schema, r => ({
    users: {
        profile: r.one.userProfiles({ from: r.users.id, to: r.userProfiles.userId }),
        notificationPreferences: r.one.notificationPreferences({
            from: r.users.id,
            to: r.notificationPreferences.userId,
        }),
        roles: r.many.userRoles(),
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
    userRoles: {
        user: r.one.users({ from: r.userRoles.userId, to: r.users.id, optional: false }),
        role: r.one.roles({ from: r.userRoles.roleId, to: r.roles.id, optional: false }),
    },
    roles: {
        users: r.many.userRoles(),
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
