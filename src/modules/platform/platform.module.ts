import { Module } from "@nestjs/common";
import { AuthModule } from "@/modules/auth/auth.module.js";
import { PlatformController } from "@/modules/platform/platform.controller.js";
import { TenantOnboardingService } from "@/modules/platform/tenant-onboarding.service.js";
import { TenantRequestsModule } from "@/modules/tenant-requests/tenant-requests.module.js";
import { TenantsModule } from "@/modules/tenants/tenants.module.js";
import { UsersModule } from "@/modules/users/users.module.js";

@Module({
    imports: [TenantsModule, AuthModule, TenantRequestsModule, UsersModule],
    controllers: [PlatformController],
    providers: [TenantOnboardingService],
})
export class PlatformModule {}
