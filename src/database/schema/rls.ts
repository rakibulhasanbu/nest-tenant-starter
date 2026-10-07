import { pgPolicy } from "drizzle-orm/pg-core";
import { sql } from "drizzle-orm";

/**
 * Row-level isolation for a tenant-owned table. A row is visible/writable only
 * when its `tenant_id` equals the `app.tenant_id` the connection was stamped with
 * (see `tenant-aware-pool.ts`), or when the connection is explicitly in system
 * mode (`app.bypass_rls = 'on'`). A connection with neither sees nothing, so a
 * forgotten `WHERE tenant_id = ...` fails closed instead of leaking.
 *
 * Every tenant-owned table must add this — it is the template for future tables.
 */
export const tenantIsolationPolicy = (tableName: string) =>
    pgPolicy(`${tableName}_tenant_isolation`, {
        as: "permissive",
        for: "all",
        using: sql`tenant_id = nullif(current_setting('app.tenant_id', true), '') or current_setting('app.bypass_rls', true) = 'on'`,
        withCheck: sql`tenant_id = nullif(current_setting('app.tenant_id', true), '') or current_setting('app.bypass_rls', true) = 'on'`,
    });
