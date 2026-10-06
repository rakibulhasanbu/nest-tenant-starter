import { boolean, index, integer, pgTable, primaryKey, text, uniqueIndex } from "drizzle-orm/pg-core";
import { sql } from "drizzle-orm";
import { users } from "@/database/schema/users.js";
import { createdAtColumn, timestamptz, updatedAtColumn } from "@/database/schema/timestamps.js";

/**
 * A named bundle of permissions. `id` is a stable slug ("admin") because code
 * references it directly; display text lives in `name`.
 */
export const roles = pgTable("roles", {
    id: text("id").primaryKey(),
    name: text("name").notNull(),
    description: text("description"),

    /**
     * Management hierarchy: an actor may only act on users ranked strictly below them.
     * Unrelated to permissions — a high rank grants nothing on its own.
     */
    rank: integer("rank").notNull().default(0),

    /** Seeded roles the application itself depends on; they cannot be deleted or renamed. */
    isSystem: boolean("is_system").notNull().default(false),

    createdAt: createdAtColumn(),
    updatedAt: updatedAtColumn(),
});

/**
 * The atomic unit of authorization. Mirrors the catalog declared in
 * src/common/authorization/permissions.constant.ts, which is the source of truth.
 */
export const permissions = pgTable(
    "permissions",
    {
        key: text("key").primaryKey(),
        resource: text("resource").notNull(),
        action: text("action").notNull(),
        scope: text("scope").notNull().default("any"),
        description: text("description"),
    },
    table => [index("permissions_resource_idx").on(table.resource)],
);

export const rolePermissions = pgTable(
    "role_permissions",
    {
        roleId: text("role_id")
            .notNull()
            .references(() => roles.id, { onDelete: "cascade" }),
        permissionKey: text("permission_key")
            .notNull()
            .references(() => permissions.key, { onDelete: "cascade" }),
    },
    table => [
        primaryKey({ columns: [table.roleId, table.permissionKey] }),
        index("role_permissions_permission_key_idx").on(table.permissionKey),
    ],
);

export const userRoles = pgTable(
    "user_roles",
    {
        userId: text("user_id")
            .notNull()
            .references(() => users.id, { onDelete: "cascade" }),
        roleId: text("role_id")
            .notNull()
            .references(() => roles.id, { onDelete: "restrict" }),
        assignedAt: timestamptz("assigned_at").notNull().defaultNow(),
        assignedBy: text("assigned_by"),
    },
    table => [
        primaryKey({ columns: [table.userId, table.roleId] }),
        index("user_roles_role_id_idx").on(table.roleId),
        // At most one account may ever hold the super admin role.
        uniqueIndex("user_roles_single_super_admin")
            .on(table.roleId)
            .where(sql`${table.roleId} = 'super_admin'`),
    ],
);
