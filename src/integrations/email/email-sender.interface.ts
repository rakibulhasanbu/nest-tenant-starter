export interface VerifyEmailMessage {
    to: string;
    code: string;
}

export interface ResetPasswordMessage {
    to: string;
    code: string;
}

export interface AccountLinkedMessage {
    to: string;
    provider: string;
}

export interface DeleteAccountCodeMessage {
    to: string;
    code: string;
}

/** Sent when someone tries to use an address whose account is inside its deletion grace period. */
export interface ReactivateAccountMessage {
    to: string;
    code: string;
    graceEndsAt: Date;
}

export interface AccountDeletedMessage {
    to: string;
    graceDays: number;
}

/** Sent to the super admin when a tenant is waiting for approval. */
export interface TenantPendingApprovalMessage {
    to: string;
    tenantName: string;
    tenantSlug: string;
    ownerEmail: string;
}

export interface TenantApprovedMessage {
    to: string;
    tenantName: string;
    url: string;
}

export interface TenantRejectedMessage {
    to: string;
    tenantName: string;
    reason: string | null;
}

/** Sent to an existing account that was added to a tenant. */
export interface MembershipAddedMessage {
    to: string;
    tenantName: string;
    url: string;
}

/** Sent to a brand-new owner of a tenant the super admin created; `acceptUrl` carries the one-time token. */
export interface TenantOwnerInviteMessage {
    to: string;
    tenantName: string;
    acceptUrl: string;
    expiresAt: Date;
}

/** The same invitation again, with a fresh link, because it has not been accepted yet. */
export interface TenantOwnerInviteReminderMessage extends TenantOwnerInviteMessage {
    reminderNumber: number;
}

/** Sent to the super admin when an unaccepted invitation was cleaned up. */
export interface TenantInvitationAbandonedMessage {
    to: string;
    tenantName: string;
    tenantSlug: string;
    ownerEmail: string;
}

/** Sent to the super admin when a registration request arrives. */
export interface TenantRequestSubmittedMessage {
    to: string;
    businessName: string;
    ownerName: string;
    ownerEmail: string;
}

/** Sent to the super admin while a request is still waiting on them. */
export interface TenantRequestReminderMessage {
    to: string;
    businessName: string;
    ownerEmail: string;
    /** REVIEW: nobody has approved or rejected it. CREATE_TENANT: approved, but no tenant exists yet. */
    stage: "REVIEW" | "CREATE_TENANT";
    reminderNumber: number;
}

export interface TenantRequestReceivedMessage {
    to: string;
    businessName: string;
}

export interface TenantRequestApprovedMessage {
    to: string;
    businessName: string;
}

export interface TenantRequestRejectedMessage {
    to: string;
    businessName: string;
    reason: string | null;
}

export const EMAIL_SENDER = Symbol("EMAIL_SENDER");

/**
 * Port for outbound transactional email. Swap the stub implementation
 * (registered in EmailModule) for a real provider without touching callers.
 */
export interface EmailSender {
    sendVerifyEmail(message: VerifyEmailMessage): Promise<void>;
    sendResetPassword(message: ResetPasswordMessage): Promise<void>;
    sendAccountLinked(message: AccountLinkedMessage): Promise<void>;
    sendDeleteAccountCode(message: DeleteAccountCodeMessage): Promise<void>;
    sendAccountDeleted(message: AccountDeletedMessage): Promise<void>;
    sendReactivateAccount(message: ReactivateAccountMessage): Promise<void>;
    sendTenantPendingApproval(message: TenantPendingApprovalMessage): Promise<void>;
    sendTenantApproved(message: TenantApprovedMessage): Promise<void>;
    sendTenantRejected(message: TenantRejectedMessage): Promise<void>;
    sendMembershipAdded(message: MembershipAddedMessage): Promise<void>;
    sendTenantOwnerInvite(message: TenantOwnerInviteMessage): Promise<void>;
    sendTenantOwnerInviteReminder(message: TenantOwnerInviteReminderMessage): Promise<void>;
    sendTenantInvitationAbandoned(message: TenantInvitationAbandonedMessage): Promise<void>;
    sendTenantRequestSubmitted(message: TenantRequestSubmittedMessage): Promise<void>;
    sendTenantRequestReminder(message: TenantRequestReminderMessage): Promise<void>;
    sendTenantRequestReceived(message: TenantRequestReceivedMessage): Promise<void>;
    sendTenantRequestApproved(message: TenantRequestApprovedMessage): Promise<void>;
    sendTenantRequestRejected(message: TenantRequestRejectedMessage): Promise<void>;
}
