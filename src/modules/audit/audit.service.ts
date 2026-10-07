import { Injectable, Logger } from "@nestjs/common";
import { InjectDrizzle } from "@nestjs/drizzle";
import { and, desc, eq, gte, isNull, like, lte, sql, type SQL } from "drizzle-orm";
import { TenantContext, currentTenantStore } from "@/common/tenant/tenant-context.js";
import { toLimitOffset } from "@/common/utils/pagination.util.js";
import type { Database } from "@/database/database.type.js";
import { auditLogs, type AuditLog } from "@/database/schema/audit-logs.js";
import type { ListAuditLogsInput, ListPlatformAuditLogsInput } from "@/modules/audit/dto/list-audit-logs.schema.js";

export interface AuditEntry {
    /** Null for a platform-level action. */
    tenantId: string | null;
    /** Null for the system itself. */
    actorId: string | null;
    action: string;
    targetType?: string;
    targetId?: string;
    metadata?: Record<string, unknown>;
}

/**
 * The audit trail. Entries are written by listening to domain events, never by
 * the code that does the work, so adding an audited action does not touch the
 * module that performs it. Writing never throws: a trail that can fail the
 * action it records would be worse than a gap, and the failure is logged.
 */
@Injectable()
export class AuditService {
    private readonly logger = new Logger(AuditService.name);

    constructor(
        @InjectDrizzle() private readonly db: Database,
        private readonly tenantContext: TenantContext,
    ) {}

    async record(entry: AuditEntry): Promise<void> {
        const values = {
            tenantId: entry.tenantId,
            actorId: entry.actorId,
            action: entry.action,
            targetType: entry.targetType,
            targetId: entry.targetId,
            metadata: entry.metadata ?? {},
            requestId: currentTenantStore()?.requestId,
        };

        try {
            // A tenant's row is written inside that tenant's scope (RLS WITH CHECK); a platform row needs system scope.
            await (entry.tenantId
                ? this.tenantContext.runAs(entry.tenantId, () => this.db.insert(auditLogs).values(values))
                : this.tenantContext.runAsSystem(() => this.db.insert(auditLogs).values(values)));
        } catch (error) {
            this.logger.error(`Audit entry "${entry.action}" was not written: ${(error as Error).message}`);
        }
    }

    async listForTenant(tenantId: string, params: ListAuditLogsInput): Promise<{ items: AuditLog[]; total: number }> {
        return this.query(tenantId, [eq(auditLogs.tenantId, tenantId), ...this.filters(params)], params);
    }

    async listForPlatform(params: ListPlatformAuditLogsInput): Promise<{ items: AuditLog[]; total: number }> {
        const scope = params.tenantId
            ? eq(auditLogs.tenantId, params.tenantId)
            : params.platformOnly
              ? isNull(auditLogs.tenantId)
              : undefined;
        return this.query(null, [scope, ...this.filters(params)], params);
    }

    private filters(params: ListAuditLogsInput): (SQL | undefined)[] {
        const action = params.action;
        return [
            action?.endsWith(".*")
                ? like(auditLogs.action, `${action.slice(0, -1).replace(/[\\%_]/g, "\\$&")}%`)
                : action
                  ? eq(auditLogs.action, action)
                  : undefined,
            params.actorId ? eq(auditLogs.actorId, params.actorId) : undefined,
            params.from ? gte(auditLogs.createdAt, params.from) : undefined,
            params.to ? lte(auditLogs.createdAt, params.to) : undefined,
        ];
    }

    private async query(tenantId: string | null, conditions: (SQL | undefined)[], page: ListAuditLogsInput) {
        const where = and(...conditions);
        const { limit, offset } = toLimitOffset(page);
        const read = () =>
            Promise.all([
                this.db
                    .select()
                    .from(auditLogs)
                    .where(where)
                    .orderBy(desc(auditLogs.createdAt), desc(auditLogs.id))
                    .limit(limit)
                    .offset(offset),
                this.db.select({ total: sql<number>`count(*)::int` }).from(auditLogs).where(where),
            ]);

        const [items, [totals]] = await (tenantId
            ? this.tenantContext.runAs(tenantId, read)
            : this.tenantContext.runAsSystem(read));
        return { items, total: totals?.total ?? 0 };
    }
}
