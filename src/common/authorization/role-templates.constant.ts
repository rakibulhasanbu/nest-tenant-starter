import {
    PERMISSIONS,
    TENANT_PERMISSION_KEYS,
    type PermissionKey,
} from "@/common/authorization/permissions.constant.js";

/**
 * Role slugs — what the API calls a role id. Roles only exist inside a tenant:
 * each new tenant gets its own copy of these templates, which its admins can
 * then edit (permissions only; slug, name and rank of a system role are fixed).
 */
export const ROLE_SLUGS = {
    OWNER: "owner",
    ADMIN: "admin",
    USER: "user",
} as const;

export type RoleSlug = (typeof ROLE_SLUGS)[keyof typeof ROLE_SLUGS];

export interface RoleTemplate {
    slug: RoleSlug;
    name: string;
    description: string;
    /**
     * Management hierarchy. An actor may only act on members whose highest rank is
     * strictly below their own. Grants no permissions by itself.
     */
    rank: number;
    permissions: readonly PermissionKey[];
}

export const ROLE_TEMPLATES: readonly RoleTemplate[] = [
    {
        slug: ROLE_SLUGS.USER,
        name: "User",
        description: "Baseline role every member receives. Account self-management only.",
        rank: 0,
        permissions: [PERMISSIONS.TENANT_READ],
    },
    {
        slug: ROLE_SLUGS.ADMIN,
        name: "Admin",
        description: "Manages members and their sessions.",
        rank: 50,
        permissions: [
            PERMISSIONS.TENANT_READ,
            PERMISSIONS.USER_READ_ANY,
            PERMISSIONS.USER_STATUS_ANY,
            PERMISSIONS.USER_INVITE,
            PERMISSIONS.USER_PASSWORD_RESET_ANY,
            PERMISSIONS.SESSION_READ_ANY,
            PERMISSIONS.SESSION_REVOKE_ANY,
            PERMISSIONS.ROLE_READ,
            PERMISSIONS.PERMISSION_READ,
        ],
    },
    {
        slug: ROLE_SLUGS.OWNER,
        name: "Owner",
        description: "Full control of the tenant. At least one owner must always remain.",
        rank: 100,
        permissions: TENANT_PERMISSION_KEYS,
    },
];
