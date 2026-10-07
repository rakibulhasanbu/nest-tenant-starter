import { pgEnum } from "drizzle-orm/pg-core";

/**
 * Each enum is a const object plus a union type, so call sites keep writing
 * `UserStatus.ACTIVE` and `z.enum(UserStatus)` while the database gets a real
 * Postgres enum built from the same values.
 */
export const UserStatus = {
    PENDING_VERIFICATION: "PENDING_VERIFICATION",
    ACTIVE: "ACTIVE",
    SUSPENDED: "SUSPENDED",
} as const;
export type UserStatus = (typeof UserStatus)[keyof typeof UserStatus];
export const userStatusEnum = pgEnum("user_status", Object.values(UserStatus) as [UserStatus, ...UserStatus[]]);

export const EmailTokenType = {
    VERIFY_EMAIL: "VERIFY_EMAIL",
    RESET_PASSWORD: "RESET_PASSWORD",
    DELETE_ACCOUNT: "DELETE_ACCOUNT",
    REACTIVATE_ACCOUNT: "REACTIVATE_ACCOUNT",
} as const;
export type EmailTokenType = (typeof EmailTokenType)[keyof typeof EmailTokenType];
export const emailTokenTypeEnum = pgEnum(
    "email_token_type",
    Object.values(EmailTokenType) as [EmailTokenType, ...EmailTokenType[]],
);

export const AuthProvider = {
    GOOGLE: "GOOGLE",
} as const;
export type AuthProvider = (typeof AuthProvider)[keyof typeof AuthProvider];
export const authProviderEnum = pgEnum(
    "auth_provider",
    Object.values(AuthProvider) as [AuthProvider, ...AuthProvider[]],
);

export const Gender = {
    MALE: "MALE",
    FEMALE: "FEMALE",
    OTHER: "OTHER",
    PREFER_NOT_TO_SAY: "PREFER_NOT_TO_SAY",
} as const;
export type Gender = (typeof Gender)[keyof typeof Gender];
export const genderEnum = pgEnum("gender", Object.values(Gender) as [Gender, ...Gender[]]);

export const TenantStatus = {
    PENDING_APPROVAL: "PENDING_APPROVAL",
    ACTIVE: "ACTIVE",
    REJECTED: "REJECTED",
    SUSPENDED: "SUSPENDED",
} as const;
export type TenantStatus = (typeof TenantStatus)[keyof typeof TenantStatus];
export const tenantStatusEnum = pgEnum(
    "tenant_status",
    Object.values(TenantStatus) as [TenantStatus, ...TenantStatus[]],
);

/** `pool` = shared schema with RLS (implemented); `silo` = dedicated database (reserved, not implemented). */
export const TenantIsolation = {
    POOL: "pool",
    SILO: "silo",
} as const;
export type TenantIsolation = (typeof TenantIsolation)[keyof typeof TenantIsolation];
export const tenantIsolationEnum = pgEnum(
    "tenant_isolation",
    Object.values(TenantIsolation) as [TenantIsolation, ...TenantIsolation[]],
);

/** A membership is either usable or suspended by the tenant; "invited" users are created with an ACTIVE membership. */
export const MembershipStatus = {
    ACTIVE: "ACTIVE",
    SUSPENDED: "SUSPENDED",
} as const;
export type MembershipStatus = (typeof MembershipStatus)[keyof typeof MembershipStatus];
export const membershipStatusEnum = pgEnum(
    "membership_status",
    Object.values(MembershipStatus) as [MembershipStatus, ...MembershipStatus[]],
);

export const PermissionLevel = {
    TENANT: "tenant",
    PLATFORM: "platform",
} as const;
export type PermissionLevel = (typeof PermissionLevel)[keyof typeof PermissionLevel];
export const permissionLevelEnum = pgEnum(
    "permission_level",
    Object.values(PermissionLevel) as [PermissionLevel, ...PermissionLevel[]],
);
