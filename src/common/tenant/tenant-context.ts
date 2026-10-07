import { AsyncLocalStorage } from "node:async_hooks";
import { Injectable } from "@nestjs/common";

/**
 * Per-request tenant state. Kept in Node's AsyncLocalStorage (a built-in
 * "request-local variable", nothing to do with Redis) so any service — and the
 * database pool — can read the current tenant without it being passed through
 * every function signature.
 *
 * Two independent facts:
 *  - `tenantId`: rows of this tenant are visible (Postgres RLS enforces it).
 *  - `system`: explicit, auditable escape hatch for work that legitimately
 *    spans tenants (signin listing memberships, platform jobs, cron).
 * Neither set means the connection sees no tenant-owned rows at all.
 */
export interface TenantStore {
    tenantId?: string;
    system?: boolean;
}

const storage = new AsyncLocalStorage<TenantStore>();

/** Read by the database pool on every connection checkout; not for application code. */
export function currentTenantStore(): TenantStore | undefined {
    return storage.getStore();
}

export function runWithTenantStore<T>(store: TenantStore, fn: () => T): T {
    return storage.run(store, fn);
}

@Injectable()
export class TenantContext {
    get tenantId(): string | undefined {
        return storage.getStore()?.tenantId;
    }

    /** The current tenant, or a hard failure — never silently fall back to "no tenant". */
    requireTenantId(): string {
        const tenantId = this.tenantId;
        if (!tenantId) {
            throw new Error("No tenant in the current context");
        }
        return tenantId;
    }

    /** Called by the guard once the token's tenant has been verified. */
    setTenant(tenantId: string | undefined): void {
        const store = storage.getStore();
        if (store) {
            store.tenantId = tenantId;
        }
    }

    /**
     * Runs `fn` scoped to one tenant, regardless of the request's own tenant.
     *
     * The callback's result is awaited *inside* the scope on purpose. A Drizzle
     * query is a lazy thenable that only reaches the database when something
     * awaits it, so returning one out of `storage.run` unawaited would execute it
     * in the caller's scope — silently under the wrong tenant.
     */
    runAs<T>(tenantId: string, fn: () => T | PromiseLike<T>): Promise<T> {
        return storage.run({ tenantId }, async () => await fn());
    }

    /** Runs `fn` with cross-tenant visibility. Keep the callback small and obvious. */
    runAsSystem<T>(fn: () => T | PromiseLike<T>): Promise<T> {
        return storage.run({ system: true }, async () => await fn());
    }
}
