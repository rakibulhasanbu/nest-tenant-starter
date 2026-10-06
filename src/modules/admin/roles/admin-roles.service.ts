import {
    BadRequestException,
    ConflictException,
    ForbiddenException,
    Injectable,
    NotFoundException,
} from "@nestjs/common";
import { PERMISSION_CATALOG } from "@/common/authorization/permissions.constant.js";
import type { AuthenticatedUser } from "@/common/types/authenticated-request.type.js";
import { InjectDrizzle } from "@nestjs/drizzle";
import { count, eq, inArray } from "drizzle-orm";
import type { Database } from "@/database/database.type.js";
import { permissions as permissionsTable, rolePermissions, roles, userRoles } from "@/database/schema/authorization.js";
import { PermissionsService } from "@/modules/authorization/permissions.service.js";
import type { CreateRoleInput } from "@/modules/admin/roles/dto/create-role.schema.js";
import type { UpdateRoleInput } from "@/modules/admin/roles/dto/update-role.schema.js";

@Injectable()
export class AdminRolesService {
    constructor(
        @InjectDrizzle() private readonly db: Database,
        private readonly permissionsService: PermissionsService,
    ) {}

    /** The catalog is served from code, not the table — the table only mirrors it. */
    listPermissions() {
        return PERMISSION_CATALOG;
    }

    async list() {
        const found = await this.db.query.roles.findMany({
            orderBy: { rank: "desc" },
            with: { permissions: { columns: { permissionKey: true } } },
        });
        const counts = await this.countUsersByRole();

        return found.map(({ permissions, ...role }) => ({
            ...role,
            permissions: permissions.map(({ permissionKey }) => permissionKey),
            userCount: counts.get(role.id) ?? 0,
        }));
    }

    async getById(id: string) {
        const role = await this.db.query.roles.findFirst({
            where: { id },
            with: { permissions: { columns: { permissionKey: true } } },
        });

        if (!role) {
            throw new NotFoundException("Role not found");
        }

        const { permissions, ...rest } = role;
        return {
            ...rest,
            permissions: permissions.map(({ permissionKey }) => permissionKey),
            userCount: (await this.countUsersByRole(id)).get(id) ?? 0,
        };
    }

    private async countUsersByRole(roleId?: string): Promise<Map<string, number>> {
        const rows = await this.db
            .select({ roleId: userRoles.roleId, total: count() })
            .from(userRoles)
            .where(roleId ? eq(userRoles.roleId, roleId) : undefined)
            .groupBy(userRoles.roleId);

        return new Map(rows.map(row => [row.roleId, row.total]));
    }

    async create(actor: AuthenticatedUser, data: CreateRoleInput) {
        this.assertRankBelowActor(actor, data.rank);
        this.assertGrantable(actor, data.permissions);

        if (await this.findRole(data.id)) {
            throw new ConflictException("A role with this id already exists");
        }

        await this.assertPermissionsExist(data.permissions);

        await this.db.transaction(async tx => {
            await tx.insert(roles).values({
                id: data.id,
                name: data.name,
                description: data.description,
                rank: data.rank,
            });

            if (data.permissions.length > 0) {
                await tx
                    .insert(rolePermissions)
                    .values(data.permissions.map(permissionKey => ({ roleId: data.id, permissionKey })));
            }
        });

        return this.getById(data.id);
    }

    async update(actor: AuthenticatedUser, id: string, data: UpdateRoleInput) {
        const role = await this.findRole(id);

        if (!role) {
            throw new NotFoundException("Role not found");
        }

        // System roles keep their identity and rank — code depends on both — but their
        // permission sets stay editable, which is the whole point of storing them.
        if (role.isSystem && (data.name !== undefined || data.rank !== undefined)) {
            throw new ForbiddenException("A system role's name and rank cannot be changed");
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
                .where(eq(roles.id, id));

            if (data.permissions) {
                await tx.delete(rolePermissions).where(eq(rolePermissions.roleId, id));

                if (data.permissions.length > 0) {
                    await tx
                        .insert(rolePermissions)
                        .values(data.permissions.map(permissionKey => ({ roleId: id, permissionKey })));
                }
            }
        });

        // Everyone holding this role now has a different permission set, so every
        // access token they hold must be treated as stale.
        await this.permissionsService.bumpPermVersionForRole(id);

        return this.getById(id);
    }

    async remove(actor: AuthenticatedUser, id: string) {
        const role = await this.findRole(id);

        if (!role) {
            throw new NotFoundException("Role not found");
        }

        if (role.isSystem) {
            throw new ForbiddenException("A system role cannot be deleted");
        }

        this.assertManageableRole(actor, role);

        if ((await this.countUsersByRole(id)).get(id)) {
            throw new ConflictException("Remove this role from all users before deleting it");
        }

        await this.db.delete(roles).where(eq(roles.id, id));
    }

    /**
     * Which existing roles an actor may touch.
     *
     * A role the actor holds is always editable: `assertGrantable` already caps
     * its contents at what the actor themselves has, so this cannot lift their
     * own ceiling. Requiring a strictly lower rank here instead left the super
     * admin — rank 100, holding the rank-100 role — unable to edit the one role
     * they own, even though the permission set is meant to stay editable.
     *
     * Every other role must still sit strictly below them.
     */
    private assertManageableRole(actor: AuthenticatedUser, role: { id: string; rank: number }): void {
        if (actor.roleIds.includes(role.id)) {
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

    private async findRole(id: string) {
        const [role] = await this.db.select().from(roles).where(eq(roles.id, id)).limit(1);
        return role;
    }

    private async assertPermissionsExist(permissions: readonly string[]): Promise<void> {
        if (permissions.length === 0) {
            return;
        }

        const found = await this.db.$count(permissionsTable, inArray(permissionsTable.key, [...permissions]));

        if (found !== new Set(permissions).size) {
            throw new BadRequestException("One or more permissions do not exist");
        }
    }
}
