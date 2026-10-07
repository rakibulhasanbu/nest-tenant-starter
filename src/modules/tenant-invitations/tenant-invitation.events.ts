/**
 * Domain events about owner invitations. None carries the link token: that is a
 * secret and is emailed directly, so these payloads are safe to put on a broker.
 */
export const TenantInvitationEvents = {
    CREATED: "tenant-invitation.created",
    ACCEPTED: "tenant-invitation.accepted",
    /** An unaccepted invitation was cleaned up: its tenant and placeholder account are gone. */
    ABANDONED: "tenant-invitation.abandoned",
} as const;

export interface TenantInvitationEvent {
    invitationId: string;
    tenantId: string;
    userId: string;
    email: string;
}

export interface TenantInvitationAbandonedEvent extends TenantInvitationEvent {
    tenantName: string;
    tenantSlug: string;
}
