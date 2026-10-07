import { ConsoleLogger } from "@nestjs/common";
import { currentTenantStore } from "@/common/tenant/tenant-context.js";

/** What identifies the current work in a log line; empty outside a request (startup, cron). */
function correlation(): Record<string, string> {
    const store = currentTenantStore();
    const fields: Record<string, string> = {};
    if (store?.requestId) fields.requestId = store.requestId;
    if (store?.tenantId) fields.tenantId = store.tenantId;
    if (store?.system) fields.scope = "system";
    if (store?.userId) fields.userId = store.userId;
    return fields;
}

/**
 * The stock console logger, plus `requestId`, `tenantId` and `userId` on every
 * line, read from the same per-request store the database pool uses. Services
 * keep calling `new Logger(...)` unchanged; with several tenants in one process
 * that is what makes a log line attributable.
 */
export class ContextAwareLogger extends ConsoleLogger {
    protected override formatContext(context: string): string {
        const fields = Object.entries(correlation())
            .map(([key, value]) => `${key}=${value}`)
            .join(" ");
        return fields ? `${super.formatContext(context)}{${fields}} ` : super.formatContext(context);
    }

    protected override getJsonLogObject(message: unknown, options: Parameters<ConsoleLogger["getJsonLogObject"]>[1]) {
        return { ...super.getJsonLogObject(message, options), ...correlation() };
    }
}
