import { boolean, date, integer, pgTable, text } from "drizzle-orm/pg-core";
import { randomUUID } from "node:crypto";
import { genderEnum, userStatusEnum, UserStatus } from "@/database/schema/enums.js";
import { createdAtColumn, timestamptz, updatedAtColumn } from "@/database/schema/timestamps.js";

export const users = pgTable("users", {
    id: text("id")
        .primaryKey()
        .$defaultFn(() => randomUUID()),
    email: text("email").notNull().unique(),
    username: text("username").notNull().unique(),
    password: text("password"),
    name: text("name"),
    phone: text("phone"),
    avatarUrl: text("avatar_url"),

    status: userStatusEnum("status").notNull().default(UserStatus.PENDING_VERIFICATION),

    /** Bumped to kill every existing session (password change, global logout). */
    tokenVersion: integer("token_version").notNull().default(0),

    emailVerifiedAt: timestamptz("email_verified_at"),

    failedLoginAttempts: integer("failed_login_attempts").notNull().default(0),
    lockedUntil: timestamptz("locked_until"),

    twoFactorSecret: text("two_factor_secret"),
    twoFactorEnabled: boolean("two_factor_enabled").notNull().default(false),
    twoFactorRecoveryCodes: text("two_factor_recovery_codes").array().notNull().default([]),
    /**
     * Last accepted TOTP time-step. A code stays valid for its whole 30s window,
     * so without remembering the last one accepted, a stolen code can be replayed.
     */
    twoFactorLastUsedStep: integer("two_factor_last_used_step"),

    /**
     * Self-service deletion only — admins suspend, they never delete. The row
     * survives a grace period so the owner can reactivate by email, then the
     * purge job removes it for real and frees the unique email/username.
     */
    deletedAt: timestamptz("deleted_at"),

    createdAt: createdAtColumn(),
    updatedAt: updatedAtColumn(),
});

/**
 * Optional personal details, kept out of `users` so the row loaded on every
 * authenticated request stays small and so this PII can be dropped on its own
 * (account deletion, GDPR erasure) without touching identity or auth state.
 */
export const userProfiles = pgTable("user_profiles", {
    userId: text("user_id")
        .primaryKey()
        .references(() => users.id, { onDelete: "cascade" }),

    /** Calendar date (YYYY-MM-DD), kept as a string so no timezone ever shifts it. */
    dateOfBirth: date("date_of_birth", { mode: "string" }),
    gender: genderEnum("gender"),
    bio: text("bio"),

    createdAt: createdAtColumn(),
    updatedAt: updatedAtColumn(),
});

/**
 * Which notifications the user opted into. Created lazily on first save — a
 * missing row means every channel is still on its default (enabled), which is
 * why the defaults here and in the users service must agree.
 */
export const notificationPreferences = pgTable("notification_preferences", {
    userId: text("user_id")
        .primaryKey()
        .references(() => users.id, { onDelete: "cascade" }),

    loginEmailNotification: boolean("login_email_notification").notNull().default(true),
    transactionsEmailNotification: boolean("transactions_email_notification").notNull().default(true),
    transactionsPushNotification: boolean("transactions_push_notification").notNull().default(true),

    createdAt: createdAtColumn(),
    updatedAt: updatedAtColumn(),
});

export type User = typeof users.$inferSelect;
export type UserProfile = typeof userProfiles.$inferSelect;
