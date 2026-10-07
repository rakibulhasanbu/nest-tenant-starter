import { ConflictException, ForbiddenException, Inject, Injectable, Logger, NotFoundException } from "@nestjs/common";
import { InjectDrizzle } from "@nestjs/drizzle";
import { and, count, desc, eq, ilike, isNull, or, sql } from "drizzle-orm";
import { toLimitOffset } from "@/common/utils/pagination.util.js";
import type { Database } from "@/database/database.type.js";
import { TenantOnboardingMode, TenantRequestStatus } from "@/database/schema/enums.js";
import { tenantRegistrationRequests, type TenantRegistrationRequest } from "@/database/schema/tenant-requests.js";
import { EMAIL_SENDER, type EmailSender } from "@/integrations/email/email-sender.interface.js";
import type { CreateTenantRequestInput } from "@/modules/tenant-requests/dto/create-tenant-request.schema.js";
import type { ListTenantRequestsInput } from "@/modules/tenant-requests/dto/list-tenant-requests.schema.js";
import { PlatformSettingsService } from "@/modules/tenants/platform-settings.service.js";

const UNIQUE_VIOLATION = "23505";

/**
 * Registration requests: the intake step when tenants are created by the super
 * admin instead of by self signup. Approving or rejecting only records the
 * decision; creating the tenant is a separate, deliberate admin action.
 */
@Injectable()
export class TenantRequestsService {
    private readonly logger = new Logger(TenantRequestsService.name);

    constructor(
        @InjectDrizzle() private readonly db: Database,
        private readonly settings: PlatformSettingsService,
        @Inject(EMAIL_SENDER) private readonly emailSender: EmailSender,
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
            await this.safely(() =>
                this.emailSender.sendTenantRequestReceived({ to: input.email, businessName: input.businessName }),
            );
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
        await this.safely(() =>
            this.emailSender.sendTenantRequestApproved({ to: updated.email, businessName: updated.businessName }),
        );
        return updated;
    }

    async reject(id: string, reviewerId: string, reason: string | undefined): Promise<TenantRegistrationRequest> {
        const updated = await this.review(id, reviewerId, TenantRequestStatus.REJECTED, reason ?? null);
        await this.safely(() =>
            this.emailSender.sendTenantRequestRejected({
                to: updated.email,
                businessName: updated.businessName,
                reason: updated.rejectionReason,
            }),
        );
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
            .set({ status: to, rejectionReason, reviewedBy: reviewerId, reviewedAt: new Date(), updatedAt: new Date() })
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

    /** A failed email must never fail the action that triggered it. */
    private async safely(send: () => Promise<void>): Promise<void> {
        try {
            await send();
        } catch (error) {
            this.logger.error(`Notification failed: ${(error as Error).message}`);
        }
    }
}
