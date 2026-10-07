import {
    BadRequestException,
    ConflictException,
    ForbiddenException,
    Injectable,
    NotFoundException,
} from "@nestjs/common";
import { EventEmitter2 } from "@nestjs/event-emitter";
import { PERMISSION_CATALOG } from "@/common/authorization/permissions.constant.js";
import { ROLE_SLUGS } from "@/common/authorization/role-templates.constant.js";
import type { AuthenticatedUser } from "@/common/types/authenticated-request.type.js";
import { PermissionLevel } from "@/database/schema/enums.js";
import { AccessEvents, type RoleChangedEvent } from "@/modules/authorization/access.events.js";
import { PermissionsService } from "@/modules/authorization/permissions.service.js";
import type { Role } from "@/modules/authorization/role.types.js";
import { RolesService } from "@/modules/authorization/roles.service.js";
import type { CreateRoleInput } from "@/modules/admin/roles/dto/create-role.schema.js";
import type { UpdateRoleInput } from "@/modules/admin/roles/dto/update-role.schema.js";

/**
 * Role management for the current organization. Roles are per tenant, and the
 * API addresses them by slug ("admin") — the tenant is implicit from the
 * caller's session — so the contract is identical to the single-tenant one.
 * The rules about who may touch which role live here; the rows live in RolesService.
 */
@Injectable()
export class AdminRolesService {
    constructor(
        private readonly rolesService: RolesService,
        private readonly permissionsService: PermissionsService,
        private readonly events: EventEmitter2,
    ) {}

    /** The catalog is served from code, not the table. Platform permissions are never offered to a tenant. */
    listPermissions() {
        return PERMISSION_CATALOG.filter(permission => permission.level === PermissionLevel.TENANT);
    }

    async list(actor: AuthenticatedUser) {
        const tenantId = this.tenantOf(actor);
        const found = await this.rolesService.listWithPermissions(tenantId);
        const counts = await this.rolesService.countMembersByRole(tenantId);

        return found.map(role => this.toView(role, role.permissions, counts.get(role.id) ?? 0));
    }

    async getBySlug(actor: AuthenticatedUser, slug: string) {
        const tenantId = this.tenantOf(actor);
        const role = await this.rolesService.findWithPermissions(tenantId, slug);

        if (!role) {
            throw new NotFoundException("Role not found");
        }

        const counts = await this.rolesService.countMembersByRole(tenantId, role.id);
        return this.toView(role, role.permissions, counts.get(role.id) ?? 0);
    }

    private toView(role: Role, permissions: { permissionKey: string }[], userCount: number) {
        const { id: _rowId, tenantId: _tenantId, slug, ...rest } = role;
        return { id: slug, ...rest, permissions: permissions.map(({ permissionKey }) => permissionKey), userCount };
    }

    async create(actor: AuthenticatedUser, data: CreateRoleInput) {
        const tenantId = this.tenantOf(actor);
        this.assertRankBelowActor(actor, data.rank);
        this.assertGrantable(actor, data.permissions);

        if (await this.rolesService.find(tenantId, data.id)) {
            throw new ConflictException("A role with this id already exists");
        }

        await this.assertPermissionsExist(data.permissions);

        await this.rolesService.create(tenantId, {
            slug: data.id,
            name: data.name,
            description: data.description,
            rank: data.rank,
            permissions: data.permissions,
        });
        this.events.emit(AccessEvents.ROLE_CREATED, {
            tenantId,
            actorId: actor.id,
            roleSlug: data.id,
            changes: { rank: data.rank, permissions: data.permissions },
        } satisfies RoleChangedEvent);

        return this.getBySlug(actor, data.id);
    }

    async update(actor: AuthenticatedUser, slug: string, data: UpdateRoleInput) {
        const tenantId = this.tenantOf(actor);
        const role = await this.rolesService.find(tenantId, slug);

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

        await this.rolesService.update(tenantId, role.id, data);

        // Everyone holding this role now has a different permission set, so every
        // access token they hold must be treated as stale.
        await this.permissionsService.bumpPermVersionForRole(tenantId, role.id);
        this.events.emit(AccessEvents.ROLE_UPDATED, {
            tenantId,
            actorId: actor.id,
            roleSlug: slug,
            changes: { ...data },
        } satisfies RoleChangedEvent);

        return this.getBySlug(actor, slug);
    }

    async remove(actor: AuthenticatedUser, slug: string) {
        const tenantId = this.tenantOf(actor);
        const role = await this.rolesService.find(tenantId, slug);

        if (!role) {
            throw new NotFoundException("Role not found");
        }

        if (role.isSystem) {
            throw new ForbiddenException("A system role cannot be deleted");
        }

        this.assertManageableRole(actor, role);

        if ((await this.rolesService.countMembersByRole(tenantId, role.id)).get(role.id)) {
            throw new ConflictException("Remove this role from all users before deleting it");
        }

        await this.rolesService.remove(tenantId, role.id);
        this.events.emit(AccessEvents.ROLE_DELETED, {
            tenantId,
            actorId: actor.id,
            roleSlug: slug,
        } satisfies RoleChangedEvent);
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

    private async assertPermissionsExist(permissions: readonly string[]): Promise<void> {
        if (!(await this.rolesService.allTenantLevelPermissionsExist(permissions))) {
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
