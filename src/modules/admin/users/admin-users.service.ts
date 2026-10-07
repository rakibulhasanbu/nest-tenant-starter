import {
    BadRequestException,
    ConflictException,
    ForbiddenException,
    Injectable,
    NotFoundException,
} from "@nestjs/common";
import { ROLE_SLUGS } from "@/common/authorization/role-templates.constant.js";
import type { AuthenticatedUser } from "@/common/types/authenticated-request.type.js";
import { paginate } from "@/common/utils/pagination.util.js";
import type { Role } from "@/database/schema/authorization.js";
import { MembershipStatus } from "@/database/schema/enums.js";
import { AuthService } from "@/modules/auth/auth.service.js";
import { TokensService } from "@/modules/auth/tokens.service.js";
import { PermissionsService } from "@/modules/authorization/permissions.service.js";
import type { AssignRolesInput } from "@/modules/admin/users/dto/assign-roles.schema.js";
import type { InviteUserInput } from "@/modules/admin/users/dto/invite-user.schema.js";
import type { ListUsersInput } from "@/modules/admin/users/dto/list-users.schema.js";
import { MembershipsService, type MemberSummary } from "@/modules/tenants/memberships.service.js";
import { toPublicUser } from "@/modules/users/users.mapper.js";
import { UsersService, type UserWithProfile } from "@/modules/users/users.service.js";

/**
 * Member management for the *current* organization. Users are global identities,
 * so everything here acts on a membership: an organization's admin can change a
 * member's roles, suspend their access here, and see their sessions here — but
 * can never edit the account itself (email, password, name), restore it, or touch
 * what they do in other organizations.
 */
@Injectable()
export class AdminUsersService {
    constructor(
        private readonly usersService: UsersService,
        private readonly membershipsService: MembershipsService,
        private readonly tokensService: TokensService,
        private readonly authService: AuthService,
        private readonly permissionsService: PermissionsService,
    ) {}

    async list(actor: AuthenticatedUser, query: ListUsersInput) {
        const tenantId = this.tenantOf(actor);
        const { userIds, total } = await this.membershipsService.list(tenantId, {
            page: query.page,
            limit: query.limit,
            search: query.search,
            roleSlug: query.roleId,
            status: query.status,
            visibleTo: { actorId: actor.id, maxRank: actor.maxRank },
        });

        const [users, summaries] = await Promise.all([
            this.usersService.findManyByIds(userIds),
            this.membershipsService.summaries(tenantId, userIds),
        ]);
        const byId = new Map(summaries.map(summary => [summary.userId, summary]));

        const items = userIds.flatMap(id => {
            const user = users.get(id);
            const member = byId.get(id);
            return user && member ? [this.toMemberView(user, member)] : [];
        });

        return paginate(items, query, total);
    }

    async getById(actor: AuthenticatedUser, targetId: string) {
        const { user, member } = await this.findManageableTarget(actor, targetId);
        return this.toMemberView(user, member);
    }

    /**
     * Replaces the target's roles wholesale. The actor may only grant roles ranked
     * below their own — otherwise an admin could hand themselves, or a peer, a role
     * they are not allowed to hold. The one carve-out is `owner`: an owner may grant
     * and revoke it, which is how ownership is handed over. The last owner can never
     * be removed.
     */
    async assignRoles(actor: AuthenticatedUser, targetId: string, data: AssignRolesInput) {
        const tenantId = this.tenantOf(actor);
        const actorIsOwner = actor.roleIds.includes(ROLE_SLUGS.OWNER);
        const { user, member } = await this.findManageableTarget(actor, targetId, { allowOwnerPeer: actorIsOwner });

        if (user.id === actor.id) {
            throw new ForbiddenException("You cannot change your own roles");
        }

        const slugs = [...new Set([ROLE_SLUGS.USER, ...data.roleIds])];
        const roles = await this.membershipsService.findRolesBySlugs(tenantId, slugs);

        if (roles.length !== slugs.length) {
            throw new BadRequestException("One or more roles do not exist");
        }

        const ungrantable = roles.find(role => !this.canGrant(actor, role));
        if (ungrantable) {
            throw new ForbiddenException(`You cannot grant the "${ungrantable.name}" role`);
        }

        const losingOwner = member.roleIds.includes(ROLE_SLUGS.OWNER) && !slugs.includes(ROLE_SLUGS.OWNER);
        if (losingOwner && (await this.membershipsService.countOwners(tenantId)) <= 1) {
            throw new ConflictException({
                code: "LAST_OWNER",
                message: "An organization must keep at least one owner",
            });
        }

        await this.permissionsService.assignRoles(
            tenantId,
            user.id,
            roles.map(role => role.id),
            actor.id,
        );

        const updated = await this.membershipsService.get(tenantId, user.id);
        return this.toMemberView(user, updated!);
    }

    /** Suspending removes the member's access to *this* organization only; their account and other memberships are untouched. */
    async updateStatus(actor: AuthenticatedUser, targetId: string, status: MembershipStatus) {
        const tenantId = this.tenantOf(actor);
        const { user, member } = await this.findManageableTarget(actor, targetId);

        if (user.id === actor.id) {
            throw new ForbiddenException("You cannot change your own status");
        }

        if (status === MembershipStatus.SUSPENDED) {
            if (
                member.roleIds.includes(ROLE_SLUGS.OWNER) &&
                (await this.membershipsService.countOwners(tenantId)) <= 1
            ) {
                throw new ConflictException({
                    code: "LAST_OWNER",
                    message: "An organization must keep at least one owner",
                });
            }
            await this.tokensService.revokeAllRefreshTokens(user.id, tenantId);
        }

        // setStatus drops the cached principal, and the guard reads the membership
        // status from it, so the change takes effect on the member's next request.
        await this.membershipsService.setStatus(tenantId, user.id, status);

        const updated = await this.membershipsService.get(tenantId, user.id);
        return this.toMemberView(user, updated!);
    }

    async triggerPasswordReset(actor: AuthenticatedUser, targetId: string) {
        const { user } = await this.findManageableTarget(actor, targetId);
        await this.authService.forgotPassword(user.email);
    }

    async listSessions(actor: AuthenticatedUser, targetId: string) {
        const { user } = await this.findManageableTarget(actor, targetId);
        const sessions = await this.tokensService.listActiveSessions(user.id, this.tenantOf(actor));
        return sessions.map(({ tokenHash: _tokenHash, ...session }) => session);
    }

    async revokeSession(actor: AuthenticatedUser, targetId: string, sessionId: string) {
        await this.findManageableTarget(actor, targetId);
        await this.tokensService.revokeSessionById(targetId, sessionId, this.tenantOf(actor));
    }

    async revokeAllSessions(actor: AuthenticatedUser, targetId: string) {
        const { user } = await this.findManageableTarget(actor, targetId);
        // Only this organization's sessions: the member's other organizations are none of this admin's business.
        await this.tokensService.revokeAllRefreshTokens(user.id, this.tenantOf(actor));
        await this.permissionsService.bumpPermVersion(this.tenantOf(actor), user.id);
    }

    async invite(actor: AuthenticatedUser, data: InviteUserInput) {
        const tenantId = this.tenantOf(actor);
        const slugs = [...new Set([ROLE_SLUGS.USER, ...data.roleIds])];
        const roles = await this.membershipsService.findRolesBySlugs(tenantId, slugs);

        if (roles.length !== slugs.length) {
            throw new BadRequestException("One or more roles do not exist");
        }

        const ungrantable = roles.find(role => !this.canGrant(actor, role));
        if (ungrantable) {
            throw new ForbiddenException(`You cannot grant the "${ungrantable.name}" role`);
        }

        return this.authService.invite(tenantId, actor.id, data.email, slugs);
    }

    private canGrant(actor: AuthenticatedUser, role: Role): boolean {
        return (
            role.rank < actor.maxRank || (role.slug === ROLE_SLUGS.OWNER && actor.roleIds.includes(ROLE_SLUGS.OWNER))
        );
    }

    private tenantOf(actor: AuthenticatedUser): string {
        if (!actor.tenantId) {
            throw new ForbiddenException("This route needs an organization context");
        }
        return actor.tenantId;
    }

    private toMemberView(user: UserWithProfile, member: MemberSummary) {
        return { ...toPublicUser(user, member.roleIds), membershipStatus: member.status };
    }

    /**
     * Loads the target *as a member of this organization* and enforces the
     * management hierarchy: an actor may only act on members whose highest rank is
     * strictly below their own. A user who is not a member here simply does not
     * exist as far as this tenant is concerned — 404, never 403.
     */
    private async findManageableTarget(
        actor: AuthenticatedUser,
        targetId: string,
        options: { allowOwnerPeer?: boolean } = {},
    ): Promise<{ user: UserWithProfile; member: MemberSummary }> {
        const tenantId = this.tenantOf(actor);
        const member = await this.membershipsService.get(tenantId, targetId);
        const user = member ? await this.usersService.findActiveById(targetId) : null;

        if (!member || !user) {
            throw new NotFoundException("User not found");
        }

        const peerOwner = options.allowOwnerPeer && member.roleIds.includes(ROLE_SLUGS.OWNER);
        if (user.id !== actor.id && !peerOwner && member.maxRank >= actor.maxRank) {
            throw new ForbiddenException("You do not have permission to manage this account");
        }

        return { user, member };
    }
}
