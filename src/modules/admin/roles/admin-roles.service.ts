import {
    BadRequestException,
    ConflictException,
    ForbiddenException,
    Injectable,
    NotFoundException,
} from "@nestjs/common";
import { InjectDrizzle } from "@nestjs/drizzle";
import { and, count, eq, inArray } from "drizzle-orm";
import { PERMISSION_CATALOG } from "@/common/authorization/permissions.constant.js";
import { ROLE_SLUGS } from "@/common/authorization/role-templates.constant.js";
import type { AuthenticatedUser } from "@/common/types/authenticated-request.type.js";
import type { Database } from "@/database/database.type.js";
import {
    membershipRoles,
    permissions as permissionsTable,
    rolePermissions,
    roles,
    type Role,
} from "@/database/schema/authorization.js";
import { PermissionLevel } from "@/database/schema/enums.js";
import { PermissionsService } from "@/modules/authorization/permissions.service.js";
import type { CreateRoleInput } from "@/modules/admin/roles/dto/create-role.schema.js";
import type { UpdateRoleInput } from "@/modules/admin/roles/dto/update-role.schema.js";

/**
 * Role management for the current organization. Roles are per tenant, and the
 * API addresses them by slug ("admin") — the tenant is implicit from the
 * caller's session — so the contract is identical to the single-tenant one.
 */
@Injectable()
export class AdminRolesService {
    constructor(
        @InjectDrizzle() private readonly db: Database,
        private readonly permissionsService: PermissionsService,
    ) {}

    /** The catalog is served from code, not the table. Platform permissions are never offered to a tenant. */
    listPermissions() {
        return PERMISSION_CATALOG.filter(permission => permission.level === PermissionLevel.TENANT);
    }

    async list(actor: AuthenticatedUser) {
        const tenantId = this.tenantOf(actor);
        const found = await this.db.query.roles.findMany({
            where: { tenantId },
            orderBy: { rank: "desc" },
            with: { permissions: { columns: { permissionKey: true } } },
        });
        const counts = await this.countUsersByRole(tenantId);

        return found.map(role => this.toView(role, role.permissions, counts.get(role.id) ?? 0));
    }

    async getBySlug(actor: AuthenticatedUser, slug: string) {
        const tenantId = this.tenantOf(actor);
        const role = await this.db.query.roles.findFirst({
            where: { tenantId, slug },
            with: { permissions: { columns: { permissionKey: true } } },
        });

        if (!role) {
            throw new NotFoundException("Role not found");
        }

        const counts = await this.countUsersByRole(tenantId, role.id);
        return this.toView(role, role.permissions, counts.get(role.id) ?? 0);
    }

    private toView(role: Role, permissions: { permissionKey: string }[], userCount: number) {
        const { id: _rowId, tenantId: _tenantId, slug, ...rest } = role;
        return { id: slug, ...rest, permissions: permissions.map(({ permissionKey }) => permissionKey), userCount };
    }

    private async countUsersByRole(tenantId: string, roleId?: string): Promise<Map<string, number>> {
        const rows = await this.db
            .select({ roleId: membershipRoles.roleId, total: count() })
            .from(membershipRoles)
            .where(and(eq(membershipRoles.tenantId, tenantId), roleId ? eq(membershipRoles.roleId, roleId) : undefined))
            .groupBy(membershipRoles.roleId);

        return new Map(rows.map(row => [row.roleId, row.total]));
    }

    async create(actor: AuthenticatedUser, data: CreateRoleInput) {
        const tenantId = this.tenantOf(actor);
        this.assertRankBelowActor(actor, data.rank);
        this.assertGrantable(actor, data.permissions);

        if (await this.findRole(tenantId, data.id)) {
            throw new ConflictException("A role with this id already exists");
        }

        await this.assertPermissionsExist(data.permissions);

        await this.db.transaction(async tx => {
            const [role] = await tx
                .insert(roles)
                .values({
                    tenantId,
                    slug: data.id,
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
        });

        return this.getBySlug(actor, data.id);
    }

    async update(actor: AuthenticatedUser, slug: string, data: UpdateRoleInput) {
        const tenantId = this.tenantOf(actor);
        const role = await this.findRole(tenantId, slug);

        if (!role) {
            throw new NotFoundException("Role not found");
        }

        // System roles keep their identity and rank — code depends on both — but their
        // permission sets stay editable, which is the whole point of storing them.
        if (role.isSystem && (data.name !== undefined || data.rank !== undefined)) {
            throw new ForbiddenException("A system role's name and rank cannot be changed");
        }

        if (role.slug === ROLE_SLUGS.OWNER && data.permissions) {
            throw new ForbiddenException("The owner role always holds every permission");
        }

        this.assertManageableRole(actor, role);

        if (data.rank !== undefined) {
            this.assertRankBelowActor(actor, data.rank);
        }

        if (data.permissions) {
            this.assertGrantable(actor, data.permissions);
            await this.assertPermissionsExist(data.permissions);
        }

        await this.db.transaction(async tx => {
            await tx
                .update(roles)
                .set({ name: data.name, description: data.description, rank: data.rank, updatedAt: new Date() })
                .where(and(eq(roles.id, role.id), eq(roles.tenantId, tenantId)));

            if (data.permissions) {
                await tx.delete(rolePermissions).where(eq(rolePermissions.roleId, role.id));

                if (data.permissions.length > 0) {
                    await tx
                        .insert(rolePermissions)
                        .values(data.permissions.map(permissionKey => ({ tenantId, roleId: role.id, permissionKey })));
                }
            }
        });

        // Everyone holding this role now has a different permission set, so every
        // access token they hold must be treated as stale.
        await this.permissionsService.bumpPermVersionForRole(tenantId, role.id);

        return this.getBySlug(actor, slug);
    }

    async remove(actor: AuthenticatedUser, slug: string) {
        const tenantId = this.tenantOf(actor);
        const role = await this.findRole(tenantId, slug);

        if (!role) {
            throw new NotFoundException("Role not found");
        }

        if (role.isSystem) {
            throw new ForbiddenException("A system role cannot be deleted");
        }

        this.assertManageableRole(actor, role);

        if ((await this.countUsersByRole(tenantId, role.id)).get(role.id)) {
            throw new ConflictException("Remove this role from all users before deleting it");
        }

        await this.db.delete(roles).where(and(eq(roles.id, role.id), eq(roles.tenantId, tenantId)));
    }

    /**
     * Which existing roles an actor may touch.
     *
     * A role the actor holds is always editable: `assertGrantable` already caps
     * its contents at what the actor themselves has, so this cannot lift their
     * own ceiling. Every other role must sit strictly below them.
     */
    private assertManageableRole(actor: AuthenticatedUser, role: { slug: string; rank: number }): void {
        if (actor.roleIds.includes(role.slug)) {
            return;
        }

        this.assertRankBelowActor(actor, role.rank);
    }

    /**
     * Nobody may create a role, or move one, to at or above their own rank —
     * otherwise an admin could mint a role outranking themselves and assign it onward.
     */
    private assertRankBelowActor(actor: AuthenticatedUser, rank: number): void {
        if (rank >= actor.maxRank) {
            throw new ForbiddenException("You cannot manage a role ranked at or above your own");
        }
    }

    /**
     * Nobody may put a permission into a role that they do not themselves hold —
     * without this, role editing is a direct privilege-escalation path.
     */
    private assertGrantable(actor: AuthenticatedUser, permissions: readonly string[]): void {
        const ungrantable = permissions.filter(permission => !actor.permissions.has(permission as never));

        if (ungrantable.length > 0) {
            throw new ForbiddenException(`You cannot grant permissions you do not hold: ${ungrantable.join(", ")}`);
        }
    }

    private async findRole(tenantId: string, slug: string) {
        const [role] = await this.db
            .select()
            .from(roles)
            .where(and(eq(roles.tenantId, tenantId), eq(roles.slug, slug)))
            .limit(1);
        return role;
    }

    /** Only tenant-level permissions may live in a tenant's role; a platform key is rejected like an unknown one. */
    private async assertPermissionsExist(permissions: readonly string[]): Promise<void> {
        if (permissions.length === 0) {
            return;
        }

        const found = await this.db.$count(
            permissionsTable,
            and(inArray(permissionsTable.key, [...permissions]), eq(permissionsTable.level, PermissionLevel.TENANT)),
        );

        if (found !== new Set(permissions).size) {
            throw new BadRequestException("One or more permissions do not exist");
        }
    }

    private tenantOf(actor: AuthenticatedUser): string {
        if (!actor.tenantId) {
            throw new ForbiddenException("This route needs an organization context");
        }
        return actor.tenantId;
    }
}
