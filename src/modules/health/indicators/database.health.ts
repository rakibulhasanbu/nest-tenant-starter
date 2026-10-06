import { Injectable } from "@nestjs/common";
import { InjectDrizzle } from "@nestjs/drizzle";
import { HealthIndicatorService } from "@nestjs/terminus";
import { sql } from "drizzle-orm";
import type { Database } from "@/database/database.type.js";

@Injectable()
export class DatabaseHealthIndicator {
    constructor(
        @InjectDrizzle() private readonly db: Database,
        private readonly healthIndicatorService: HealthIndicatorService,
    ) {}

    async isHealthy(key: string) {
        const indicator = this.healthIndicatorService.check(key);

        try {
            await this.db.execute(sql`SELECT 1`);
            return indicator.up();
        } catch (error) {
            return indicator.down({ message: (error as Error).message });
        }
    }
}
