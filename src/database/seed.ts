import "dotenv/config";
import * as argon2 from "argon2";
import { and, eq, inArray, notInArray, sql } from "drizzle-orm";
import { drizzle } from "drizzle-orm/node-postgres";
import { Redis } from "ioredis";
import { TenantStatus, UserStatus } from "@/database/schema/enums.js";
import { membershipRoles, permissions, rolePermissions, roles } from "@/database/schema/authorization.js";
import { relations } from "@/database/schema/relations.js";
import { platformAdmins, platformSettings, tenantMemberships, tenants } from "@/database/schema/tenants.js";
import { users } from "@/database/schema/users.js";
import { PERMISSION_CATALOG } from "@/common/authorization/permissions.constant.js";
import { ROLE_SLUGS, ROLE_TEMPLATES } from "@/common/authorization/role-templates.constant.js";
import {
    PERM_CACHE_KEY_PREFIX,
    PERM_INVALIDATE_ALL,
    PERM_INVALIDATION_CHANNEL,
} from "@/common/authorization/permission-cache-keys.constant.js";
import { envSchema } from "@/config/env.schema.js";

type Db = ReturnType<typeof createDb>;

/**
 * The seed runs as the table owner (DATABASE_ADMIN_URL), which is not subject to
 * row-level security: it legitimately works across every tenant, and none of it
 * goes through the app's tenant-scoped connection.
 */
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
                    level: permission.level,
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

/** The single settings row. Existing values are never overwritten — they belong to the super admin. */
async function ensurePlatformSettings(db: Db): Promise<void> {
    await db.insert(platformSettings).values({ id: 1 }).onConflictDoNothing();
    console.log("Platform settings ready");
}

/**
 * The `owner` role means "everything", so it follows the catalog: any tenant-level
 * permission added in code reaches every tenant's owners on the next seed. Other
 * roles are tenant-edited data and are deliberately left alone.
 *
 * Returns the tenants whose owners gained or lost something, so only their
 * members' tokens are invalidated.
 */
async function syncOwnerRoles(db: Db): Promise<string[]> {
    const ownerTemplate = ROLE_TEMPLATES.find(template => template.slug === ROLE_SLUGS.OWNER)!;
    const desired = new Set<string>(ownerTemplate.permissions);
    const ownerRoles = await db
        .select({ id: roles.id, tenantId: roles.tenantId })
        .from(roles)
        .where(eq(roles.slug, ROLE_SLUGS.OWNER));
    const changedTenants: string[] = [];

    for (const role of ownerRoles) {
        const stored = await db
            .select({ permissionKey: rolePermissions.permissionKey })
            .from(rolePermissions)
            .where(eq(rolePermissions.roleId, role.id));
        const storedKeys = new Set(stored.map(row => row.permissionKey));
        const missing = [...desired].filter(key => !storedKeys.has(key));

        if (missing.length === 0 && storedKeys.size === desired.size) {
            continue;
        }

        await db
            .insert(rolePermissions)
            .values(missing.map(permissionKey => ({ tenantId: role.tenantId, roleId: role.id, permissionKey })))
            .onConflictDoNothing();
        changedTenants.push(role.tenantId);
    }

    console.log(
        `Owner roles reconciled across ${ownerRoles.length} tenant(s)${changedTenants.length ? ` — ${changedTenants.length} changed` : ""}`,
    );
    return changedTenants;
}

/** Invalidates the access tokens of owners in tenants whose owner role moved. */
async function bumpOwners(db: Db, tenantIds: string[]): Promise<number> {
    if (tenantIds.length === 0) {
        return 0;
    }

    const bumped = await db
        .update(tenantMemberships)
        .set({ permVersion: sql`${tenantMemberships.permVersion} + 1` })
        .where(
            and(
                inArray(tenantMemberships.tenantId, tenantIds),
                sql`exists (
                    select 1 from ${membershipRoles}
                    inner join ${roles} on ${roles.id} = ${membershipRoles.roleId}
                    where ${membershipRoles.tenantId} = ${tenantMemberships.tenantId}
                      and ${membershipRoles.userId} = ${tenantMemberships.userId}
                      and ${roles.slug} = ${ROLE_SLUGS.OWNER}
                )`,
            ),
        )
        .returning({ userId: tenantMemberships.userId });

    return bumped.length;
}

/**
 * Bootstraps the single super admin from env vars. This is the only way one can
 * ever be created — there is no API path, and a unique index on platform_admins
 * makes a second row impossible.
 */
async function seedSuperAdmin(db: Db, email: string, password: string): Promise<boolean> {
    const [existing] = await db
        .select({ email: users.email })
        .from(platformAdmins)
        .innerJoin(users, eq(users.id, platformAdmins.userId))
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

    const granted = await db.insert(platformAdmins).values({ userId: user!.id }).onConflictDoNothing().returning();

    console.log(`Super admin ready: ${user!.email}`);
    return granted.length > 0;
}

/**
 * Optional local-dev convenience (`pnpm db:seed --demo`): one ACTIVE tenant with
 * an owner, so the API can be exercised without going through signup + approval.
 */
async function seedDemoTenant(db: Db, password: string): Promise<void> {
    const slug = "demo-org";
    const ownerEmail = "demo-owner@example.com";
    const passwordHash = await argon2.hash(password);

    const [owner] = await db
        .insert(users)
        .values({
            email: ownerEmail,
            username: "demo-owner",
            password: passwordHash,
            status: UserStatus.ACTIVE,
            emailVerifiedAt: new Date(),
        })
        .onConflictDoUpdate({ target: users.email, set: { password: passwordHash, updatedAt: new Date() } })
        .returning({ id: users.id });

    const [existing] = await db.select({ id: tenants.id }).from(tenants).where(eq(tenants.slug, slug));
    if (existing) {
        console.log(`Demo tenant already present: ${slug}`);
        return;
    }

    await db.transaction(async tx => {
        const [tenant] = await tx
            .insert(tenants)
            .values({ slug, name: "Demo Organization", status: TenantStatus.ACTIVE, createdBy: owner!.id })
            .returning({ id: tenants.id });
        const tenantId = tenant!.id;

        const roleIds: Record<string, string> = {};
        for (const template of ROLE_TEMPLATES) {
            const [role] = await tx
                .insert(roles)
                .values({
                    tenantId,
                    slug: template.slug,
                    name: template.name,
                    description: template.description,
                    rank: template.rank,
                    isSystem: true,
                })
                .returning({ id: roles.id });
            roleIds[template.slug] = role!.id;

            if (template.permissions.length > 0) {
                await tx
                    .insert(rolePermissions)
                    .values(template.permissions.map(permissionKey => ({ tenantId, roleId: role!.id, permissionKey })));
            }
        }

        await tx.insert(tenantMemberships).values({ tenantId, userId: owner!.id });
        await tx.insert(membershipRoles).values([
            { tenantId, userId: owner!.id, roleId: roleIds[ROLE_SLUGS.OWNER]! },
            { tenantId, userId: owner!.id, roleId: roleIds[ROLE_SLUGS.USER]! },
        ]);
    });

    console.log(`Demo tenant ready: ${slug} (owner ${ownerEmail})`);
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
            const cacheKeys = keys.filter(key => key !== PERM_INVALIDATION_CHANNEL);
            if (cacheKeys.length > 0) {
                removed += await redis.del(...cacheKeys);
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

async function main() {
    const env = envSchema.parse(process.env);
    const db = createDb(env.DATABASE_ADMIN_URL ?? env.DATABASE_URL);

    await syncPermissions(db);
    await ensurePlatformSettings(db);
    const changedTenants = await syncOwnerRoles(db);
    const superAdminChanged = await seedSuperAdmin(db, env.ADMIN_EMAIL, env.ADMIN_PASSWORD);

    if (process.argv.includes("--demo")) {
        await seedDemoTenant(db, env.ADMIN_PASSWORD);
    }

    const bumped = await bumpOwners(db, changedTenants);
    if (bumped > 0) {
        console.log(`Access tokens invalidated for ${bumped} owner(s) whose permissions changed`);
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
