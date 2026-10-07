import { boolean, index, integer, pgTable, text, uniqueIndex } from "drizzle-orm/pg-core";
import { randomUUID } from "node:crypto";
import { TenantInvitationStatus, tenantInvitationStatusEnum } from "@/database/schema/enums.js";
import { createdAtColumn, timestamptz, updatedAtColumn } from "@/database/schema/timestamps.js";
import { tenants } from "@/database/schema/tenants.js";
import { users } from "@/database/schema/users.js";

/**
 * The owner invitation of a tenant the super admin created. Global (no RLS): the
 * invitee has no session yet. Only a hash of the emailed link token is stored.
 * One row per tenant; a resend or reminder rotates the token on the same row.
 */
export const tenantInvitations = pgTable(
    "tenant_invitations",
    {
        id: text("id")
            .primaryKey()
            .$defaultFn(() => randomUUID()),
        tenantId: text("tenant_id")
            .notNull()
            .references(() => tenants.id, { onDelete: "cascade" }),
        userId: text("user_id")
            .notNull()
            .references(() => users.id, { onDelete: "cascade" }),
        email: text("email").notNull(),
        tokenHash: text("token_hash").notNull(),
        status: tenantInvitationStatusEnum("status").notNull().default(TenantInvitationStatus.PENDING),
        /** True when the invitation made the account (placeholder password) — only such accounts may be cleaned up. */
        createdAccount: boolean("created_account").notNull(),

        expiresAt: timestamptz("expires_at").notNull(),
        /** Last time any mail went out (first send, resend or reminder); reminders are spaced from it. */
        sentAt: timestamptz("sent_at").notNull().defaultNow(),
        reminderCount: integer("reminder_count").notNull().default(0),
        acceptedAt: timestamptz("accepted_at"),

        createdAt: createdAtColumn(),
        updatedAt: updatedAtColumn(),
    },
    table => [
        uniqueIndex("tenant_invitations_tenant_id_key").on(table.tenantId),
        uniqueIndex("tenant_invitations_token_hash_key").on(table.tokenHash),
        index("tenant_invitations_user_id_idx").on(table.userId),
        index("tenant_invitations_status_sent_at_idx").on(table.status, table.sentAt),
    ],
);

export type TenantInvitation = typeof tenantInvitations.$inferSelect;
