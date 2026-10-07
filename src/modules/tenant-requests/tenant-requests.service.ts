import { ConflictException, ForbiddenException, Injectable, NotFoundException } from "@nestjs/common";
import { ConfigService } from "@nestjs/config";
import { InjectDrizzle } from "@nestjs/drizzle";
import { EventEmitter2 } from "@nestjs/event-emitter";
import { and, count, desc, eq, ilike, isNull, lt, lte, or, sql } from "drizzle-orm";
import { toLimitOffset } from "@/common/utils/pagination.util.js";
import type { Env } from "@/config/env.schema.js";
import type { Database } from "@/database/database.type.js";
import { TenantOnboardingMode, TenantRequestStatus } from "@/database/schema/enums.js";
import { tenantRegistrationRequests, type TenantRegistrationRequest } from "@/database/schema/tenant-requests.js";
import {
    TenantRequestEvents,
    type TenantRequestEvent,
    type TenantRequestReminderEvent,
} from "@/modules/tenant-requests/tenant-request.events.js";
import type { CreateTenantRequestInput } from "@/modules/tenant-requests/dto/create-tenant-request.schema.js";
import type { ListTenantRequestsInput } from "@/modules/tenant-requests/dto/list-tenant-requests.schema.js";
import { PlatformSettingsService } from "@/modules/tenants/platform-settings.service.js";

const UNIQUE_VIOLATION = "23505";
const DAY_MS = 24 * 60 * 60 * 1000;

/**
 * Registration requests: the intake step when tenants are created by the super
 * admin instead of by self signup. Approving or rejecting only records the
 * decision; creating the tenant is a separate, deliberate admin action.
 */
@Injectable()
export class TenantRequestsService {
    constructor(
        @InjectDrizzle() private readonly db: Database,
        private readonly settings: PlatformSettingsService,
        private readonly configService: ConfigService<Env, true>,
        private readonly events: EventEmitter2,
    ) {}

    /** Tells a public client whether to show the signup form or the registration-request form. */
    async getPublicConfig() {
        const { tenantOnboardingMode } = await this.settings.get();
        return {
            mode: tenantOnboardingMode,
            selfSignupEnabled: tenantOnboardingMode === TenantOnboardingMode.SELF_SIGNUP,
            registrationRequestEnabled: tenantOnboardingMode === TenantOnboardingMode.ADMIN_ONLY,
        };
    }

    async create(input: CreateTenantRequestInput): Promise<{ id: string }> {
        const { tenantOnboardingMode } = await this.settings.get();
        if (tenantOnboardingMode !== TenantOnboardingMode.ADMIN_ONLY) {
            throw new ForbiddenException({
                code: "REGISTRATION_REQUESTS_DISABLED",
                message: "Registration requests are not accepted — sign up directly instead",
            });
        }

        const open = await this.db.$count(
            tenantRegistrationRequests,
            and(
                sql`lower(${tenantRegistrationRequests.email}) = ${input.email}`,
                or(
                    eq(tenantRegistrationRequests.status, TenantRequestStatus.PENDING),
                    and(
                        eq(tenantRegistrationRequests.status, TenantRequestStatus.APPROVED),
                        isNull(tenantRegistrationRequests.tenantId),
                    ),
                ),
            ),
        );
        if (open > 0) {
            throw this.duplicate();
        }

        try {
            const [created] = await this.db.insert(tenantRegistrationRequests).values(input).returning();
            this.events.emit(TenantRequestEvents.SUBMITTED, { request: created! } satisfies TenantRequestEvent);
            return { id: created!.id };
        } catch (error) {
            // Two simultaneous submissions both pass the check above; the partial unique index settles it.
            if ((error as { cause?: { code?: string } }).cause?.code === UNIQUE_VIOLATION) {
                throw this.duplicate();
            }
            throw error;
        }
    }

    async list(params: ListTenantRequestsInput) {
        const pattern = params.q ? `%${params.q.replace(/[\\%_]/g, "\\$&")}%` : undefined;
        const where = and(
            params.status ? eq(tenantRegistrationRequests.status, params.status) : undefined,
            pattern
                ? or(
                      ilike(tenantRegistrationRequests.businessName, pattern),
                      ilike(tenantRegistrationRequests.ownerName, pattern),
                      ilike(tenantRegistrationRequests.email, pattern),
                  )
                : undefined,
        );
        const { limit, offset } = toLimitOffset(params);

        const [items, [totals]] = await Promise.all([
            this.db
                .select()
                .from(tenantRegistrationRequests)
                .where(where)
                .orderBy(desc(tenantRegistrationRequests.createdAt))
                .limit(limit)
                .offset(offset),
            this.db.select({ total: count() }).from(tenantRegistrationRequests).where(where),
        ]);

        return { items, total: totals?.total ?? 0 };
    }

    async getByIdOrThrow(id: string): Promise<TenantRegistrationRequest> {
        const [request] = await this.db
            .select()
            .from(tenantRegistrationRequests)
            .where(eq(tenantRegistrationRequests.id, id));

        if (!request) {
            throw new NotFoundException({
                code: "TENANT_REQUEST_NOT_FOUND",
                message: "Registration request not found",
            });
        }
        return request;
    }

    async approve(id: string, reviewerId: string): Promise<TenantRegistrationRequest> {
        const updated = await this.review(id, reviewerId, TenantRequestStatus.APPROVED, null);
        this.events.emit(TenantRequestEvents.APPROVED, { request: updated } satisfies TenantRequestEvent);
        return updated;
    }

    async reject(id: string, reviewerId: string, reason: string | undefined): Promise<TenantRegistrationRequest> {
        const updated = await this.review(id, reviewerId, TenantRequestStatus.REJECTED, reason ?? null);
        this.events.emit(TenantRequestEvents.REJECTED, { request: updated } satisfies TenantRequestEvent);
        return updated;
    }

    /** A request can seed exactly one tenant: it must be approved and not yet used. */
    async getConvertibleOrThrow(id: string): Promise<TenantRegistrationRequest> {
        const request = await this.getByIdOrThrow(id);
        if (request.status !== TenantRequestStatus.APPROVED || request.tenantId) {
            throw new ConflictException({
                code: "TENANT_REQUEST_NOT_CONVERTIBLE",
                message: request.tenantId
                    ? "A tenant was already created from this request"
                    : "Only an approved request can become a tenant",
            });
        }
        return request;
    }

    async linkTenant(id: string, tenantId: string): Promise<void> {
        await this.db
            .update(tenantRegistrationRequests)
            .set({ tenantId, updatedAt: new Date() })
            .where(eq(tenantRegistrationRequests.id, id));
    }

    private async review(
        id: string,
        reviewerId: string,
        to: TenantRequestStatus,
        rejectionReason: string | null,
    ): Promise<TenantRegistrationRequest> {
        await this.getByIdOrThrow(id);

        // Status in the WHERE: of two concurrent reviewers, the loser updates nothing.
        const [updated] = await this.db
            .update(tenantRegistrationRequests)
            .set({
                status: to,
                rejectionReason,
                reviewedBy: reviewerId,
                reviewedAt: new Date(),
                // The next stage (waiting for a tenant to be created) starts its own reminder clock.
                reminderCount: 0,
                lastRemindedAt: null,
                updatedAt: new Date(),
            })
            .where(
                and(
                    eq(tenantRegistrationRequests.id, id),
                    eq(tenantRegistrationRequests.status, TenantRequestStatus.PENDING),
                ),
            )
            .returning();

        if (!updated) {
            throw new ConflictException({
                code: "INVALID_TENANT_REQUEST_TRANSITION",
                message: "Only a pending request can be approved or rejected",
            });
        }
        return updated;
    }

    private duplicate() {
        return new ConflictException({
            code: "TENANT_REQUEST_ALREADY_OPEN",
            message: "A registration request for this email is already waiting",
        });
    }

    /**
     * Nudges the super admin about requests they have let sit: PENDING ones nobody
     * reviewed, and APPROVED ones no tenant was created for. A request is due once
     * its last reminder (or, for the first, the moment it entered that stage) is
     * old enough, up to a maximum. The UPDATE both selects and marks them, so with
     * several app instances each request is claimed by exactly one.
     */
    async sendDueReminders(): Promise<number> {
        const afterDays = this.configService.get("TENANT_REQUEST_REMINDER_AFTER_DAYS", { infer: true });
        const max = this.configService.get("TENANT_REQUEST_REMINDER_MAX", { infer: true });
        const now = new Date();
        const cutoff = new Date(now.getTime() - afterDays * DAY_MS);
        const requests = tenantRegistrationRequests;

        const claimed = await this.db
            .update(requests)
            .set({ reminderCount: sql`${requests.reminderCount} + 1`, lastRemindedAt: now })
            .where(
                and(
                    lt(requests.reminderCount, max),
                    or(
                        eq(requests.status, TenantRequestStatus.PENDING),
                        and(eq(requests.status, TenantRequestStatus.APPROVED), isNull(requests.tenantId)),
                    ),
                    // When did this stage start? Submission for PENDING, the decision for APPROVED.
                    lte(
                        sql`coalesce(${requests.lastRemindedAt}, case when ${requests.status} = 'PENDING' then ${requests.createdAt} else ${requests.reviewedAt} end)`,
                        cutoff,
                    ),
                ),
            )
            .returning();

        for (const request of claimed) {
            this.events.emit(TenantRequestEvents.REMINDER_DUE, {
                request,
                stage: request.status === TenantRequestStatus.PENDING ? "REVIEW" : "CREATE_TENANT",
                reminderNumber: request.reminderCount,
            } satisfies TenantRequestReminderEvent);
        }
        return claimed.length;
    }

    /**
     * Rejected requests hold a stranger's name, phone, birth date and address for
     * no purpose once the decision is made, so they are deleted after the retention
     * period. Approved requests are kept: they are the record behind a tenant.
     */
    async purgeRejected(): Promise<number> {
        const days = this.configService.get("TENANT_REQUEST_REJECTED_RETENTION_DAYS", { infer: true });
        const deleted = await this.db
            .delete(tenantRegistrationRequests)
            .where(
                and(
                    eq(tenantRegistrationRequests.status, TenantRequestStatus.REJECTED),
                    lt(tenantRegistrationRequests.reviewedAt, new Date(Date.now() - days * DAY_MS)),
                ),
            )
            .returning({ id: tenantRegistrationRequests.id });
        return deleted.length;
    }
}
