import { date, index, jsonb, pgTable, text, uniqueIndex } from "drizzle-orm/pg-core";
import { sql } from "drizzle-orm";
import { randomUUID } from "node:crypto";
import { TenantRequestStatus, tenantRequestStatusEnum } from "@/database/schema/enums.js";
import { createdAtColumn, timestamptz, updatedAtColumn } from "@/database/schema/timestamps.js";
import { tenants } from "@/database/schema/tenants.js";
import { users } from "@/database/schema/users.js";

/**
 * What a prospective tenant submits when self signup is off. Global (no RLS):
 * the submitter has no tenant yet. Approving only marks the request; the super
 * admin creates the tenant afterwards, which links `tenantId`.
 */
export const tenantRegistrationRequests = pgTable(
    "tenant_registration_requests",
    {
        id: text("id")
            .primaryKey()
            .$defaultFn(() => randomUUID()),
        businessName: text("business_name").notNull(),
        ownerName: text("owner_name").notNull(),
        email: text("email").notNull(),
        phone: text("phone").notNull(),
        dateOfBirth: date("date_of_birth", { mode: "string" }).notNull(),
        address: text("address").notNull(),
        /** Fields added to the form after launch, so a new question never needs a migration. */
        extra: jsonb("extra").$type<Record<string, string | number | boolean>>().notNull().default({}),

        status: tenantRequestStatusEnum("status").notNull().default(TenantRequestStatus.PENDING),
        rejectionReason: text("rejection_reason"),
        reviewedBy: text("reviewed_by").references(() => users.id, { onDelete: "set null" }),
        reviewedAt: timestamptz("reviewed_at"),
        /** Set once the super admin has created the tenant for this request. */
        tenantId: text("tenant_id").references(() => tenants.id, { onDelete: "set null" }),

        createdAt: createdAtColumn(),
        updatedAt: updatedAtColumn(),
    },
    table => [
        index("tenant_registration_requests_status_idx").on(table.status),
        // One waiting request per address; a rejected one can be resubmitted.
        uniqueIndex("tenant_registration_requests_pending_email_idx")
            .on(sql`lower(${table.email})`)
            .where(sql`${table.status} = 'PENDING'`),
    ],
);

export type TenantRegistrationRequest = typeof tenantRegistrationRequests.$inferSelect;
