import { Injectable } from "@nestjs/common";
import { InjectDrizzle } from "@nestjs/drizzle";
import { and, eq, inArray, notInArray, sql } from "drizzle-orm";
import type { PermissionKey } from "@/common/authorization/permissions.constant.js";
import { TenantContext } from "@/common/tenant/tenant-context.js";
import type { Database, DbClient } from "@/database/database.type.js";
import { membershipRoles } from "@/database/schema/authorization.js";
import { tenantMemberships } from "@/database/schema/tenants.js";
import { PermissionsCacheService } from "@/modules/authorization/permissions-cache.service.js";
import type { PlatformPrincipal, ResolvedPrincipal } from "@/modules/authorization/resolved-principal.type.js";
import { UsersService } from "@/modules/users/users.service.js";

/**
 * Turns (tenant, user) into the permission set the guard authorizes against.
 *
 * Reads go through the cache; writes bump `permVersion` and invalidate it. The
 * two halves are what make the system both fast and safe to revoke from: the
 * cache removes the per-request join, and the version makes any entry the cache
 * failed to drop detectably stale.
 *
 * Every method that touches tenant-owned tables takes the tenant explicitly and
 * runs inside `tenantContext.runAs`, so correctness never depends on the caller
 * having set up the request's tenant first.
 */
@Injectable()
export class PermissionsService {
    constructor(
        @InjectDrizzle() private readonly db: Database,
        private readonly cache: PermissionsCacheService,
        private readonly tenantContext: TenantContext,
        private readonly usersService: UsersService,
    ) {}

    async resolve(tenantId: string, userId: string): Promise<ResolvedPrincipal | null> {
        const cached = await this.cache.get(tenantId, userId);

        if (cached) {
            return cached;
        }

        const principal = await this.tenantContext.runAs(tenantId, () => this.readFromDatabase(tenantId, userId));

        if (principal) {
            await this.cache.set(principal);
        }

        return principal;
    }

    /** The platform principal is two indexed lookups, so it is read fresh rather than cached. */
    async resolvePlatform(userId: string): Promise<PlatformPrincipal | null> {
        const admin = await this.db.query.platformAdmins.findFirst({
            where: { userId },
            with: { user: { columns: { id: true, status: true, deletedAt: true, tokenVersion: true } } },
        });

        if (!admin) {
            return null;
        }

        return {
            userId: admin.user.id,
            status: admin.user.status,
            isDeleted: admin.user.deletedAt !== null,
            tokenVersion: admin.user.tokenVersion,
        };
    }

    /**
     * Drops a cached principal without touching any version marker. Required after
     * any change to status/deletion that does not already bump a version — the
     * guard authorizes against those fields, so a stale entry would keep a
     * reactivated account locked out until the cache TTL expired. Without a
     * tenant, every tenant's entry for the user is dropped.
     */
    async invalidateCache(userId: string, tenantId?: string): Promise<void> {
        await (tenantId ? this.cache.invalidate(tenantId, userId) : this.cache.invalidateUser(userId));
    }

    /**
     * Invalidates every access token this member holds in the tenant, forcing a
     * refresh that picks up their new permissions. Pass `tx` when the role change
     * itself is transactional, so the version can never advance without the change landing.
     */
    async bumpPermVersion(tenantId: string, userId: string, tx?: DbClient): Promise<void> {
        await this.tenantContext.runAs(tenantId, () =>
            (tx ?? this.db)
                .update(tenantMemberships)
                .set({ permVersion: sql`${tenantMemberships.permVersion} + 1` })
                .where(and(eq(tenantMemberships.tenantId, tenantId), eq(tenantMemberships.userId, userId))),
        );
        await this.cache.invalidate(tenantId, userId);
    }

    async bumpPermVersionForRole(tenantId: string, roleId: string): Promise<void> {
        const userIds = await this.tenantContext.runAs(tenantId, async () => {
            const assignments = await this.db
                .select({ userId: membershipRoles.userId })
                .from(membershipRoles)
                .where(and(eq(membershipRoles.tenantId, tenantId), eq(membershipRoles.roleId, roleId)));
            const ids = assignments.map(assignment => assignment.userId);

            if (ids.length > 0) {
                await this.db
                    .update(tenantMemberships)
                    .set({ permVersion: sql`${tenantMemberships.permVersion} + 1` })
                    .where(and(eq(tenantMemberships.tenantId, tenantId), inArray(tenantMemberships.userId, ids)));
            }

            return ids;
        });

        await this.cache.invalidateMany(tenantId, userIds);
    }

    /** Kills every existing session in every tenant — for password changes and global logout. */
    async bumpTokenVersion(userId: string, tx?: DbClient): Promise<void> {
        await this.usersService.bumpTokenVersion(userId, tx);
        await this.cache.invalidateUser(userId);
    }

    /** `roleIds` are role row ids (not slugs) belonging to this tenant. */
    async assignRoles(tenantId: string, userId: string, roleIds: string[], assignedBy: string): Promise<void> {
        await this.tenantContext.runAs(tenantId, () =>
            this.db.transaction(async tx => {
                await tx
                    .delete(membershipRoles)
                    .where(
                        and(
                            eq(membershipRoles.tenantId, tenantId),
                            eq(membershipRoles.userId, userId),
                            notInArray(membershipRoles.roleId, roleIds),
                        ),
                    );
                await tx
                    .insert(membershipRoles)
                    .values(roleIds.map(roleId => ({ tenantId, userId, roleId, assignedBy })))
                    .onConflictDoNothing();
                await tx
                    .update(tenantMemberships)
                    .set({ permVersion: sql`${tenantMemberships.permVersion} + 1` })
                    .where(and(eq(tenantMemberships.tenantId, tenantId), eq(tenantMemberships.userId, userId)));
            }),
        );

        await this.cache.invalidate(tenantId, userId);
    }

    /** Grants roles to a freshly created membership. Runs inside the caller's transaction when given one. */
    async assignRolesOnCreate(
        tenantId: string,
        userId: string,
        roleIds: string[],
        client: DbClient,
        assignedBy?: string,
    ): Promise<void> {
        await client
            .insert(membershipRoles)
            .values(roleIds.map(roleId => ({ tenantId, userId, roleId, assignedBy })))
            .onConflictDoNothing();
    }

    private async readFromDatabase(tenantId: string, userId: string): Promise<ResolvedPrincipal | null> {
        const membership = await this.db.query.tenantMemberships.findFirst({
            where: { tenantId, userId },
            columns: { status: true, permVersion: true },
            with: {
                user: { columns: { id: true, status: true, deletedAt: true, tokenVersion: true } },
                roleAssignments: {
                    columns: {},
                    with: {
                        role: {
                            columns: { slug: true, rank: true },
                            with: { permissions: { columns: { permissionKey: true } } },
                        },
                    },
                },
            },
        });

        if (!membership) {
            return null;
        }

        const permissions = new Set<PermissionKey>();
        let maxRank = 0;

        for (const { role } of membership.roleAssignments) {
            maxRank = Math.max(maxRank, role.rank);
            for (const { permissionKey } of role.permissions) {
                permissions.add(permissionKey as PermissionKey);
            }
        }

        return {
            userId: membership.user.id,
            tenantId,
            status: membership.user.status,
            membershipStatus: membership.status,
            isDeleted: membership.user.deletedAt !== null,
            roleIds: membership.roleAssignments.map(({ role }) => role.slug),
            permissions,
            maxRank,
            permVersion: membership.permVersion,
            tokenVersion: membership.user.tokenVersion,
        };
    }
}
