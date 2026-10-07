import { Module } from "@nestjs/common";
import { UsersModule } from "@/modules/users/users.module.js";
import { MembershipsService } from "@/modules/tenants/memberships.service.js";
import { PlatformSettingsService } from "@/modules/tenants/platform-settings.service.js";
import { TenantHostMiddleware } from "@/modules/tenants/tenant-host.middleware.js";
import { TenantNotificationsListener } from "@/modules/tenants/tenant-notifications.listener.js";
import { TenantsController } from "@/modules/tenants/tenants.controller.js";
import { TenantsService } from "@/modules/tenants/tenants.service.js";
import { EmailModule } from "@/integrations/email/email.module.js";

@Module({
    imports: [UsersModule, EmailModule],
    controllers: [TenantsController],
    providers: [
        TenantsService,
        MembershipsService,
        PlatformSettingsService,
        TenantHostMiddleware,
        TenantNotificationsListener,
    ],
    exports: [TenantsService, MembershipsService, PlatformSettingsService, TenantHostMiddleware],
})
export class TenantsModule {}
