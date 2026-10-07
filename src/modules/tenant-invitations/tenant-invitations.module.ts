import { Module } from "@nestjs/common";
import { EmailModule } from "@/integrations/email/email.module.js";
import { TenantInvitationNotificationsListener } from "@/modules/tenant-invitations/tenant-invitation-notifications.listener.js";
import { TenantInvitationsService } from "@/modules/tenant-invitations/tenant-invitations.service.js";
import { TenantInvitationsTask } from "@/modules/tenant-invitations/tenant-invitations.task.js";
import { TenantsModule } from "@/modules/tenants/tenants.module.js";
import { UsersModule } from "@/modules/users/users.module.js";

@Module({
    imports: [TenantsModule, UsersModule, EmailModule],
    providers: [TenantInvitationsService, TenantInvitationsTask, TenantInvitationNotificationsListener],
    exports: [TenantInvitationsService],
})
export class TenantInvitationsModule {}
