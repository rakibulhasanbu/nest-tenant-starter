import {
    BadRequestException,
    ConflictException,
    ForbiddenException,
    Injectable,
    Logger,
    NotFoundException,
    type OnModuleInit,
} from "@nestjs/common";
import { ConfigService } from "@nestjs/config";
import { InjectDrizzle } from "@nestjs/drizzle";
import { EventEmitter2 } from "@nestjs/event-emitter";
import { and, count, desc, eq, ilike, ne, or } from "drizzle-orm";
import { randomUUID } from "node:crypto";
import { ROLE_SLUGS } from "@/common/authorization/role-templates.constant.js";
import { isReservedSlug } from "@/common/tenant/slug.util.js";
import { TenantContext } from "@/common/tenant/tenant-context.js";
import { buildTenantUrl } from "@/common/tenant/tenant-host.util.js";
import { toLimitOffset, type PaginationParams } from "@/common/utils/pagination.util.js";
import type { Env } from "@/config/env.schema.js";
import type { Database } from "@/database/database.type.js";
import { TenantOnboardingMode, TenantStatus } from "@/database/schema/enums.js";
import { tenantMemberships, tenants, type Tenant } from "@/database/schema/tenants.js";
import { RedisService } from "@/integrations/redis/redis.service.js";
import { PermissionsService } from "@/modules/authorization/permissions.service.js";
import { RoleProvisioningService } from "@/modules/authorization/role-provisioning.service.js";
import { PlatformSettingsService } from "@/modules/tenants/platform-settings.service.js";
import type { CreateTenantInput } from "@/modules/tenants/dto/create-tenant.schema.js";
import { TenantEvents, type TenantCreatedEvent, type TenantReviewedEvent } from "@/modules/tenants/tenant.events.js";
import { UsersService } from "@/modules/users/users.service.js";

const TENANT_INVALIDATION_CHANNEL = "tenant:invalidate";

interface CacheEntry {
    tenant: Tenant | null;
    expiresAt: number;
}

/**
 * Tenant lifecycle and lookup.
 *
 * Lookups (by host slug on every request, by id in the guard) are served from a
 * short-TTL in-process cache. A change publishes on Redis so every instance
 * drops its copy at once; the TTL is only the backstop if that message is lost.
 */
@Injectable()
export class TenantsService implements OnModuleInit {
    private readonly logger = new Logger(TenantsService.name);
    private readonly cache = new Map<string, CacheEntry>();
    private readonly cacheTtlMs: number;

    constructor(
        @InjectDrizzle() private readonly db: Database,
        private readonly configService: ConfigService<Env, true>,
        private readonly redis: RedisService,
        private readonly tenantContext: TenantContext,
        private readonly roleProvisioning: RoleProvisioningService,
        private readonly permissionsService: PermissionsService,
        private readonly settings: PlatformSettingsService,
        private readonly usersService: UsersService,
        private readonly events: EventEmitter2,
    ) {
        this.cacheTtlMs = configService.get("TENANT_CACHE_TTL_MS", { infer: true });
    }

    async onModuleInit(): Promise<void> {
        await this.redis.subscribe(TENANT_INVALIDATION_CHANNEL, () => this.cache.clear());
    }

    findBySlug(slug: string): Promise<Tenant | null> {
        return this.cached(`slug:${slug}`, () => this.db.query.tenants.findFirst({ where: { slug } }));
    }

    findById(id: string): Promise<Tenant | null> {
        return this.cached(`id:${id}`, () => this.db.query.tenants.findFirst({ where: { id } }));
    }

    async findByIdOrThrow(id: string): Promise<Tenant> {
        const tenant = await this.findById(id);
        if (!tenant) {
            throw new NotFoundException({ code: "TENANT_NOT_FOUND", message: "Tenant not found" });
        }
        return tenant;
    }

    urlFor(slug: string): string {
        return buildTenantUrl(slug, {
            template: this.configService.get("TENANT_URL_TEMPLATE", { infer: true }),
            appUrl: this.configService.get("APP_URL", { infer: true }),
            rootDomain: this.configService.get("APP_ROOT_DOMAIN", { infer: true }),
        });
    }

    /** Fails fast with a specific code, so signup can reject a bad slug before it creates an account. */
    async assertSlugAvailable(slug: string): Promise<void> {
        if (isReservedSlug(slug)) {
            throw new BadRequestException({ code: "TENANT_SLUG_RESERVED", message: "This slug is reserved" });
        }
        if (await this.findBySlugUncached(slug)) {
            throw new ConflictException({ code: "TENANT_SLUG_TAKEN", message: "This slug is already taken" });
        }
    }

    /**
     * Creates a tenant with its own copy of the role templates and makes `ownerId`
     * its owner — all in one transaction, so a tenant never exists half-built.
     *
     * Whether it starts ACTIVE or PENDING_APPROVAL is decided by the platform
     * setting *now*; changing the setting later does not touch existing tenants.
     */
    async createForOwner(ownerId: string, input: CreateTenantInput): Promise<Tenant> {
        const owner = await this.usersService.findByIdOrThrow(ownerId);
        const settings = await this.settings.get();
        this.assertSelfSignupOpen(settings.tenantOnboardingMode);

        const owned = await this.db.$count(
            tenants,
            and(eq(tenants.createdBy, ownerId), ne(tenants.status, TenantStatus.REJECTED)),
        );
        if (owned >= settings.maxTenantsPerUser) {
            throw new ForbiddenException({
                code: "TENANT_LIMIT_REACHED",
                message: `You can own at most ${settings.maxTenantsPerUser} organizations`,
            });
        }

        await this.assertSlugAvailable(input.slug);

        const status = settings.requireTenantApproval ? TenantStatus.PENDING_APPROVAL : TenantStatus.ACTIVE;
        const tenant = await this.provision(ownerId, input, { status });

        this.events.emit(TenantEvents.CREATED, {
            tenant,
            ownerId,
            ownerEmail: owner.email,
        } satisfies TenantCreatedEvent);

        return tenant;
    }

    /**
     * The super admin creating a tenant for someone: always ACTIVE (the admin's
     * own act is the approval) and exempt from the per-user limit and the
     * onboarding mode, which only govern self signup.
     */
    async createByPlatform(ownerId: string, input: CreateTenantInput, adminId: string): Promise<Tenant> {
        await this.assertSlugAvailable(input.slug);
        return this.provision(ownerId, input, {
            status: TenantStatus.ACTIVE,
            reviewedBy: adminId,
            reviewedAt: new Date(),
        });
    }

    /** Whether new accounts may create their own tenant. Checked before an account is made, so nothing is left half-built. */
    async assertSelfSignupAllowed(): Promise<void> {
        this.assertSelfSignupOpen((await this.settings.get()).tenantOnboardingMode);
    }

    private assertSelfSignupOpen(mode: TenantOnboardingMode): void {
        if (mode === TenantOnboardingMode.ADMIN_ONLY) {
            throw new ForbiddenException({
                code: "SELF_SIGNUP_DISABLED",
                message: "Organizations are created by invitation only. Submit a registration request instead.",
            });
        }
    }

    private async provision(
        ownerId: string,
        input: CreateTenantInput,
        extra: Pick<typeof tenants.$inferInsert, "status" | "reviewedBy" | "reviewedAt">,
    ): Promise<Tenant> {
        const id = randomUUID();

        // The tenant row is global, but its roles and membership are RLS-owned, so
        // the whole transaction runs scoped to the tenant being created.
        const tenant = await this.tenantContext.runAs(id, () =>
            this.db.transaction(async tx => {
                const [created] = await tx
                    .insert(tenants)
                    .values({ id, slug: input.slug, name: input.name, createdBy: ownerId, ...extra })
                    .returning();

                const roleIds = await this.roleProvisioning.provision(id, tx);

                await tx.insert(tenantMemberships).values({ tenantId: id, userId: ownerId });
                await this.permissionsService.assignRolesOnCreate(
                    id,
                    ownerId,
                    [roleIds[ROLE_SLUGS.OWNER], roleIds[ROLE_SLUGS.USER]],
                    tx,
                    ownerId,
                );

                return created!;
            }),
        );

        this.invalidateCache();
        return tenant;
    }

    async updateName(tenantId: string, name: string): Promise<Tenant> {
        const [updated] = await this.db
            .update(tenants)
            .set({ name, updatedAt: new Date() })
            .where(eq(tenants.id, tenantId))
            .returning();

        if (!updated) {
            throw new NotFoundException({ code: "TENANT_NOT_FOUND", message: "Tenant not found" });
        }

        this.invalidateCache();
        return updated;
    }

    /** Every tenant the user belongs to, in any state — the client needs pending/suspended ones to explain why it cannot enter. */
    listForUser(userId: string) {
        return this.tenantContext.runAsSystem(async () => {
            const rows = await this.db
                .select({
                    id: tenants.id,
                    slug: tenants.slug,
                    name: tenants.name,
                    status: tenants.status,
                    rejectionReason: tenants.rejectionReason,
                    membershipStatus: tenantMemberships.status,
                })
                .from(tenantMemberships)
                .innerJoin(tenants, eq(tenants.id, tenantMemberships.tenantId))
                .where(eq(tenantMemberships.userId, userId))
                .orderBy(desc(tenantMemberships.joinedAt));

            return rows.map(row => ({ ...row, url: this.urlFor(row.slug) }));
        });
    }

    // --- platform (super admin) operations ---------------------------------

    async listForPlatform(params: PaginationParams & { status?: TenantStatus; q?: string }) {
        const pattern = params.q ? `%${params.q.replace(/[\\%_]/g, "\\$&")}%` : undefined;
        const where = and(
            params.status ? eq(tenants.status, params.status) : undefined,
            pattern ? or(ilike(tenants.name, pattern), ilike(tenants.slug, pattern)) : undefined,
        );
        const { limit, offset } = toLimitOffset(params);

        const [items, [totals]] = await Promise.all([
            this.db.select().from(tenants).where(where).orderBy(desc(tenants.createdAt)).limit(limit).offset(offset),
            this.db.select({ total: count() }).from(tenants).where(where),
        ]);

        return {
            items: items.map(tenant => ({ ...tenant, url: this.urlFor(tenant.slug) })),
            total: totals?.total ?? 0,
        };
    }

    async getForPlatform(id: string) {
        const tenant = await this.findByIdUncached(id);
        if (!tenant) {
            throw new NotFoundException({ code: "TENANT_NOT_FOUND", message: "Tenant not found" });
        }
        return { ...tenant, url: this.urlFor(tenant.slug) };
    }

    approve(id: string, reviewerId: string): Promise<Tenant> {
        return this.transition(id, [TenantStatus.PENDING_APPROVAL], TenantStatus.ACTIVE, TenantEvents.APPROVED, {
            reviewedBy: reviewerId,
            reviewedAt: new Date(),
            rejectionReason: null,
        });
    }

    reject(id: string, reviewerId: string, reason: string | undefined): Promise<Tenant> {
        return this.transition(id, [TenantStatus.PENDING_APPROVAL], TenantStatus.REJECTED, TenantEvents.REJECTED, {
            reviewedBy: reviewerId,
            reviewedAt: new Date(),
            rejectionReason: reason ?? null,
        });
    }

    suspend(id: string): Promise<Tenant> {
        return this.transition(id, [TenantStatus.ACTIVE], TenantStatus.SUSPENDED, TenantEvents.SUSPENDED, {});
    }

    reactivate(id: string): Promise<Tenant> {
        return this.transition(id, [TenantStatus.SUSPENDED], TenantStatus.ACTIVE, TenantEvents.REACTIVATED, {});
    }

    private async transition(
        id: string,
        from: TenantStatus[],
        to: TenantStatus,
        event: string,
        extra: Partial<typeof tenants.$inferInsert>,
    ): Promise<Tenant> {
        const current = await this.findByIdUncached(id);
        if (!current) {
            throw new NotFoundException({ code: "TENANT_NOT_FOUND", message: "Tenant not found" });
        }
        if (!from.includes(current.status)) {
            throw new BadRequestException({
                code: "INVALID_TENANT_TRANSITION",
                message: `A ${current.status} tenant cannot become ${to}`,
            });
        }

        // The status in the WHERE makes two concurrent reviewers race safely: the loser updates nothing.
        const [updated] = await this.db
            .update(tenants)
            .set({ ...extra, status: to, updatedAt: new Date() })
            .where(and(eq(tenants.id, id), eq(tenants.status, current.status)))
            .returning();

        if (!updated) {
            throw new ConflictException({
                code: "INVALID_TENANT_TRANSITION",
                message: "The tenant changed while you were reviewing it",
            });
        }

        this.invalidateCache();

        const owner = updated.createdBy ? await this.usersService.findById(updated.createdBy) : null;
        this.events.emit(event, { tenant: updated, ownerEmail: owner?.email ?? null } satisfies TenantReviewedEvent);

        return updated;
    }

    // --- cache -------------------------------------------------------------

    private async cached(key: string, load: () => Promise<Tenant | undefined>): Promise<Tenant | null> {
        const hit = this.cache.get(key);
        if (hit && hit.expiresAt > Date.now()) {
            return hit.tenant;
        }

        const tenant = (await load()) ?? null;
        this.cache.set(key, { tenant, expiresAt: Date.now() + this.cacheTtlMs });
        return tenant;
    }

    private findBySlugUncached(slug: string) {
        return this.db.query.tenants.findFirst({ where: { slug } });
    }

    private findByIdUncached(id: string) {
        return this.db.query.tenants.findFirst({ where: { id } });
    }

    private invalidateCache(): void {
        this.cache.clear();
        void this.redis.publish(TENANT_INVALIDATION_CHANNEL, "*").catch((error: Error) => {
            this.logger.warn(`Tenant cache broadcast failed: ${error.message}`);
        });
    }
}
