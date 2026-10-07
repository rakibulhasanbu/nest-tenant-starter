import { Injectable, Logger } from "@nestjs/common";
import type {
    AccountDeletedMessage,
    AccountLinkedMessage,
    DeleteAccountCodeMessage,
    EmailSender,
    MembershipAddedMessage,
    ReactivateAccountMessage,
    ResetPasswordMessage,
    TenantApprovedMessage,
    TenantOwnerInviteMessage,
    TenantRequestApprovedMessage,
    TenantRequestReceivedMessage,
    TenantRequestRejectedMessage,
    TenantPendingApprovalMessage,
    TenantRejectedMessage,
    VerifyEmailMessage,
} from "@/integrations/email/email-sender.interface.js";

/** Placeholder sender — logs instead of sending until a real provider is wired in. */
@Injectable()
export class ConsoleEmailSender implements EmailSender {
    private readonly logger = new Logger(ConsoleEmailSender.name);

    async sendVerifyEmail(message: VerifyEmailMessage): Promise<void> {
        this.logger.log(`[verify-email] to=${message.to} code=${message.code}`);
    }

    async sendResetPassword(message: ResetPasswordMessage): Promise<void> {
        this.logger.log(`[reset-password] to=${message.to} code=${message.code}`);
    }

    async sendAccountLinked(message: AccountLinkedMessage): Promise<void> {
        this.logger.log(`[account-linked] to=${message.to} provider=${message.provider}`);
    }

    async sendDeleteAccountCode(message: DeleteAccountCodeMessage): Promise<void> {
        this.logger.log(`[delete-account-code] to=${message.to} code=${message.code}`);
    }

    async sendAccountDeleted(message: AccountDeletedMessage): Promise<void> {
        this.logger.log(`[account-deleted] to=${message.to} graceDays=${message.graceDays}`);
    }

    async sendReactivateAccount(message: ReactivateAccountMessage): Promise<void> {
        this.logger.log(
            `[reactivate-account] to=${message.to} code=${message.code} ` +
                `graceEndsAt=${message.graceEndsAt.toISOString()}`,
        );
    }

    async sendTenantPendingApproval(message: TenantPendingApprovalMessage): Promise<void> {
        this.logger.log(
            `[tenant-pending-approval] to=${message.to} tenant=${message.tenantSlug} owner=${message.ownerEmail}`,
        );
    }

    async sendTenantApproved(message: TenantApprovedMessage): Promise<void> {
        this.logger.log(`[tenant-approved] to=${message.to} tenant=${message.tenantName} url=${message.url}`);
    }

    async sendTenantRejected(message: TenantRejectedMessage): Promise<void> {
        this.logger.log(
            `[tenant-rejected] to=${message.to} tenant=${message.tenantName} reason=${message.reason ?? "-"}`,
        );
    }

    async sendMembershipAdded(message: MembershipAddedMessage): Promise<void> {
        this.logger.log(`[membership-added] to=${message.to} tenant=${message.tenantName} url=${message.url}`);
    }

    async sendTenantOwnerInvite(message: TenantOwnerInviteMessage): Promise<void> {
        this.logger.log(
            `[tenant-owner-invite] to=${message.to} tenant=${message.tenantName} code=${message.code} ` +
                `url=${message.url} expiresAt=${message.expiresAt.toISOString()}`,
        );
    }

    async sendTenantRequestReceived(message: TenantRequestReceivedMessage): Promise<void> {
        this.logger.log(`[tenant-request-received] to=${message.to} business=${message.businessName}`);
    }

    async sendTenantRequestApproved(message: TenantRequestApprovedMessage): Promise<void> {
        this.logger.log(`[tenant-request-approved] to=${message.to} business=${message.businessName}`);
    }

    async sendTenantRequestRejected(message: TenantRequestRejectedMessage): Promise<void> {
        this.logger.log(
            `[tenant-request-rejected] to=${message.to} business=${message.businessName} reason=${message.reason ?? "-"}`,
        );
    }
}
