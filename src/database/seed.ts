import "dotenv/config";
import * as argon2 from "argon2";
import { and, eq, inArray, notInArray, sql } from "drizzle-orm";
import { drizzle } from "drizzle-orm/node-postgres";
import { Redis } from "ioredis";
import { UserStatus } from "@/database/schema/enums.js";
import { permissions, rolePermissions, roles, userRoles } from "@/database/schema/authorization.js";
import { relations } from "@/database/schema/relations.js";
import { users } from "@/database/schema/users.js";
import { PERMISSION_CATALOG } from "@/common/authorization/permissions.constant.js";
import {
    PERM_CACHE_KEY_PREFIX,
    PERM_INVALIDATE_ALL,
    PERM_INVALIDATION_CHANNEL,
} from "@/common/authorization/permission-cache-keys.constant.js";
import { SYSTEM_ROLES, SYSTEM_ROLE_IDS } from "@/common/authorization/system-roles.constant.js";
import { envSchema } from "@/config/env.schema.js";

type Db = ReturnType<typeof createDb>;

function createDb(connectionString: string) {
    return drizzle({ connection: connectionString, relations });
}

/**
 * Reconciles the permissions table against the catalog declared in code, which
 * is the source of truth. Removing a key from the catalog deletes it here too,
 * cascading to any role that referenced it — so a retired permission cannot
 * linger and keep granting access.
 */
async function syncPermissions(db: Db): Promise<void> {
    for (const permission of PERMISSION_CATALOG) {
        await db
            .insert(permissions)
            .values(permission)
            .onConflictDoUpdate({
                target: permissions.key,
                set: {
                    resource: permission.resource,
                    action: permission.action,
                    scope: permission.scope,
                    description: permission.description,
                },
            });
    }

    const removed = await db
        .delete(permissions)
        .where(
            notInArray(
                permissions.key,
                PERMISSION_CATALOG.map(permission => permission.key),
            ),
        )
        .returning({ key: permissions.key });

    console.log(`Permissions synced: ${PERMISSION_CATALOG.length} current, ${removed.length} removed`);
}

/**
 * Upserts the roles the application itself depends on. Their permission sets are
 * rewritten from code on every run; roles created through the API are untouched.
 *
 * Returns the roles whose permission set actually changed. Bumping permVersion
 * unconditionally invalidated every access token in the system on every run —
 * and since each account carries the `user` role, that meant logging out the
 * entire user base on each deploy, whether or not anything had moved.
 */
async function syncSystemRoles(db: Db): Promise<string[]> {
    const allKeys = PERMISSION_CATALOG.map(permission => permission.key);
    const changedRoleIds: string[] = [];

    for (const definition of SYSTEM_ROLES) {
        const desired = definition.permissions === null ? allKeys : [...definition.permissions];

        const role = {
            name: definition.name,
            description: definition.description,
            rank: definition.rank,
            isSystem: true,
        };

        await db
            .insert(roles)
            .values({ id: definition.id, ...role })
            .onConflictDoUpdate({ target: roles.id, set: { ...role, updatedAt: new Date() } });

        // Read before writing: comparing the stored set with the desired one is
        // what tells us whether anyone's access actually moved. Note this runs
        // after syncPermissions, so keys retired from the catalog have already
        // cascaded out of the table and show up here as a difference.
        const stored = await db
            .select({ permissionKey: rolePermissions.permissionKey })
            .from(rolePermissions)
            .where(eq(rolePermissions.roleId, definition.id));
        const storedKeys = new Set(stored.map(({ permissionKey }) => permissionKey));
        const changed = storedKeys.size !== desired.length || desired.some(permission => !storedKeys.has(permission));

        await db
            .delete(rolePermissions)
            .where(
                desired.length > 0
                    ? and(eq(rolePermissions.roleId, definition.id), notInArray(rolePermissions.permissionKey, desired))
                    : eq(rolePermissions.roleId, definition.id),
            );
        if (desired.length > 0) {
            await db
                .insert(rolePermissions)
                .values(desired.map(permissionKey => ({ roleId: definition.id, permissionKey })))
                .onConflictDoNothing();
        }

        if (changed) {
            changedRoleIds.push(definition.id);
        }

        console.log(`Role ready: ${definition.id} (${desired.length} permissions)${changed ? " — changed" : ""}`);
    }

    return changedRoleIds;
}

/** Invalidates the access tokens of everyone holding a role whose permissions moved. */
async function bumpAffectedUsers(db: Db, roleIds: string[]): Promise<number> {
    if (roleIds.length === 0) {
        return 0;
    }

    const bumped = await db
        .update(users)
        .set({ permVersion: sql`${users.permVersion} + 1` })
        .where(
            inArray(
                users.id,
                db.select({ userId: userRoles.userId }).from(userRoles).where(inArray(userRoles.roleId, roleIds)),
            ),
        )
        .returning({ id: users.id });

    return bumped.length;
}

/**
 * This script writes permVersion straight to the database, behind the back of any
 * running instance. Without clearing what they have cached, every affected user
 * would be locked out until the cache TTL expired — their freshly issued tokens
 * would disagree with the stale cached version. So drop the cache and tell every
 * instance to empty its in-memory copy.
 */
async function flushPermissionCache(redisUrl: string): Promise<void> {
    const redis = new Redis(redisUrl, { lazyConnect: true, maxRetriesPerRequest: 1 });

    try {
        await redis.connect();

        let cursor = "0";
        let removed = 0;

        do {
            const [next, keys] = await redis.scan(cursor, "MATCH", `${PERM_CACHE_KEY_PREFIX}*`, "COUNT", 500);
            cursor = next;
            if (keys.length > 0) {
                removed += await redis.del(...keys);
            }
        } while (cursor !== "0");

        await redis.publish(PERM_INVALIDATION_CHANNEL, PERM_INVALIDATE_ALL);
        console.log(`Permission cache flushed: ${removed} keys removed`);
    } catch (error) {
        console.warn(
            `Could not flush the permission cache (${(error as Error).message}). ` +
                "Running instances will self-correct once their cache TTL expires.",
        );
    } finally {
        redis.disconnect();
    }
}

/**
 * Bootstraps the single super admin from env vars. This is the only way one can
 * ever be created — there is no API path, and a partial unique index on
 * user_roles enforces that at most one account holds the role.
 */
async function seedSuperAdmin(db: Db, email: string, password: string): Promise<boolean> {
    const [existing] = await db
        .select({ email: users.email })
        .from(userRoles)
        .innerJoin(users, eq(users.id, userRoles.userId))
        .where(eq(userRoles.roleId, SYSTEM_ROLE_IDS.SUPER_ADMIN))
        .limit(1);

    if (existing && existing.email !== email) {
        throw new Error(
            `A super admin already exists (${existing.email}). Only one can ever exist; refusing to create another.`,
        );
    }

    const passwordHash = await argon2.hash(password);

    const [user] = await db
        .insert(users)
        .values({
            email,
            username: "superadmin",
            password: passwordHash,
            status: UserStatus.ACTIVE,
            emailVerifiedAt: new Date(),
        })
        .onConflictDoUpdate({
            target: users.email,
            set: { password: passwordHash, status: UserStatus.ACTIVE, updatedAt: new Date() },
        })
        .returning({ id: users.id, email: users.email });

    const granted = await db
        .insert(userRoles)
        .values([
            { userId: user!.id, roleId: SYSTEM_ROLE_IDS.USER },
            { userId: user!.id, roleId: SYSTEM_ROLE_IDS.SUPER_ADMIN },
        ])
        .onConflictDoNothing()
        .returning({ roleId: userRoles.roleId });

    console.log(`Super admin ready: ${user!.email}`);

    // Newly granted roles mean this account's cached permission set is stale.
    return granted.length > 0;
}

async function main() {
    const env = envSchema.parse(process.env);

    const db = createDb(env.DATABASE_URL);

    await syncPermissions(db);
    const changedRoleIds = await syncSystemRoles(db);
    const superAdminChanged = await seedSuperAdmin(db, env.ADMIN_EMAIL, env.ADMIN_PASSWORD);

    const bumped = await bumpAffectedUsers(db, changedRoleIds);
    if (bumped > 0) {
        console.log(`Access tokens invalidated for ${bumped} user(s) whose permissions changed`);
    }

    if (bumped > 0 || superAdminChanged) {
        await flushPermissionCache(env.REDIS_URL);
    } else {
        console.log("Nothing changed — running sessions left alone");
    }

    await db.$client.end();
}

main().catch(error => {
    console.error(error);
    process.exit(1);
});
