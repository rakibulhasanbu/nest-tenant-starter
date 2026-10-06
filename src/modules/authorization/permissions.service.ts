import { Injectable } from "@nestjs/common";
import type { PermissionKey } from "@/common/authorization/permissions.constant.js";
import { InjectDrizzle } from "@nestjs/drizzle";
import { and, eq, inArray, notInArray, sql } from "drizzle-orm";
import type { Database, DbClient } from "@/database/database.type.js";
import { userRoles } from "@/database/schema/authorization.js";
import { users } from "@/database/schema/users.js";
import { PermissionsCacheService } from "@/modules/authorization/permissions-cache.service.js";
import type { ResolvedPrincipal } from "@/modules/authorization/resolved-principal.type.js";

/**
 * Turns a user id into the permission set the guard authorizes against.
 *
 * Reads go through the cache; writes bump `permVersion` and invalidate it. The
 * two halves are what make the system both fast and safe to revoke from: the
 * cache removes the per-request join, and the version makes any entry the cache
 * failed to drop detectably stale.
 */
@Injectable()
export class PermissionsService {
    constructor(
        @InjectDrizzle() private readonly db: Database,
        private readonly cache: PermissionsCacheService,
    ) {}

    async resolve(userId: string): Promise<ResolvedPrincipal | null> {
        const cached = await this.cache.get(userId);

        if (cached) {
            return cached;
        }

        const principal = await this.readFromDatabase(userId);

        if (principal) {
            await this.cache.set(principal);
        }

        return principal;
    }

    /**
     * Drops this user's cached principal without touching any version marker.
     * Required after any change to `status` or `deletedAt` that does not already
     * bump a version — the guard now authorizes against those fields, so a stale
     * entry would keep a reactivated account locked out (or, after a restore,
     * keep reporting it as deleted) until the cache TTL expired.
     */
    async invalidateCache(userId: string): Promise<void> {
        await this.cache.invalidate(userId);
    }

    /**
     * Invalidates every access token this user holds, forcing a refresh that
     * picks up their new permissions. Pass `tx` when the role change itself is
     * transactional, so the version can never advance without the change landing.
     */
    async bumpPermVersion(userId: string, tx?: DbClient): Promise<void> {
        await (tx ?? this.db)
            .update(users)
            .set({ permVersion: sql`${users.permVersion} + 1` })
            .where(eq(users.id, userId));
        await this.cache.invalidate(userId);
    }

    async bumpPermVersionForRole(roleId: string): Promise<void> {
        const assignments = await this.db
            .select({ userId: userRoles.userId })
            .from(userRoles)
            .where(eq(userRoles.roleId, roleId));
        const userIds = assignments.map(assignment => assignment.userId);

        if (userIds.length === 0) {
            return;
        }

        await this.db
            .update(users)
            .set({ permVersion: sql`${users.permVersion} + 1` })
            .where(inArray(users.id, userIds));
        await this.cache.invalidateMany(userIds);
    }

    /** Kills every existing session outright — for password changes and global logout. */
    async bumpTokenVersion(userId: string, tx?: DbClient): Promise<void> {
        await (tx ?? this.db)
            .update(users)
            .set({ tokenVersion: sql`${users.tokenVersion} + 1` })
            .where(eq(users.id, userId));
        await this.cache.invalidate(userId);
    }

    async assignRoles(userId: string, roleIds: string[], assignedBy: string): Promise<void> {
        await this.db.transaction(async tx => {
            await tx.delete(userRoles).where(and(eq(userRoles.userId, userId), notInArray(userRoles.roleId, roleIds)));
            await tx
                .insert(userRoles)
                .values(roleIds.map(roleId => ({ userId, roleId, assignedBy })))
                .onConflictDoNothing();
            await tx
                .update(users)
                .set({ permVersion: sql`${users.permVersion} + 1` })
                .where(eq(users.id, userId));
        });

        await this.cache.invalidate(userId);
    }

    /** Grants the baseline role to a freshly created account. Runs inside the caller's transaction when given one. */
    async assignRolesOnCreate(userId: string, roleIds: string[], client: DbClient): Promise<void> {
        await client
            .insert(userRoles)
            .values(roleIds.map(roleId => ({ userId, roleId })))
            .onConflictDoNothing();
    }

    private async readFromDatabase(userId: string): Promise<ResolvedPrincipal | null> {
        const user = await this.db.query.users.findFirst({
            where: { id: userId },
            columns: { id: true, status: true, deletedAt: true, permVersion: true, tokenVersion: true },
            with: {
                roles: {
                    columns: {},
                    with: {
                        role: {
                            columns: { id: true, rank: true },
                            with: { permissions: { columns: { permissionKey: true } } },
                        },
                    },
                },
            },
        });

        if (!user) {
            return null;
        }

        const permissions = new Set<PermissionKey>();
        let maxRank = 0;

        for (const { role } of user.roles) {
            maxRank = Math.max(maxRank, role.rank);
            for (const { permissionKey } of role.permissions) {
                permissions.add(permissionKey as PermissionKey);
            }
        }

        return {
            userId: user.id,
            status: user.status,
            isDeleted: user.deletedAt !== null,
            roleIds: user.roles.map(({ role }) => role.id),
            permissions,
            maxRank,
            permVersion: user.permVersion,
            tokenVersion: user.tokenVersion,
        };
    }
}
