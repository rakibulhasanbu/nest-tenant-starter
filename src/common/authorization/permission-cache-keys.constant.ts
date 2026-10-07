/**
 * Shared between the running application and the seed script, which mutates
 * permVersion directly and must be able to clear what the app has cached.
 *
 * A principal is per (tenant, user): the same person holds different roles in
 * different tenants, so the tenant is part of every key.
 */
export const PERM_CACHE_KEY_PREFIX = "perm:";
export const PERM_INVALIDATION_CHANNEL = "perm:invalidate";

/** Broadcast on the invalidation channel to clear every in-memory entry at once. */
export const PERM_INVALIDATE_ALL = "*";

const PLATFORM_SCOPE = "platform";

export function permCacheKey(tenantId: string | null, userId: string): string {
    return `${PERM_CACHE_KEY_PREFIX}${tenantId ?? PLATFORM_SCOPE}:${userId}`;
}

/** Redis pattern matching every tenant's entry for one user. */
export function permCachePatternForUser(userId: string): string {
    return `${PERM_CACHE_KEY_PREFIX}*:${userId}`;
}

/** In-memory key: the Redis key minus its prefix. */
export function l1Key(tenantId: string | null, userId: string): string {
    return `${tenantId ?? PLATFORM_SCOPE}:${userId}`;
}

/** Invalidation messages: `k:<l1Key>` for one entry, `u:<userId>` for all of a user's, `*` for everything. */
export const invalidateKeyMessage = (tenantId: string | null, userId: string) => `k:${l1Key(tenantId, userId)}`;
export const invalidateUserMessage = (userId: string) => `u:${userId}`;
