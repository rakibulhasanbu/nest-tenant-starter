import { Module } from "@nestjs/common";
import { TerminusModule } from "@nestjs/terminus";
import { HealthController } from "@/modules/health/health.controller.js";
import { DatabaseHealthIndicator } from "@/modules/health/indicators/database.health.js";

@Module({
    imports: [TerminusModule],
    controllers: [HealthController],
    providers: [DatabaseHealthIndicator],
})
export class HealthModule {}
