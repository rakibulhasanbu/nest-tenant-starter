import { Module } from "@nestjs/common";
import { AuditModule } from "@/modules/audit/audit.module.js";
import { PlatformController } from "@/modules/platform/platform.controller.js";
import { TenantOnboardingService } from "@/modules/platform/tenant-onboarding.service.js";
import { TenantInvitationsModule } from "@/modules/tenant-invitations/tenant-invitations.module.js";
import { TenantRequestsModule } from "@/modules/tenant-requests/tenant-requests.module.js";
import { TenantsModule } from "@/modules/tenants/tenants.module.js";

@Module({
    imports: [AuditModule, TenantsModule, TenantInvitationsModule, TenantRequestsModule],
    controllers: [PlatformController],
    providers: [TenantOnboardingService],
})
export class PlatformModule {}
