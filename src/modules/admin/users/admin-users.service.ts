import { BadRequestException, ForbiddenException, Injectable, NotFoundException } from "@nestjs/common";
import { SYSTEM_ROLE_IDS } from "@/common/authorization/system-roles.constant.js";
import type { AuthenticatedUser } from "@/common/types/authenticated-request.type.js";
import { InjectDrizzle } from "@nestjs/drizzle";
import { inArray, max } from "drizzle-orm";
import type { Database } from "@/database/database.type.js";
import { roles as rolesTable } from "@/database/schema/authorization.js";
import { AuthService } from "@/modules/auth/auth.service.js";
import { TokensService } from "@/modules/auth/tokens.service.js";
import { PermissionsService } from "@/modules/authorization/permissions.service.js";
import type { AdminUpdateUserInput } from "@/modules/admin/users/dto/admin-update-user.schema.js";
import type { AssignRolesInput } from "@/modules/admin/users/dto/assign-roles.schema.js";
import type { InviteUserInput } from "@/modules/admin/users/dto/invite-user.schema.js";
import type { ListUsersInput } from "@/modules/admin/users/dto/list-users.schema.js";
import { UsersService, type UserWithRoles } from "@/modules/users/users.service.js";
import { toPublicUser } from "@/modules/users/users.mapper.js";
import { paginate } from "@/common/utils/pagination.util.js";

@Injectable()
export class AdminUsersService {
    constructor(
        @InjectDrizzle() private readonly db: Database,
        private readonly usersService: UsersService,
        private readonly tokensService: TokensService,
        private readonly authService: AuthService,
        private readonly permissionsService: PermissionsService,
    ) {}

    async list(actor: AuthenticatedUser, query: ListUsersInput) {
        const { items, total } = await this.usersService.list({
            ...query,
            visibleTo: { actorId: actor.id, maxRank: actor.maxRank },
        });
        return paginate(items.map(toPublicUser), query, total);
    }

    async getById(actor: AuthenticatedUser, targetId: string) {
        const target = await this.findManageableTarget(actor, targetId);
        return toPublicUser(target);
    }

    /**
     * An email change is not an ordinary field edit: the new address is unproven,
     * and it is the address password-reset codes go to. So the account drops back
     * to PENDING_VERIFICATION, existing sessions are cut, and a fresh verification
     * code is sent — otherwise editing this one field would hand over the account.
     */
    async update(actor: AuthenticatedUser, targetId: string, data: AdminUpdateUserInput) {
        const target = await this.findManageableTarget(actor, targetId);
        const emailChanged = data.email !== undefined && data.email !== target.email;

        const updated = await this.usersService.updateByAdmin(target.id, data, {
            resetEmailVerification: emailChanged,
        });

        if (emailChanged) {
            await this.tokensService.revokeAllRefreshTokens(target.id);
            await this.permissionsService.bumpTokenVersion(target.id);
            await this.authService.resendVerification(updated.email);
        }

        return toPublicUser(updated);
    }

    /**
     * Replaces the target's roles wholesale. The actor may only grant roles ranked
     * below their own — otherwise an admin could hand themselves, or a peer, a role
     * they are not allowed to hold, escalating past their own ceiling.
     */
    async assignRoles(actor: AuthenticatedUser, targetId: string, data: AssignRolesInput) {
        const target = await this.findManageableTarget(actor, targetId);

        if (target.id === actor.id) {
            throw new ForbiddenException("You cannot change your own roles");
        }

        const roleIds = [...new Set([SYSTEM_ROLE_IDS.USER, ...data.roleIds])];
        const roles = await this.db.select().from(rolesTable).where(inArray(rolesTable.id, roleIds));

        if (roles.length !== roleIds.length) {
            throw new BadRequestException("One or more roles do not exist");
        }

        const tooHigh = roles.find(role => role.rank >= actor.maxRank);
        if (tooHigh) {
            throw new ForbiddenException(`You cannot grant the "${tooHigh.name}" role`);
        }

        await this.permissionsService.assignRoles(target.id, roleIds, actor.id);

        return toPublicUser(await this.usersService.findByIdOrThrow(target.id));
    }

    async updateStatus(actor: AuthenticatedUser, targetId: string, status: "ACTIVE" | "SUSPENDED") {
        const target = await this.findManageableTarget(actor, targetId);
        const updated = await this.usersService.updateStatus(target.id, status);

        if (status === "SUSPENDED") {
            await this.tokensService.revokeAllRefreshTokens(target.id);
            await this.permissionsService.bumpTokenVersion(target.id);
        } else {
            // Reactivation bumps no version, so the cached principal would keep
            // reporting SUSPENDED — and the guard would keep refusing — until its
            // TTL ran out.
            await this.permissionsService.invalidateCache(target.id);
        }

        return toPublicUser(updated);
    }

    /**
     * Admins cannot delete accounts — only the owner can, and only for
     * themselves. This reverses that self-service deletion on request (support
     * ticket, "I changed my mind"), which is why it is the one place allowed to
     * load a deleted target.
     */
    async restore(actor: AuthenticatedUser, targetId: string) {
        const target = await this.findManageableTarget(actor, targetId, { includeDeleted: true });
        const updated = await this.usersService.restore(target.id);
        await this.permissionsService.invalidateCache(target.id);
        return toPublicUser(updated);
    }

    async triggerPasswordReset(actor: AuthenticatedUser, targetId: string) {
        const target = await this.findManageableTarget(actor, targetId);
        await this.authService.forgotPassword(target.email);
    }

    async listSessions(actor: AuthenticatedUser, targetId: string) {
        const target = await this.findManageableTarget(actor, targetId);
        const sessions = await this.tokensService.listActiveSessions(target.id);
        return sessions.map(({ tokenHash: _tokenHash, ...session }) => session);
    }

    async revokeSession(actor: AuthenticatedUser, targetId: string, sessionId: string) {
        await this.findManageableTarget(actor, targetId);
        await this.tokensService.revokeSessionById(targetId, sessionId);
    }

    async revokeAllSessions(actor: AuthenticatedUser, targetId: string) {
        const target = await this.findManageableTarget(actor, targetId);
        await this.tokensService.revokeAllRefreshTokens(target.id);
        await this.permissionsService.bumpTokenVersion(target.id);
    }

    async invite(actor: AuthenticatedUser, data: InviteUserInput) {
        const roleIds = [...new Set([SYSTEM_ROLE_IDS.USER, ...data.roleIds])];
        const roles = await this.db.select().from(rolesTable).where(inArray(rolesTable.id, roleIds));

        if (roles.length !== roleIds.length) {
            throw new BadRequestException("One or more roles do not exist");
        }

        const tooHigh = roles.find(role => role.rank >= actor.maxRank);
        if (tooHigh) {
            throw new ForbiddenException(`You cannot grant the "${tooHigh.name}" role`);
        }

        return this.authService.invite(data.email, roleIds);
    }

    /**
     * Loads the target and enforces the management hierarchy: an actor may only
     * act on users whose highest rank is strictly below their own. This replaces
     * the old hard-coded "ADMIN may only touch USER" check — the rule now holds
     * for any roles created at runtime, without further code changes.
     */
    private async findManageableTarget(
        actor: AuthenticatedUser,
        targetId: string,
        options: { includeDeleted?: boolean } = {},
    ): Promise<UserWithRoles> {
        const target = await this.usersService.findById(targetId);

        if (!target || (target.deletedAt && !options.includeDeleted)) {
            throw new NotFoundException("User not found");
        }

        if (target.id !== actor.id && (await this.rankOf(target)) >= actor.maxRank) {
            throw new ForbiddenException("You do not have permission to manage this account");
        }

        return target;
    }

    private async rankOf(user: UserWithRoles): Promise<number> {
        if (user.roles.length === 0) {
            return 0;
        }

        const [aggregate] = await this.db
            .select({ rank: max(rolesTable.rank) })
            .from(rolesTable)
            .where(
                inArray(
                    rolesTable.id,
                    user.roles.map(({ roleId }) => roleId),
                ),
            );

        return aggregate?.rank ?? 0;
    }
}
