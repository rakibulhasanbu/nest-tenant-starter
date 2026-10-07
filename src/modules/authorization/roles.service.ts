import { Injectable } from "@nestjs/common";
import { InjectDrizzle } from "@nestjs/drizzle";
import { and, count, eq, inArray } from "drizzle-orm";
import { TenantContext } from "@/common/tenant/tenant-context.js";
import type { Database } from "@/database/database.type.js";
import {
    membershipRoles,
    permissions as permissionsTable,
    rolePermissions,
    roles,
} from "@/database/schema/authorization.js";
import { PermissionLevel } from "@/database/schema/enums.js";
import type { Role } from "@/modules/authorization/role.types.js";

export type RoleWithPermissions = Role & { permissions: { permissionKey: string }[] };

export interface NewRole {
    slug: string;
    name: string;
    description?: string | null;
    rank: number;
    permissions: readonly string[];
}

export interface RolePatch {
    name?: string;
    description?: string | null;
    rank?: number;
    permissions?: readonly string[];
}

/**
 * Where a tenant's roles live. Callers decide who may do what (rank and grant
 * rules are policy); this only reads and writes the rows. Every method takes the
 * tenant explicitly and runs scoped to it, like the rest of the access context.
 */
@Injectable()
export class RolesService {
    constructor(
        @InjectDrizzle() private readonly db: Database,
        private readonly tenantContext: TenantContext,
    ) {}

    listWithPermissions(tenantId: string): Promise<RoleWithPermissions[]> {
        return this.tenantContext.runAs(tenantId, () =>
            this.db.query.roles.findMany({
                where: { tenantId },
                orderBy: { rank: "desc" },
                with: { permissions: { columns: { permissionKey: true } } },
            }),
        );
    }

    async findWithPermissions(tenantId: string, slug: string): Promise<RoleWithPermissions | null> {
        const role = await this.tenantContext.runAs(tenantId, () =>
            this.db.query.roles.findFirst({
                where: { tenantId, slug },
                with: { permissions: { columns: { permissionKey: true } } },
            }),
        );
        return role ?? null;
    }

    async find(tenantId: string, slug: string): Promise<Role | null> {
        const [role] = await this.tenantContext.runAs(tenantId, () =>
            this.db
                .select()
                .from(roles)
                .where(and(eq(roles.tenantId, tenantId), eq(roles.slug, slug)))
                .limit(1),
        );
        return role ?? null;
    }

    /** Members per role id; pass `roleId` to count a single role. */
    async countMembersByRole(tenantId: string, roleId?: string): Promise<Map<string, number>> {
        const rows = await this.tenantContext.runAs(tenantId, () =>
            this.db
                .select({ roleId: membershipRoles.roleId, total: count() })
                .from(membershipRoles)
                .where(
                    and(eq(membershipRoles.tenantId, tenantId), roleId ? eq(membershipRoles.roleId, roleId) : undefined),
                )
                .groupBy(membershipRoles.roleId),
        );
        return new Map(rows.map(row => [row.roleId, row.total]));
    }

    async create(tenantId: string, data: NewRole): Promise<void> {
        await this.tenantContext.runAs(tenantId, () =>
            this.db.transaction(async tx => {
                const [role] = await tx
                    .insert(roles)
                    .values({
                        tenantId,
                        slug: data.slug,
                        name: data.name,
                        description: data.description,
                        rank: data.rank,
                    })
                    .returning({ id: roles.id });

                if (data.permissions.length > 0) {
                    await tx
                        .insert(rolePermissions)
                        .values(data.permissions.map(permissionKey => ({ tenantId, roleId: role!.id, permissionKey })));
                }
            }),
        );
    }

    async update(tenantId: string, roleId: string, patch: RolePatch): Promise<void> {
        await this.tenantContext.runAs(tenantId, () =>
            this.db.transaction(async tx => {
                await tx
                    .update(roles)
                    .set({
                        name: patch.name,
                        description: patch.description,
                        rank: patch.rank,
                        updatedAt: new Date(),
                    })
                    .where(and(eq(roles.id, roleId), eq(roles.tenantId, tenantId)));

                if (patch.permissions) {
                    await tx.delete(rolePermissions).where(eq(rolePermissions.roleId, roleId));

                    if (patch.permissions.length > 0) {
                        await tx
                            .insert(rolePermissions)
                            .values(patch.permissions.map(permissionKey => ({ tenantId, roleId, permissionKey })));
                    }
                }
            }),
        );
    }

    async remove(tenantId: string, roleId: string): Promise<void> {
        await this.tenantContext.runAs(tenantId, () =>
            this.db.delete(roles).where(and(eq(roles.id, roleId), eq(roles.tenantId, tenantId))),
        );
    }

    /** Only tenant-level permissions may live in a tenant's role; a platform key counts as unknown. */
    async allTenantLevelPermissionsExist(keys: readonly string[]): Promise<boolean> {
        const unique = new Set(keys);
        if (unique.size === 0) {
            return true;
        }

        const found = await this.db.$count(
            permissionsTable,
            and(inArray(permissionsTable.key, [...unique]), eq(permissionsTable.level, PermissionLevel.TENANT)),
        );
        return found === unique.size;
    }
}
