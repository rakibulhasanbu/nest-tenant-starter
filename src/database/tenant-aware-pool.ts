import pg from "pg";
import { currentTenantStore, type TenantStore } from "@/common/tenant/tenant-context.js";

interface StampedClient extends pg.PoolClient {
    __tenantStamp?: string;
}

/**
 * A pg Pool that stamps every connection it hands out with the caller's tenant
 * (`app.tenant_id`) or system mode (`app.bypass_rls`), which the RLS policies
 * read. Because it is the pool that does this, no query anywhere in the app can
 * forget to — the data layer enforces isolation, not each repository.
 *
 * The stamp is session-level and re-applied on every checkout (skipped when the
 * connection already carries the same one), so a connection returning to the
 * pool never leaks the previous request's tenant to the next.
 */
export class TenantAwarePool extends pg.Pool {
    // pg-pool overloads `connect` (callback and promise forms); both funnel here.
    override connect(): Promise<pg.PoolClient>;
    override connect(
        callback: (
            err: Error | undefined,
            client: pg.PoolClient | undefined,
            done: (release?: unknown) => void,
        ) => void,
    ): void;
    override connect(
        callback?: (
            err: Error | undefined,
            client: pg.PoolClient | undefined,
            done: (release?: unknown) => void,
        ) => void,
    ) {
        // Captured now, in the caller's async context. When the pool is exhausted the
        // callback below fires later from whoever released a connection — reading the
        // store there would stamp this request with a *different* request's tenant.
        const store = currentTenantStore();

        if (callback) {
            super.connect(
                (err: Error | undefined, client: pg.PoolClient | undefined, done: (release?: unknown) => void) => {
                    if (err || !client) {
                        callback(err, client, done);
                        return;
                    }
                    this.stamp(client as StampedClient, store).then(
                        () => callback(undefined, client, done),
                        (stampError: Error) => {
                            done(stampError);
                            callback(stampError, undefined, done);
                        },
                    );
                },
            );
            return;
        }

        return super.connect().then(async client => {
            try {
                await this.stamp(client as StampedClient, store);
                return client;
            } catch (error) {
                client.release(error as Error);
                throw error;
            }
        });
    }

    private async stamp(client: StampedClient, store: TenantStore | undefined): Promise<void> {
        const tenantId = store?.tenantId ?? "";
        const bypass = store?.system === true ? "on" : "off";
        const stamp = `${tenantId}|${bypass}`;

        if (client.__tenantStamp === stamp) {
            return;
        }

        await client.query("select set_config('app.tenant_id', $1, false), set_config('app.bypass_rls', $2, false)", [
            tenantId,
            bypass,
        ]);
        client.__tenantStamp = stamp;
    }
}
