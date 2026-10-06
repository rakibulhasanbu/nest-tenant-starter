import type { PermissionKey } from "@/common/authorization/permissions.constant.js";
import type { UserStatus } from "@/database/schema/enums.js";

/** Everything the guard needs to authorize a request, resolved from the database. */
export interface ResolvedPrincipal {
    userId: string;
    /** Account state is resolved per request, so suspending or deleting an account takes effect immediately. */
    status: UserStatus;
    /** True once the account is soft-deleted; every request from it must be refused. */
    isDeleted: boolean;
    roleIds: string[];
    permissions: ReadonlySet<PermissionKey>;
    /** Highest rank across the user's roles; used for "who may manage whom" checks. */
    maxRank: number;
    permVersion: number;
    tokenVersion: number;
}

/** Wire format for the Redis layer — a Set does not survive JSON. */
export interface SerializedPrincipal {
    userId: string;
    status: UserStatus;
    isDeleted: boolean;
    roleIds: string[];
    permissions: string[];
    maxRank: number;
    permVersion: number;
    tokenVersion: number;
}

export function serializePrincipal(principal: ResolvedPrincipal): SerializedPrincipal {
    return { ...principal, permissions: [...principal.permissions] };
}

export function deserializePrincipal(payload: SerializedPrincipal): ResolvedPrincipal {
    return { ...payload, permissions: new Set(payload.permissions as PermissionKey[]) };
}
