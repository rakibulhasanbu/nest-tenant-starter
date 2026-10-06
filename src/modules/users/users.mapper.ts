import type { User, UserProfile } from "@/database/schema/users.js";
import type { PermissionKey } from "@/common/authorization/permissions.constant.js";
import type { AuthenticatedUser } from "@/common/types/authenticated-request.type.js";
import type { UserWithRoles } from "@/modules/users/users.service.js";

export type PublicUserProfile = Pick<UserProfile, "gender" | "bio"> & {
    /** Calendar date (YYYY-MM-DD) — it is stored as a `DATE`, so never expose a timestamp. */
    dateOfBirth: string | null;
};

export type PublicUser = Omit<
    User,
    "password" | "twoFactorSecret" | "twoFactorRecoveryCodes" | "twoFactorLastUsedStep"
> & {
    roleIds: string[];
    profile: PublicUserProfile | null;
    /**
     * Whether password login is set up. Google-only accounts have
     * no password, and without this flag a client cannot tell whether to offer
     * "change password" (needs the current one) or "set password" — the two
     * endpoints reject each other's case with a 400.
     */
    hasPassword: boolean;
};

/**
 * What the caller may do, sent only with their *own* record. Clients need this
 * to gate their UI the same way the guard gates the API — checking a permission
 * key rather than guessing from a role name, which is the whole point of the
 * permission catalog. Never attach it to another user's record: it describes
 * the requester, not the subject.
 */
export type CurrentUser = PublicUser & {
    permissions: PermissionKey[];
    /** Highest rank across the user's roles; they may only manage subjects ranked below it. */
    maxRank: number;
};

/**
 * PermissionsGuard has already resolved the principal for this request, so the
 * permission set costs nothing extra to include here.
 */
export function toCurrentUser(user: UserWithRoles, principal: AuthenticatedUser): CurrentUser {
    return {
        ...toPublicUser(user),
        permissions: [...principal.permissions],
        maxRank: principal.maxRank,
    };
}

export function toPublicUser(user: UserWithRoles): PublicUser {
    const {
        password,
        twoFactorSecret: _twoFactorSecret,
        twoFactorRecoveryCodes: _twoFactorRecoveryCodes,
        twoFactorLastUsedStep: _twoFactorLastUsedStep,
        roles,
        profile,
        ...publicUser
    } = user;

    return {
        ...publicUser,
        roleIds: roles.map(({ roleId }) => roleId),
        profile: profile ? toPublicUserProfile(profile) : null,
        hasPassword: password !== null,
    };
}

function toPublicUserProfile(profile: UserProfile): PublicUserProfile {
    return {
        dateOfBirth: profile.dateOfBirth,
        gender: profile.gender,
        bio: profile.bio,
    };
}
