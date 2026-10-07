import { BadRequestException, ConflictException, Injectable } from "@nestjs/common";
import { InjectDrizzle } from "@nestjs/drizzle";
import { EventEmitter2 } from "@nestjs/event-emitter";
import { and, desc, eq, exists, gte, inArray, notExists, or, sql } from "drizzle-orm";
import { ROLE_SLUGS } from "@/common/authorization/role-templates.constant.js";
import { TenantContext } from "@/common/tenant/tenant-context.js";
import { toLimitOffset } from "@/common/utils/pagination.util.js";
import type { Database, DbClient } from "@/database/database.type.js";
import { membershipRoles, roles } from "@/database/schema/authorization.js";
import { MembershipStatus } from "@/database/schema/enums.js";
import { tenantMemberships, tenants } from "@/database/schema/tenants.js";
import { PermissionsService } from "@/modules/authorization/permissions.service.js";
import { TenantEvents, type MembershipAddedEvent } from "@/modules/tenants/tenant.events.js";
import { UsersService } from "@/modules/users/users.service.js";

export interface MemberSummary {
    userId: string;
    status: MembershipStatus;
    roleIds: string[];
    maxRank: number;
}

/**
 * Who belongs to a tenant and with which roles. Every query takes the tenant
 * explicitly and runs scoped to it, so RLS and the explicit filter agree — a
 * member of tenant A can never be listed, loaded or changed through tenant B.
 */
@Injectable()
export class MembershipsService {
    constructor(
        @InjectDrizzle() private readonly db: Database,
        private readonly tenantContext: TenantContext,
        private readonly permissionsService: PermissionsService,
        private readonly usersService: UsersService,
        private readonly events: EventEmitter2,
    ) {}

    async findRolesBySlugs(tenantId: string, slugs: string[]) {
        return this.tenantContext.runAs(tenantId, () =>
            this.db
                .select()
                .from(roles)
                .where(and(eq(roles.tenantId, tenantId), inArray(roles.slug, slugs))),
        );
    }

    /** Adds `userId` to the tenant with the given roles (the baseline `user` role is always included). */
    async add(tenantId: string, userId: string, slugs: string[], assignedBy?: string): Promise<void> {
        const wanted = [...new Set([ROLE_SLUGS.USER, ...slugs])];
        const found = await this.findRolesBySlugs(tenantId, wanted);

        if (found.length !== wanted.length) {
            throw new BadRequestException("One or more roles do not exist");
        }

        await this.tenantContext.runAs(tenantId, () =>
            this.db.transaction(async tx => {
                const inserted = await tx
                    .insert(tenantMemberships)
                    .values({ tenantId, userId })
                    .onConflictDoNothing()
                    .returning({ userId: tenantMemberships.userId });

                if (inserted.length === 0) {
                    throw new ConflictException({
                        code: "ALREADY_A_MEMBER",
                        message: "This account is already a member of this organization",
                    });
                }

                await this.permissionsService.assignRolesOnCreate(
                    tenantId,
                    userId,
                    found.map(role => role.id),
                    tx,
                    assignedBy,
                );
            }),
        );

        const [tenant] = await this.db.select().from(tenants).where(eq(tenants.id, tenantId));
        const user = await this.usersService.findById(userId);
        if (tenant && user) {
            this.events.emit(TenantEvents.MEMBERSHIP_ADDED, {
                tenant,
                userId,
                userEmail: user.email,
            } satisfies MembershipAddedEvent);
        }
    }

    async get(tenantId: string, userId: string): Promise<MemberSummary | null> {
        const [member] = await this.summaries(tenantId, [userId]);
        return member ?? null;
    }

    /** Role slugs and top rank per member, loaded in one query for a whole page. */
    async summaries(tenantId: string, userIds: string[]): Promise<MemberSummary[]> {
        if (userIds.length === 0) {
            return [];
        }

        return this.tenantContext.runAs(tenantId, async () => {
            const members = await this.db
                .select({ userId: tenantMemberships.userId, status: tenantMemberships.status })
                .from(tenantMemberships)
                .where(and(eq(tenantMemberships.tenantId, tenantId), inArray(tenantMemberships.userId, userIds)));

            const assigned = await this.db
                .select({ userId: membershipRoles.userId, slug: roles.slug, rank: roles.rank })
                .from(membershipRoles)
                .innerJoin(roles, eq(roles.id, membershipRoles.roleId))
                .where(and(eq(membershipRoles.tenantId, tenantId), inArray(membershipRoles.userId, userIds)));

            return members.map(member => {
                const own = assigned.filter(row => row.userId === member.userId);
                return {
                    userId: member.userId,
                    status: member.status,
                    roleIds: own.map(row => row.slug),
                    maxRank: own.reduce((top, row) => Math.max(top, row.rank), 0),
                };
            });
        });
    }

    /**
     * `visibleTo` applies the management hierarchy: an actor sees only members
     * ranked below their own, plus themselves.
     */
    async list(
        tenantId: string,
        params: {
            page: number;
            limit: number;
            search?: string;
            roleSlug?: string;
            status?: MembershipStatus;
            visibleTo: { actorId: string; maxRank: number };
        },
    ): Promise<{ userIds: string[]; total: number }> {
        return this.tenantContext.runAs(tenantId, async () => {
            const outranksActor = this.db
                .select({ one: sql`1` })
                .from(membershipRoles)
                .innerJoin(roles, eq(roles.id, membershipRoles.roleId))
                .where(
                    and(
                        eq(membershipRoles.tenantId, tenantId),
                        eq(membershipRoles.userId, tenantMemberships.userId),
                        gte(roles.rank, params.visibleTo.maxRank),
                    ),
                );

            const hasRole = params.roleSlug
                ? exists(
                      this.db
                          .select({ one: sql`1` })
                          .from(membershipRoles)
                          .innerJoin(roles, eq(roles.id, membershipRoles.roleId))
                          .where(
                              and(
                                  eq(membershipRoles.tenantId, tenantId),
                                  eq(membershipRoles.userId, tenantMemberships.userId),
                                  eq(roles.slug, params.roleSlug),
                              ),
                          ),
                  )
                : undefined;

            const where = and(
                eq(tenantMemberships.tenantId, tenantId),
                or(eq(tenantMemberships.userId, params.visibleTo.actorId), notExists(outranksActor)),
                hasRole,
                params.status ? eq(tenantMemberships.status, params.status) : undefined,
                params.search
                    ? inArray(tenantMemberships.userId, this.usersService.matchingIdsQuery(params.search))
                    : undefined,
            );

            const base = this.db.select({ userId: tenantMemberships.userId }).from(tenantMemberships).where(where);

            const { limit, offset } = toLimitOffset(params);
            const [page, [totals]] = await Promise.all([
                base
                    .orderBy(desc(tenantMemberships.joinedAt), desc(tenantMemberships.userId))
                    .limit(limit)
                    .offset(offset),
                this.db
                    .select({ total: sql<number>`count(*)::int` })
                    .from(tenantMemberships)
                    .where(where),
            ]);

            return { userIds: page.map(row => row.userId), total: totals?.total ?? 0 };
        });
    }

    async setStatus(tenantId: string, userId: string, status: MembershipStatus): Promise<void> {
        await this.tenantContext.runAs(tenantId, () =>
            this.db
                .update(tenantMemberships)
                .set({ status, updatedAt: new Date() })
                .where(and(eq(tenantMemberships.tenantId, tenantId), eq(tenantMemberships.userId, userId))),
        );
        await this.permissionsService.invalidateCache(userId, tenantId);
    }

    /** How many members hold the owner role — the last-owner rule needs this. */
    async countOwners(tenantId: string, client?: DbClient): Promise<number> {
        return this.tenantContext.runAs(tenantId, async () => {
            const [row] = await (client ?? this.db)
                .select({ total: sql<number>`count(*)::int` })
                .from(membershipRoles)
                .innerJoin(roles, eq(roles.id, membershipRoles.roleId))
                .where(and(eq(membershipRoles.tenantId, tenantId), eq(roles.slug, ROLE_SLUGS.OWNER)));
            return row?.total ?? 0;
        });
    }

    /** Owned = holds the owner role. Used to block account deletion while a user is the sole owner. */
    async tenantsWhereSoleOwner(userId: string): Promise<string[]> {
        return this.tenantContext.runAsSystem(async () => {
            const mine = await this.db
                .select({ tenantId: membershipRoles.tenantId })
                .from(membershipRoles)
                .innerJoin(roles, eq(roles.id, membershipRoles.roleId))
                .where(and(eq(membershipRoles.userId, userId), eq(roles.slug, ROLE_SLUGS.OWNER)));

            const sole: string[] = [];
            for (const { tenantId } of mine) {
                if ((await this.countOwners(tenantId)) <= 1) {
                    sole.push(tenantId);
                }
            }
            return sole;
        });
    }

    /** Active membership lookup used when issuing a session — read system-wide because no tenant is chosen yet. */
    findMembership(tenantId: string, userId: string) {
        return this.tenantContext.runAs(tenantId, () =>
            this.db.query.tenantMemberships.findFirst({ where: { tenantId, userId } }),
        );
    }
}
