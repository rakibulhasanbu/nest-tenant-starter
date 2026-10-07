import { Injectable, Logger, type OnModuleInit } from "@nestjs/common";
import { ConfigService } from "@nestjs/config";
import type { Env } from "@/config/env.schema.js";
import {
    invalidateKeyMessage,
    invalidateUserMessage,
    l1Key,
    PERM_INVALIDATE_ALL,
    PERM_INVALIDATION_CHANNEL,
    permCacheKey,
    permCachePatternForUser,
} from "@/common/authorization/permission-cache-keys.constant.js";
import { RedisService } from "@/integrations/redis/redis.service.js";
import {
    deserializePrincipal,
    serializePrincipal,
    type ResolvedPrincipal,
    type SerializedPrincipal,
} from "@/modules/authorization/resolved-principal.type.js";

interface CacheEntry {
    principal: ResolvedPrincipal;
    expiresAt: number;
}

/**
 * Two-layer cache in front of the permission resolution query.
 *
 * L1 (this process's memory) answers almost every request for free. L2 (Redis)
 * is shared, so a cold instance does not re-hit the database and an invalidation
 * only has to happen once. Both layers carry a TTL: if an explicit invalidation
 * is ever missed, stale data expires on its own rather than living forever.
 *
 * Correctness does not rest on this cache — every cached principal carries the
 * `permVersion` it was built with, and the guard rejects a token whose version
 * disagrees. A stale entry therefore fails closed, never open.
 */
@Injectable()
export class PermissionsCacheService implements OnModuleInit {
    private readonly logger = new Logger(PermissionsCacheService.name);
    private readonly l1 = new Map<string, CacheEntry>();

    private readonly l1TtlMs: number;
    private readonly l1MaxEntries: number;
    private readonly l2TtlSeconds: number;

    constructor(
        private readonly redis: RedisService,
        configService: ConfigService<Env, true>,
    ) {
        this.l1TtlMs = configService.get("PERM_CACHE_L1_TTL_MS", { infer: true });
        this.l1MaxEntries = configService.get("PERM_CACHE_L1_MAX_ENTRIES", { infer: true });
        this.l2TtlSeconds = configService.get("PERM_CACHE_L2_TTL_SECONDS", { infer: true });
    }

    async onModuleInit(): Promise<void> {
        await this.redis.subscribe(PERM_INVALIDATION_CHANNEL, message => {
            if (message === PERM_INVALIDATE_ALL) {
                this.l1.clear();
            } else if (message.startsWith("k:")) {
                this.l1.delete(message.slice(2));
            } else if (message.startsWith("u:")) {
                this.dropUserFromL1(message.slice(2));
            }
        });
    }

    async get(tenantId: string, userId: string): Promise<ResolvedPrincipal | null> {
        const key = l1Key(tenantId, userId);
        const entry = this.l1.get(key);

        if (entry) {
            if (entry.expiresAt > Date.now()) {
                return entry.principal;
            }
            this.l1.delete(key);
        }

        const principal = await this.readFromRedis(tenantId, userId);

        if (principal) {
            this.writeToL1(key, principal);
        }

        return principal;
    }

    async set(principal: ResolvedPrincipal): Promise<void> {
        this.writeToL1(l1Key(principal.tenantId, principal.userId), principal);

        if (!this.redis.isAvailable) {
            return;
        }

        await this.redis.client
            .set(
                permCacheKey(principal.tenantId, principal.userId),
                JSON.stringify(serializePrincipal(principal)),
                "EX",
                this.l2TtlSeconds,
            )
            .catch((error: Error) => this.logger.warn(`Permission cache write failed: ${error.message}`));
    }

    /** Drops one member's entry in one tenant from every layer on every instance. Safe when Redis is down. */
    async invalidate(tenantId: string, userId: string): Promise<void> {
        this.l1.delete(l1Key(tenantId, userId));

        if (this.redis.isAvailable) {
            await this.redis.client
                .del(permCacheKey(tenantId, userId))
                .catch((error: Error) => this.logger.warn(`Permission cache delete failed: ${error.message}`));
        }

        await this.redis.publish(PERM_INVALIDATION_CHANNEL, invalidateKeyMessage(tenantId, userId));
    }

    /**
     * Drops every tenant's entry for a user — for changes that are global to the
     * account (password change, suspension, deletion) rather than to one membership.
     */
    async invalidateUser(userId: string): Promise<void> {
        this.dropUserFromL1(userId);

        if (this.redis.isAvailable) {
            try {
                let cursor = "0";
                do {
                    const [next, keys] = await this.redis.client.scan(
                        cursor,
                        "MATCH",
                        permCachePatternForUser(userId),
                        "COUNT",
                        200,
                    );
                    cursor = next;
                    if (keys.length > 0) {
                        await this.redis.client.del(...keys);
                    }
                } while (cursor !== "0");
            } catch (error) {
                this.logger.warn(`Permission cache user sweep failed: ${(error as Error).message}`);
            }
        }

        await this.redis.publish(PERM_INVALIDATION_CHANNEL, invalidateUserMessage(userId));
    }

    async invalidateMany(tenantId: string, userIds: readonly string[]): Promise<void> {
        await Promise.all(userIds.map(userId => this.invalidate(tenantId, userId)));
    }

    private dropUserFromL1(userId: string): void {
        const suffix = `:${userId}`;
        for (const key of this.l1.keys()) {
            if (key.endsWith(suffix)) {
                this.l1.delete(key);
            }
        }
    }

    private async readFromRedis(tenantId: string, userId: string): Promise<ResolvedPrincipal | null> {
        if (!this.redis.isAvailable) {
            return null;
        }

        const raw = await this.redis.client.get(permCacheKey(tenantId, userId)).catch(() => null);

        if (!raw) {
            return null;
        }

        try {
            return deserializePrincipal(JSON.parse(raw) as SerializedPrincipal);
        } catch {
            // A malformed entry is treated as a miss; the caller re-reads from the database.
            return null;
        }
    }

    private writeToL1(key: string, principal: ResolvedPrincipal): void {
        // Evict the oldest entry once full — Map preserves insertion order, so the
        // first key is the least recently written. This bounds memory; it is not an LRU.
        if (this.l1.size >= this.l1MaxEntries && !this.l1.has(key)) {
            const oldest = this.l1.keys().next();
            if (!oldest.done) {
                this.l1.delete(oldest.value);
            }
        }

        this.l1.set(key, { principal, expiresAt: Date.now() + this.l1TtlMs });
    }
}
