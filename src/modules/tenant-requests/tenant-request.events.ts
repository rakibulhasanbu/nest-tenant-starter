import type { TenantRegistrationRequest } from "@/database/schema/tenant-requests.js";

/** Domain events about registration requests; the mails they trigger live in the notifications listener. */
export const TenantRequestEvents = {
    SUBMITTED: "tenant-request.submitted",
    APPROVED: "tenant-request.approved",
    REJECTED: "tenant-request.rejected",
    /** The super admin has let a request sit; they are nudged by mail. */
    REMINDER_DUE: "tenant-request.reminder-due",
} as const;

export interface TenantRequestEvent {
    request: TenantRegistrationRequest;
}

export interface TenantRequestReminderEvent extends TenantRequestEvent {
    stage: "REVIEW" | "CREATE_TENANT";
    reminderNumber: number;
}
