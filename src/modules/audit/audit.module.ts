import { Module } from "@nestjs/common";
import { AuditController } from "@/modules/audit/audit.controller.js";
import { AuditListener } from "@/modules/audit/audit.listener.js";
import { AuditService } from "@/modules/audit/audit.service.js";

@Module({
    controllers: [AuditController],
    providers: [AuditService, AuditListener],
    exports: [AuditService],
})
export class AuditModule {}
