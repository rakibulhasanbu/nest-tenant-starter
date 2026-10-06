import { index, integer, pgTable, text, unique } from "drizzle-orm/pg-core";
import { randomUUID } from "node:crypto";
import { authProviderEnum, emailTokenTypeEnum } from "@/database/schema/enums.js";
import { users } from "@/database/schema/users.js";
import { createdAtColumn, timestamptz } from "@/database/schema/timestamps.js";

const idColumn = () =>
    text("id")
        .primaryKey()
        .$defaultFn(() => randomUUID());

const userIdColumn = () =>
    text("user_id")
        .notNull()
        .references(() => users.id, { onDelete: "cascade" });

export const refreshTokens = pgTable(
    "refresh_tokens",
    {
        id: idColumn(),
        userId: userIdColumn(),
        tokenHash: text("token_hash").notNull().unique(),

        /**
         * The rotation chain this token belongs to: refreshing mints a successor carrying
         * the same family. Presenting an already-revoked token means the chain leaked, so
         * the entire family is revoked rather than just failing the one request.
         */
        familyId: text("family_id").notNull(),

        deviceType: text("device_type"),
        deviceName: text("device_name"),
        userAgent: text("user_agent"),
        ipAddress: text("ip_address"),

        createdAt: createdAtColumn(),
        lastUsedAt: timestamptz("last_used_at").notNull().defaultNow(),
        expiresAt: timestamptz("expires_at").notNull(),
        revokedAt: timestamptz("revoked_at"),
    },
    table => [
        index("refresh_tokens_user_id_idx").on(table.userId),
        index("refresh_tokens_family_id_idx").on(table.familyId),
        index("refresh_tokens_expires_at_idx").on(table.expiresAt),
    ],
);

export const emailTokens = pgTable(
    "email_tokens",
    {
        id: idColumn(),
        userId: userIdColumn(),
        type: emailTokenTypeEnum("type").notNull(),
        codeHash: text("code_hash").notNull(),
        attempts: integer("attempts").notNull().default(0),

        expiresAt: timestamptz("expires_at").notNull(),
        usedAt: timestamptz("used_at"),
        createdAt: createdAtColumn(),
    },
    table => [
        unique("email_tokens_user_id_type_key").on(table.userId, table.type),
        index("email_tokens_expires_at_idx").on(table.expiresAt),
    ],
);

export const socialIdentities = pgTable(
    "social_identities",
    {
        id: idColumn(),
        userId: userIdColumn(),
        provider: authProviderEnum("provider").notNull(),
        providerAccountId: text("provider_account_id").notNull(),
        email: text("email").notNull(),

        createdAt: createdAtColumn(),
    },
    table => [
        unique("social_identities_provider_account_key").on(table.provider, table.providerAccountId),
        // A user gets one identity per provider. Without this, signing in with a
        // second Google account that happens to share the email silently attached a
        // duplicate row, and there is no unlink endpoint to undo it.
        unique("social_identities_user_provider_key").on(table.userId, table.provider),
        index("social_identities_user_id_idx").on(table.userId),
    ],
);

export type RefreshToken = typeof refreshTokens.$inferSelect;
export type SocialIdentity = typeof socialIdentities.$inferSelect;
