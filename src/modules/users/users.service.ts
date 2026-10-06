import { Injectable, NotFoundException } from "@nestjs/common";
import { InjectDrizzle } from "@nestjs/drizzle";
import { and, desc, eq, exists, gte, ilike, isNotNull, isNull, lt, notExists, or, sql } from "drizzle-orm";
import { SYSTEM_ROLE_IDS } from "@/common/authorization/system-roles.constant.js";
import { toLimitOffset } from "@/common/utils/pagination.util.js";
import type { Database } from "@/database/database.type.js";
import { Gender, UserStatus } from "@/database/schema/enums.js";
import { notificationPreferences, userProfiles, users, type User, type UserProfile } from "@/database/schema/users.js";
import { roles, userRoles } from "@/database/schema/authorization.js";
import type { UpdateNotificationPreferencesInput } from "@/modules/users/dto/update-notification-preferences.schema.js";

/**
 * Role ids and the optional profile travel with every user this service returns
 * so callers never have to issue a second query to render or authorize against them.
 */
export type UserWithRoles = User & {
    roles: { roleId: string }[];
    profile: UserProfile | null;
};

const withRoles = { roles: { columns: { roleId: true } }, profile: true } as const;

export interface CreateUserData {
    email: string;
    passwordHash?: string;
    name?: string;
    phone?: string;
    /** Extra roles on top of the baseline `user` role every account receives. */
    roleIds?: string[];
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

    async findByEmail(email: string): Promise<UserWithRoles | null> {
        return (await this.db.query.users.findFirst({ where: { email }, with: withRoles })) ?? null;
    }

    async findById(id: string): Promise<UserWithRoles | null> {
        return (await this.db.query.users.findFirst({ where: { id }, with: withRoles })) ?? null;
    }

    async findByIdOrThrow(id: string): Promise<UserWithRoles> {
        const user = await this.findById(id);

        if (!user) {
            throw new NotFoundException("User not found");
        }

        return user;
    }

    async findActiveById(id: string): Promise<UserWithRoles | null> {
        const user = await this.findById(id);
        return user && !user.deletedAt ? user : null;
    }

    /**
     * Every account gets the baseline `user` role, created in the same transaction
     * so an account can never exist without a role — a roleless user would resolve
     * to an empty permission set and silently fail every authorization check.
     */
    async createUser(data: CreateUserData): Promise<UserWithRoles> {
        const username = await this.generateUniqueUsername(data.email);
        const roleIds = [...new Set([SYSTEM_ROLE_IDS.USER, ...(data.roleIds ?? [])])];

        const userId = await this.db.transaction(async tx => {
            const [created] = await tx
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

            await tx.insert(userRoles).values(roleIds.map(roleId => ({ userId: created!.id, roleId })));

            return created!.id;
        });

        return this.findByIdOrThrow(userId);
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
    private async updateUser(id: string, values: Partial<typeof users.$inferInsert>): Promise<UserWithRoles> {
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
    async markEmailVerified(id: string): Promise<UserWithRoles> {
        const current = await this.findByIdOrThrow(id);

        return this.updateUser(id, {
            emailVerifiedAt: new Date(),
            status: current.status === UserStatus.PENDING_VERIFICATION ? UserStatus.ACTIVE : undefined,
        });
    }

    setPassword(id: string, passwordHash: string): Promise<UserWithRoles> {
        return this.updateUser(id, { password: passwordHash });
    }

    /**
     * Account fields and profile fields land in two tables, so the profile row is
     * upserted: it is created lazily the first time a user fills anything in.
     */
    async updateProfile(id: string, data: UpdateProfileData): Promise<UserWithRoles> {
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

    async recordFailedLogin(id: string, maxAttempts: number, lockoutMinutes: number): Promise<UserWithRoles> {
        const user = await this.findByIdOrThrow(id);
        const attempts = user.failedLoginAttempts + 1;
        const shouldLock = attempts >= maxAttempts;

        return this.updateUser(id, {
            failedLoginAttempts: shouldLock ? 0 : attempts,
            lockedUntil: shouldLock ? new Date(Date.now() + lockoutMinutes * 60 * 1000) : user.lockedUntil,
        });
    }

    resetFailedLogin(id: string): Promise<UserWithRoles> {
        return this.updateUser(id, { failedLoginAttempts: 0, lockedUntil: null });
    }

    /**
     * `visibleTo` applies the same rule the single-record admin routes enforce: an
     * actor sees only accounts ranked below their own, plus themselves. Without it
     * the list happily returned the super admin to any admin who asked, while
     * fetching that same account by id answered 403.
     */
    async list(params: {
        page: number;
        limit: number;
        search?: string;
        roleId?: string;
        status?: UserStatus;
        deleted?: boolean;
        visibleTo: { actorId: string; maxRank: number };
    }): Promise<{ items: UserWithRoles[]; total: number }> {
        const outranksActor = this.db
            .select({ one: sql`1` })
            .from(userRoles)
            .innerJoin(roles, eq(roles.id, userRoles.roleId))
            .where(and(eq(userRoles.userId, users.id), gte(roles.rank, params.visibleTo.maxRank)));

        const hasRole = params.roleId
            ? exists(
                  this.db
                      .select({ one: sql`1` })
                      .from(userRoles)
                      .where(and(eq(userRoles.userId, users.id), eq(userRoles.roleId, params.roleId))),
              )
            : undefined;

        const pattern = params.search ? `%${escapeLike(params.search)}%` : undefined;

        const where = and(
            params.deleted ? isNotNull(users.deletedAt) : isNull(users.deletedAt),
            or(eq(users.id, params.visibleTo.actorId), notExists(outranksActor)),
            hasRole,
            params.status ? eq(users.status, params.status) : undefined,
            pattern
                ? or(ilike(users.email, pattern), ilike(users.username, pattern), ilike(users.name, pattern))
                : undefined,
        );

        const [page, total] = await Promise.all([
            this.db
                .select({ id: users.id })
                .from(users)
                .where(where)
                .orderBy(desc(users.createdAt), desc(users.id))
                .limit(toLimitOffset(params).limit)
                .offset(toLimitOffset(params).offset),
            this.db.$count(users, where),
        ]);

        if (page.length === 0) {
            return { items: [], total };
        }

        const loaded = await this.db.query.users.findMany({
            where: { id: { in: page.map(({ id }) => id) } },
            with: withRoles,
        });
        const byId = new Map(loaded.map(user => [user.id, user]));

        return { items: page.map(({ id }) => byId.get(id)!), total };
    }

    /**
     * `resetEmailVerification` is set when the email address itself changed: the
     * new address is unproven, and leaving `emailVerifiedAt` in place would treat
     * it as confirmed — including for password-reset delivery.
     */
    updateByAdmin(
        id: string,
        data: Partial<Pick<User, "name" | "username" | "email" | "phone" | "avatarUrl">>,
        options: { resetEmailVerification?: boolean } = {},
    ): Promise<UserWithRoles> {
        return this.updateUser(id, {
            ...data,
            ...(options.resetEmailVerification
                ? { emailVerifiedAt: null, status: UserStatus.PENDING_VERIFICATION }
                : {}),
        });
    }

    updateStatus(id: string, status: UserStatus): Promise<UserWithRoles> {
        return this.updateUser(id, { status });
    }

    softDelete(id: string): Promise<UserWithRoles> {
        return this.updateUser(id, { deletedAt: new Date() });
    }

    restore(id: string): Promise<UserWithRoles> {
        return this.updateUser(id, { deletedAt: null });
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

/** `%` and `_` in a search term are literals, not wildcards. */
function escapeLike(term: string): string {
    return term.replace(/[\\%_]/g, "\\$&");
}
