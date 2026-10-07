import { Module } from "@nestjs/common";
import { PlatformController } from "@/modules/platform/platform.controller.js";
import { TenantsModule } from "@/modules/tenants/tenants.module.js";

@Module({
    imports: [TenantsModule],
    controllers: [PlatformController],
})
export class PlatformModule {}
