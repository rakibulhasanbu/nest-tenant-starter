import { ForbiddenException } from "@nestjs/common";
import { TenantStatus } from "@/database/schema/enums.js";

/**
 * The one place that turns a tenant's lifecycle state into the error a client
 * acts on. Shared by the guard (every request) and the signin flow, so a tenant
 * that cannot be used says the same thing wherever the user bumps into it.
 */
export function assertTenantUsable(status: TenantStatus, rejectionReason: string | null): void {
    switch (status) {
        case TenantStatus.ACTIVE:
            return;
        case TenantStatus.PENDING_APPROVAL:
            throw new ForbiddenException({
                code: "TENANT_PENDING_APPROVAL",
                message: "This organization is waiting for approval",
            });
        case TenantStatus.REJECTED:
            throw new ForbiddenException({
                code: "TENANT_REJECTED",
                message: "This organization was not approved",
                reason: rejectionReason,
            });
        case TenantStatus.SUSPENDED:
            throw new ForbiddenException({
                code: "TENANT_SUSPENDED",
                message: "This organization has been suspended",
            });
    }
}
