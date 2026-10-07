import { boolean, index, integer, pgTable, primaryKey, text, uniqueIndex } from "drizzle-orm/pg-core";
import { sql } from "drizzle-orm";
import { randomUUID } from "node:crypto";
import {
    membershipStatusEnum,
    MembershipStatus,
    tenantIsolationEnum,
    TenantIsolation,
    tenantOnboardingModeEnum,
    TenantOnboardingMode,
    tenantStatusEnum,
    TenantStatus,
} from "@/database/schema/enums.js";
import { tenantIsolationPolicy } from "@/database/schema/rls.js";
import { createdAtColumn, timestamptz, updatedAtColumn } from "@/database/schema/timestamps.js";
import { users } from "@/database/schema/users.js";

/**
 * A customer organisation. Global table (no RLS): the host resolver and the
 * signin flow have to read it before any tenant is known.
 */
export const tenants = pgTable(
    "tenants",
    {
        id: text("id")
            .primaryKey()
            .$defaultFn(() => randomUUID()),
        /** Subdomain label. Immutable after creation — never expose an update path for it. */
        slug: text("slug").notNull().unique(),
        name: text("name").notNull(),
        status: tenantStatusEnum("status").notNull().default(TenantStatus.PENDING_APPROVAL),
        rejectionReason: text("rejection_reason"),
        isolation: tenantIsolationEnum("isolation").notNull().default(TenantIsolation.POOL),

        createdBy: text("created_by").references(() => users.id, { onDelete: "set null" }),
        reviewedBy: text("reviewed_by").references(() => users.id, { onDelete: "set null" }),
        reviewedAt: timestamptz("reviewed_at"),

        createdAt: createdAtColumn(),
        updatedAt: updatedAtColumn(),
    },
    table => [index("tenants_status_idx").on(table.status), index("tenants_created_by_idx").on(table.createdBy)],
);

/** Single-row table of platform-wide switches, editable only by the super admin. */
export const platformSettings = pgTable("platform_settings", {
    id: integer("id").primaryKey().default(1),
    /** SELF_SIGNUP: anyone can sign up and get a tenant. ADMIN_ONLY: tenants come from registration requests and admin invites. */
    tenantOnboardingMode: tenantOnboardingModeEnum("tenant_onboarding_mode")
        .notNull()
        .default(TenantOnboardingMode.SELF_SIGNUP),
    /** Only applies to SELF_SIGNUP: when true, new tenants wait in PENDING_APPROVAL until the super admin approves them. */
    requireTenantApproval: boolean("require_tenant_approval").notNull().default(true),
    maxTenantsPerUser: integer("max_tenants_per_user").notNull().default(5),
    updatedBy: text("updated_by").references(() => users.id, { onDelete: "set null" }),
    updatedAt: updatedAtColumn(),
});

/**
 * The one platform account. Not a role: its permissions are the fixed
 * PLATFORM_PERMISSIONS constant, and the unique index on a constant expression
 * makes a second row impossible.
 */
export const platformAdmins = pgTable(
    "platform_admins",
    {
        userId: text("user_id")
            .primaryKey()
            .references(() => users.id, { onDelete: "cascade" }),
        createdAt: createdAtColumn(),
    },
    () => [uniqueIndex("platform_admins_single_row").on(sql`(true)`)],
);

/**
 * What grants a user access to a tenant. Tenant-owned: RLS applies.
 * `permVersion` lives here (not on users) because roles are per tenant.
 */
export const tenantMemberships = pgTable(
    "tenant_memberships",
    {
        tenantId: text("tenant_id")
            .notNull()
            .references(() => tenants.id, { onDelete: "cascade" }),
        userId: text("user_id")
            .notNull()
            .references(() => users.id, { onDelete: "cascade" }),
        status: membershipStatusEnum("status").notNull().default(MembershipStatus.ACTIVE),
        /** Bumped whenever this member's roles or their permissions change; stale access tokens are rejected. */
        permVersion: integer("perm_version").notNull().default(0),
        joinedAt: timestamptz("joined_at").notNull().defaultNow(),
        createdAt: createdAtColumn(),
        updatedAt: updatedAtColumn(),
    },
    table => [
        primaryKey({ columns: [table.tenantId, table.userId] }),
        index("tenant_memberships_user_id_idx").on(table.userId),
        tenantIsolationPolicy("tenant_memberships"),
    ],
).enableRLS();

export type Tenant = typeof tenants.$inferSelect;
export type PlatformSettings = typeof platformSettings.$inferSelect;
export type TenantMembership = typeof tenantMemberships.$inferSelect;
