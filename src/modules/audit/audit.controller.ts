import { Controller, Get, Query } from "@nestjs/common";
import { PERMISSIONS } from "@/common/authorization/permissions.constant.js";
import { CurrentUser } from "@/common/decorators/current-user.decorator.js";
import { RequirePermissions } from "@/common/decorators/require-permissions.decorator.js";
import type { AuthenticatedUser } from "@/common/types/authenticated-request.type.js";
import { paginate } from "@/common/utils/pagination.util.js";
import { ListAuditLogsDto } from "@/modules/audit/dto/list-audit-logs.schema.js";
import { AuditService } from "@/modules/audit/audit.service.js";

/** The current tenant's own trail. The tenant comes from the session, never from the request. */
@Controller("audit-logs")
export class AuditController {
    constructor(private readonly auditService: AuditService) {}

    @RequirePermissions(PERMISSIONS.AUDIT_READ)
    @Get()
    async list(@CurrentUser() actor: AuthenticatedUser, @Query() query: ListAuditLogsDto) {
        const { items, total } = await this.auditService.listForTenant(actor.tenantId!, query);
        return paginate(items, query, total);
    }
}
