import { boolean, foreignKey, index, integer, pgTable, primaryKey, text, unique } from "drizzle-orm/pg-core";
import { randomUUID } from "node:crypto";
import { permissionLevelEnum, PermissionLevel } from "@/database/schema/enums.js";
import { tenantIsolationPolicy } from "@/database/schema/rls.js";
import { tenantMemberships, tenants } from "@/database/schema/tenants.js";
import { createdAtColumn, timestamptz, updatedAtColumn } from "@/database/schema/timestamps.js";

/**
 * A named bundle of permissions that belongs to exactly one tenant. `slug` is
 * what the API calls a role id ("admin"); the primary key is a surrogate so the
 * same slug can exist in every tenant. Tenant-owned: RLS applies.
 */
export const roles = pgTable(
    "roles",
    {
        id: text("id")
            .primaryKey()
            .$defaultFn(() => randomUUID()),
        tenantId: text("tenant_id")
            .notNull()
            .references(() => tenants.id, { onDelete: "cascade" }),
        slug: text("slug").notNull(),
        name: text("name").notNull(),
        description: text("description"),

        /**
         * Management hierarchy: an actor may only act on users ranked strictly below them.
         * Unrelated to permissions — a high rank grants nothing on its own.
         */
        rank: integer("rank").notNull().default(0),

        /** Template roles the application itself depends on; they cannot be deleted or renamed. */
        isSystem: boolean("is_system").notNull().default(false),

        createdAt: createdAtColumn(),
        updatedAt: updatedAtColumn(),
    },
    table => [unique("roles_tenant_slug_key").on(table.tenantId, table.slug), tenantIsolationPolicy("roles")],
).enableRLS();

/**
 * The atomic unit of authorization. Mirrors the catalog declared in
 * src/common/authorization/permissions.constant.ts, which is the source of truth.
 * Global (no RLS): the catalog is the same for every tenant.
 */
export const permissions = pgTable(
    "permissions",
    {
        key: text("key").primaryKey(),
        resource: text("resource").notNull(),
        action: text("action").notNull(),
        scope: text("scope").notNull().default("any"),
        /** `platform` permissions are only honoured for the super admin on the platform host. */
        level: permissionLevelEnum("level").notNull().default(PermissionLevel.TENANT),
        description: text("description"),
    },
    table => [index("permissions_resource_idx").on(table.resource)],
);

/** `tenantId` is denormalised from the role so RLS can filter this table without a join. */
export const rolePermissions = pgTable(
    "role_permissions",
    {
        tenantId: text("tenant_id")
            .notNull()
            .references(() => tenants.id, { onDelete: "cascade" }),
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
        index("role_permissions_tenant_id_idx").on(table.tenantId),
        tenantIsolationPolicy("role_permissions"),
    ],
).enableRLS();

export const membershipRoles = pgTable(
    "membership_roles",
    {
        tenantId: text("tenant_id").notNull(),
        userId: text("user_id").notNull(),
        // Cascade, not restrict: deleting a tenant must be able to remove its roles and
        // their assignments together. "Remove this role from all users first" is an
        // application rule (AdminRolesService), not a database one.
        roleId: text("role_id")
            .notNull()
            .references(() => roles.id, { onDelete: "cascade" }),
        assignedAt: timestamptz("assigned_at").notNull().defaultNow(),
        assignedBy: text("assigned_by"),
    },
    table => [
        primaryKey({ columns: [table.tenantId, table.userId, table.roleId] }),
        foreignKey({
            columns: [table.tenantId, table.userId],
            foreignColumns: [tenantMemberships.tenantId, tenantMemberships.userId],
            name: "membership_roles_membership_fk",
        }).onDelete("cascade"),
        index("membership_roles_role_id_idx").on(table.roleId),
        tenantIsolationPolicy("membership_roles"),
    ],
).enableRLS();

export type Role = typeof roles.$inferSelect;
