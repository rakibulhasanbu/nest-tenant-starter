import { index, jsonb, pgTable, text } from "drizzle-orm/pg-core";
import { randomUUID } from "node:crypto";
import { tenantIsolationPolicy } from "@/database/schema/rls.js";
import { createdAtColumn } from "@/database/schema/timestamps.js";
import { tenants } from "@/database/schema/tenants.js";
import { users } from "@/database/schema/users.js";

/**
 * Who did what, to what, in which tenant. Append-only: the app's database role
 * has no UPDATE or DELETE on it (see `setup-roles.ts`), so a row that was written
 * cannot be edited or removed through the application.
 *
 * `tenant_id` is null for platform-level actions (the super admin, system jobs);
 * those rows match no tenant's RLS policy, so a tenant can never see them.
 */
export const auditLogs = pgTable(
    "audit_logs",
    {
        id: text("id")
            .primaryKey()
            .$defaultFn(() => randomUUID()),
        tenantId: text("tenant_id").references(() => tenants.id, { onDelete: "cascade" }),
        /** Null for the system itself; also null once the user's account is gone. */
        actorId: text("actor_id").references(() => users.id, { onDelete: "set null" }),
        action: text("action").notNull(),
        targetType: text("target_type"),
        targetId: text("target_id"),
        metadata: jsonb("metadata").$type<Record<string, unknown>>().notNull().default({}),
        /** Ties the row to the request's log lines. */
        requestId: text("request_id"),
        createdAt: createdAtColumn(),
    },
    table => [
        index("audit_logs_tenant_created_idx").on(table.tenantId, table.createdAt),
        index("audit_logs_action_idx").on(table.action),
        index("audit_logs_actor_idx").on(table.actorId),
        tenantIsolationPolicy("audit_logs"),
    ],
).enableRLS();

export type AuditLog = typeof auditLogs.$inferSelect;
