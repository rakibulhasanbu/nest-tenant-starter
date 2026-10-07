import { Injectable, NotFoundException } from "@nestjs/common";
import { InjectDrizzle } from "@nestjs/drizzle";
import { and, eq, ilike, isNull, lt, or, sql } from "drizzle-orm";
import type { Database, DbClient } from "@/database/database.type.js";
import { Gender, UserStatus } from "@/database/schema/enums.js";
import { notificationPreferences, userProfiles, users, type User, type UserProfile } from "@/database/schema/users.js";
import type { UpdateNotificationPreferencesInput } from "@/modules/users/dto/update-notification-preferences.schema.js";

/**
 * The optional profile travels with every user this service returns so callers
 * never need a second query to render it. Users are global identities: roles
 * belong to a tenant membership and are looked up per tenant, never here.
 */
export type UserWithProfile = User & {
    profile: UserProfile | null;
};

const withProfile = { profile: true } as const;

export interface CreateUserData {
    email: string;
    passwordHash?: string;
    name?: string;
    phone?: string;
    status?: UserStatus;
    emailVerifiedAt?: Date;
}

/** Personal details that live on `user_profiles`, not on the account row. */
export interface UpdateUserProfileData {
    dateOfBirth?: string;
    gender?: Gender;
    bio?: string;
}

export interface UpdateProfileData {
    name?: string;
    username?: string;
    phone?: string;
    avatarUrl?: string;
    profile?: UpdateUserProfileData;
}

export interface NotificationPreferences {
    loginEmailNotification: boolean;
    transactionsEmailNotification: boolean;
    transactionsPushNotification: boolean;
}

/** What a user without a saved row gets — must match the column defaults in schema/users.ts. */
const DEFAULT_NOTIFICATION_PREFERENCES: NotificationPreferences = {
    loginEmailNotification: true,
    transactionsEmailNotification: true,
    transactionsPushNotification: true,
};

const notificationPreferencesColumns = {
    loginEmailNotification: notificationPreferences.loginEmailNotification,
    transactionsEmailNotification: notificationPreferences.transactionsEmailNotification,
    transactionsPushNotification: notificationPreferences.transactionsPushNotification,
};

@Injectable()
export class UsersService {
    constructor(@InjectDrizzle() private readonly db: Database) {}

    async findByEmail(email: string): Promise<UserWithProfile | null> {
        return (await this.db.query.users.findFirst({ where: { email }, with: withProfile })) ?? null;
    }

    async findById(id: string): Promise<UserWithProfile | null> {
        return (await this.db.query.users.findFirst({ where: { id }, with: withProfile })) ?? null;
    }

    async findByIdOrThrow(id: string): Promise<UserWithProfile> {
        const user = await this.findById(id);

        if (!user) {
            throw new NotFoundException("User not found");
        }

        return user;
    }

    /** Loads several users in one query, keyed by id — for assembling a page of members. */
    async findManyByIds(ids: string[]): Promise<Map<string, UserWithProfile>> {
        if (ids.length === 0) {
            return new Map();
        }

        const found = await this.db.query.users.findMany({ where: { id: { in: ids } }, with: withProfile });
        return new Map(found.map(user => [user.id, user]));
    }

    /**
     * A subquery of user ids whose email, username or name contain `term`, for another
     * module to filter its own rows with (`inArray(col, subquery)`) without importing
     * the `users` table. It stays one SQL statement, so paging and counts remain exact.
     */
    matchingIdsQuery(term: string) {
        const pattern = `%${term.replace(/[\\%_]/g, "\\$&")}%`;
        return this.db
            .select({ id: users.id })
            .from(users)
            .where(or(ilike(users.email, pattern), ilike(users.username, pattern), ilike(users.name, pattern)));
    }

    /** Invalidates every access token the user holds, in every tenant. Pass `tx` to land it with a larger change. */
    async bumpTokenVersion(id: string, tx?: DbClient): Promise<void> {
        await (tx ?? this.db)
            .update(users)
            .set({ tokenVersion: sql`${users.tokenVersion} + 1` })
            .where(eq(users.id, id));
    }

    async findActiveById(id: string): Promise<UserWithProfile | null> {
        const user = await this.findById(id);
        return user && !user.deletedAt ? user : null;
    }

    /**
     * Creates the global identity only. Access comes from a tenant membership,
     * which the caller creates (signup makes a tenant, an invite adds a membership).
     */
    async createUser(data: CreateUserData): Promise<UserWithProfile> {
        const username = await this.generateUniqueUsername(data.email);

        const [created] = await this.db
            .insert(users)
            .values({
                email: data.email,
                username,
                password: data.passwordHash,
                name: data.name,
                phone: data.phone,
                status: data.status,
                emailVerifiedAt: data.emailVerifiedAt,
            })
            .returning({ id: users.id });

        return this.findByIdOrThrow(created!.id);
    }

    /** Derives a unique handle from the email local-part, suffixing on collision. */
    private async generateUniqueUsername(email: string): Promise<string> {
        const base =
            email
                .split("@")[0]!
                .toLowerCase()
                .replace(/[^a-z0-9_.]/g, "")
                .slice(0, 25) || "user";

        let candidate = base;
        let suffix = 1;

        while (await this.usernameExists(candidate)) {
            suffix += 1;
            candidate = `${base}${suffix}`;
        }

        return candidate;
    }

    private async usernameExists(username: string): Promise<boolean> {
        const [row] = await this.db.select({ id: users.id }).from(users).where(eq(users.username, username)).limit(1);
        return row !== undefined;
    }

    /**
     * Applies `values` to one user and returns the refreshed record. `updatedAt`
     * is always written so an update with nothing to change is still valid SQL.
     */
    private async updateUser(id: string, values: Partial<typeof users.$inferInsert>): Promise<UserWithProfile> {
        const [updated] = await this.db
            .update(users)
            .set({ ...values, updatedAt: new Date() })
            .where(eq(users.id, id))
            .returning({ id: users.id });

        if (!updated) {
            throw new NotFoundException("User not found");
        }

        return this.findByIdOrThrow(id);
    }

    /**
     * Promotes PENDING_VERIFICATION to ACTIVE, and only that. A SUSPENDED account
     * must stay suspended: this runs at the end of the email-verification and
     * password-reset flows, so unconditionally writing ACTIVE would turn either
     * flow into a way for a suspended user to lift their own suspension.
     */
    async markEmailVerified(id: string): Promise<UserWithProfile> {
        const current = await this.findByIdOrThrow(id);

        return this.updateUser(id, {
            emailVerifiedAt: new Date(),
            status: current.status === UserStatus.PENDING_VERIFICATION ? UserStatus.ACTIVE : undefined,
        });
    }

    setPassword(id: string, passwordHash: string): Promise<UserWithProfile> {
        return this.updateUser(id, { password: passwordHash });
    }

    /**
     * Account fields and profile fields land in two tables, so the profile row is
     * upserted: it is created lazily the first time a user fills anything in.
     */
    async updateProfile(id: string, data: UpdateProfileData): Promise<UserWithProfile> {
        const { profile, ...account } = data;

        await this.findByIdOrThrow(id);

        await this.db.transaction(async tx => {
            await tx
                .update(users)
                .set({ ...account, updatedAt: new Date() })
                .where(eq(users.id, id));

            if (profile) {
                const fields = {
                    gender: profile.gender,
                    bio: profile.bio,
                    dateOfBirth: profile.dateOfBirth,
                };

                await tx
                    .insert(userProfiles)
                    .values({ userId: id, ...fields })
                    .onConflictDoUpdate({ target: userProfiles.userId, set: { ...fields, updatedAt: new Date() } });
            }
        });

        return this.findByIdOrThrow(id);
    }

    async getNotificationPreferences(userId: string): Promise<NotificationPreferences> {
        const [preferences] = await this.db
            .select(notificationPreferencesColumns)
            .from(notificationPreferences)
            .where(eq(notificationPreferences.userId, userId))
            .limit(1);

        return preferences ?? DEFAULT_NOTIFICATION_PREFERENCES;
    }

    /** Upserted because the row only exists once the user has saved preferences at least once. */
    async updateNotificationPreferences(
        userId: string,
        data: UpdateNotificationPreferencesInput,
    ): Promise<NotificationPreferences> {
        const [saved] = await this.db
            .insert(notificationPreferences)
            .values({ userId, ...data })
            .onConflictDoUpdate({
                target: notificationPreferences.userId,
                set: { ...data, updatedAt: new Date() },
            })
            .returning(notificationPreferencesColumns);

        return saved!;
    }

    async recordFailedLogin(id: string, maxAttempts: number, lockoutMinutes: number): Promise<UserWithProfile> {
        const user = await this.findByIdOrThrow(id);
        const attempts = user.failedLoginAttempts + 1;
        const shouldLock = attempts >= maxAttempts;

        return this.updateUser(id, {
            failedLoginAttempts: shouldLock ? 0 : attempts,
            lockedUntil: shouldLock ? new Date(Date.now() + lockoutMinutes * 60 * 1000) : user.lockedUntil,
        });
    }

    resetFailedLogin(id: string): Promise<UserWithProfile> {
        return this.updateUser(id, { failedLoginAttempts: 0, lockedUntil: null });
    }

    updateStatus(id: string, status: UserStatus): Promise<UserWithProfile> {
        return this.updateUser(id, { status });
    }

    softDelete(id: string): Promise<UserWithProfile> {
        return this.updateUser(id, { deletedAt: new Date() });
    }

    restore(id: string): Promise<UserWithProfile> {
        return this.updateUser(id, { deletedAt: null });
    }

    /**
     * Hard-deletes an account that never proved its email — the placeholder an owner
     * invitation creates. Refuses (returns false) once the address is verified, so a
     * person who has actually used the account can never be removed this way.
     */
    async deleteIfUnverified(id: string, tx?: DbClient): Promise<boolean> {
        const deleted = await (tx ?? this.db)
            .delete(users)
            .where(and(eq(users.id, id), isNull(users.emailVerifiedAt)))
            .returning({ id: users.id });
        return deleted.length > 0;
    }

    /**
     * Hard-deletes soft-deleted users whose grace period has expired, which is
     * also what frees their unique email and username for reuse. Cascades take
     * the profile, roles, tokens and identities with them — any table added
     * later that must outlive the account (orders, audit rows) has to either
     * detach from `users` or be anonymized here instead.
     */
    async purgeExpiredDeleted(graceDays: number): Promise<number> {
        const cutoff = new Date(Date.now() - graceDays * 24 * 60 * 60 * 1000);
        const deleted = await this.db.delete(users).where(lt(users.deletedAt, cutoff)).returning({ id: users.id });
        return deleted.length;
    }
}
