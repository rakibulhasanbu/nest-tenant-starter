import { Module } from "@nestjs/common";
import { EmailModule } from "@/integrations/email/email.module.js";
import { TenantRequestsController } from "@/modules/tenant-requests/tenant-requests.controller.js";
import { TenantRequestsService } from "@/modules/tenant-requests/tenant-requests.service.js";
import { TenantsModule } from "@/modules/tenants/tenants.module.js";

@Module({
    imports: [TenantsModule, EmailModule],
    controllers: [TenantRequestsController],
    providers: [TenantRequestsService],
    exports: [TenantRequestsService],
})
export class TenantRequestsModule {}
