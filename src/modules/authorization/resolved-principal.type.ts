import type { PermissionKey } from "@/common/authorization/permissions.constant.js";
import type { MembershipStatus, UserStatus } from "@/database/schema/enums.js";

/** Everything the guard needs to authorize a request, resolved from the database. */
export interface ResolvedPrincipal {
    userId: string;
    /** The tenant this principal was resolved for. */
    tenantId: string;
    /** Account state is resolved per request, so suspending or deleting an account takes effect immediately. */
    status: UserStatus;
    /** The tenant's own suspension of this member (independent of the global account status). */
    membershipStatus: MembershipStatus;
    /** True once the account is soft-deleted; every request from it must be refused. */
    isDeleted: boolean;
    /** Role slugs within this tenant — what the API calls role ids. */
    roleIds: string[];
    permissions: ReadonlySet<PermissionKey>;
    /** Highest rank across the member's roles; used for "who may manage whom" checks. */
    maxRank: number;
    permVersion: number;
    tokenVersion: number;
}

/** Wire format for the Redis layer — a Set does not survive JSON. */
export interface SerializedPrincipal {
    userId: string;
    tenantId: string;
    status: UserStatus;
    membershipStatus: MembershipStatus;
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

/** The super admin's resolved identity. Platform permissions are a code constant, so nothing role-shaped is stored. */
export interface PlatformPrincipal {
    userId: string;
    status: UserStatus;
    isDeleted: boolean;
    tokenVersion: number;
}
