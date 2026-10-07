/**
 * The permission catalog — the single source of truth.
 *
 * Nothing in the application ever checks a role name; it checks a permission
 * key from this list. Roles are just bundles of these keys, which is what lets
 * new roles be created at runtime without touching code.
 *
 * The seed reconciles the `permissions` table against this file: keys added
 * here are inserted, keys removed here are deleted (cascading to any role that
 * referenced them). So this file is what ships, and the table merely mirrors it.
 */

export interface PermissionDefinition {
    key: string;
    /**
     * `tenant` permissions live in tenant roles; `platform` permissions belong to the
     * single super admin and are honoured only on the platform host.
     */
    level: "tenant" | "platform";
    resource: string;
    action: string;
    /** "any" = across all records, "own" = only the actor's own records. */
    scope: "any" | "own" | "";
    description: string;
}

export const PERMISSIONS = {
    TENANT_READ: "tenant:read",
    TENANT_UPDATE: "tenant:update",

    USER_READ_ANY: "user:read:any",
    USER_STATUS_ANY: "user:status:any",
    USER_INVITE: "user:invite",
    USER_PASSWORD_RESET_ANY: "user:password-reset:any",

    SESSION_READ_ANY: "session:read:any",
    SESSION_REVOKE_ANY: "session:revoke:any",

    ROLE_READ: "role:read",
    ROLE_WRITE: "role:write",
    ROLE_ASSIGN: "role:assign",

    PERMISSION_READ: "permission:read",

    PLATFORM_TENANT_READ: "platform:tenant:read",
    PLATFORM_TENANT_REVIEW: "platform:tenant:review",
    PLATFORM_TENANT_SUSPEND: "platform:tenant:suspend",
    PLATFORM_SETTINGS_READ: "platform:settings:read",
    PLATFORM_SETTINGS_WRITE: "platform:settings:write",
} as const;

export type PermissionKey = (typeof PERMISSIONS)[keyof typeof PERMISSIONS];

/** The super admin's fixed permission set. Not editable data — changing it is a code change. */
export const PLATFORM_PERMISSIONS: readonly PermissionKey[] = [
    PERMISSIONS.PLATFORM_TENANT_READ,
    PERMISSIONS.PLATFORM_TENANT_REVIEW,
    PERMISSIONS.PLATFORM_TENANT_SUSPEND,
    PERMISSIONS.PLATFORM_SETTINGS_READ,
    PERMISSIONS.PLATFORM_SETTINGS_WRITE,
];

export const PERMISSION_CATALOG: readonly PermissionDefinition[] = [
    {
        key: PERMISSIONS.TENANT_READ,
        level: "tenant",
        resource: "tenant",
        action: "read",
        scope: "",
        description: "View this tenant's details",
    },
    {
        key: PERMISSIONS.TENANT_UPDATE,
        level: "tenant",
        resource: "tenant",
        action: "update",
        scope: "",
        description: "Edit this tenant's display name",
    },
    {
        key: PERMISSIONS.USER_READ_ANY,
        level: "tenant",
        resource: "user",
        action: "read",
        scope: "any",
        description: "View any user account",
    },
    {
        key: PERMISSIONS.USER_STATUS_ANY,
        level: "tenant",
        resource: "user",
        action: "status",
        scope: "any",
        description: "Activate or suspend any user account",
    },
    {
        key: PERMISSIONS.USER_INVITE,
        level: "tenant",
        resource: "user",
        action: "invite",
        scope: "",
        description: "Invite a new user and assign them roles",
    },
    {
        key: PERMISSIONS.USER_PASSWORD_RESET_ANY,
        level: "tenant",
        resource: "user",
        action: "password-reset",
        scope: "any",
        description: "Trigger a password reset email for any user",
    },
    {
        key: PERMISSIONS.SESSION_READ_ANY,
        level: "tenant",
        resource: "session",
        action: "read",
        scope: "any",
        description: "List the active sessions of any user",
    },
    {
        key: PERMISSIONS.SESSION_REVOKE_ANY,
        level: "tenant",
        resource: "session",
        action: "revoke",
        scope: "any",
        description: "Revoke the sessions of any user",
    },
    {
        key: PERMISSIONS.ROLE_READ,
        level: "tenant",
        resource: "role",
        action: "read",
        scope: "",
        description: "View roles and the permissions attached to them",
    },
    {
        key: PERMISSIONS.ROLE_WRITE,
        level: "tenant",
        resource: "role",
        action: "write",
        scope: "",
        description: "Create, edit and delete roles, and change their permissions",
    },
    {
        key: PERMISSIONS.ROLE_ASSIGN,
        level: "tenant",
        resource: "role",
        action: "assign",
        scope: "",
        description: "Grant or revoke a user's roles",
    },
    {
        key: PERMISSIONS.PERMISSION_READ,
        level: "tenant",
        resource: "permission",
        action: "read",
        scope: "",
        description: "View the permission catalog",
    },
    {
        key: PERMISSIONS.PLATFORM_TENANT_READ,
        level: "platform",
        resource: "platform-tenant",
        action: "read",
        scope: "any",
        description: "List and inspect every tenant",
    },
    {
        key: PERMISSIONS.PLATFORM_TENANT_REVIEW,
        level: "platform",
        resource: "platform-tenant",
        action: "review",
        scope: "any",
        description: "Approve or reject tenants awaiting approval",
    },
    {
        key: PERMISSIONS.PLATFORM_TENANT_SUSPEND,
        level: "platform",
        resource: "platform-tenant",
        action: "suspend",
        scope: "any",
        description: "Suspend or reactivate a tenant",
    },
    {
        key: PERMISSIONS.PLATFORM_SETTINGS_READ,
        level: "platform",
        resource: "platform-settings",
        action: "read",
        scope: "",
        description: "View platform settings",
    },
    {
        key: PERMISSIONS.PLATFORM_SETTINGS_WRITE,
        level: "platform",
        resource: "platform-settings",
        action: "write",
        scope: "",
        description: "Change platform settings such as tenant approval",
    },
];

export const TENANT_PERMISSION_KEYS: readonly PermissionKey[] = PERMISSION_CATALOG.filter(
    permission => permission.level === "tenant",
).map(permission => permission.key as PermissionKey);
