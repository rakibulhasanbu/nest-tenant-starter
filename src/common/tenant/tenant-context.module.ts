import { Global, Module } from "@nestjs/common";
import { TenantContext } from "@/common/tenant/tenant-context.js";

@Global()
@Module({
    providers: [TenantContext],
    exports: [TenantContext],
})
export class TenantContextModule {}
