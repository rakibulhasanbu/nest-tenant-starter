import { Injectable } from "@nestjs/common";
import { InjectDrizzle } from "@nestjs/drizzle";
import { eq } from "drizzle-orm";
import type { Database } from "@/database/database.type.js";
import { platformSettings, type PlatformSettings } from "@/database/schema/tenants.js";

const SETTINGS_ROW_ID = 1;

/** Platform-wide switches. A single row, created by the seed; defaults apply if it is somehow absent. */
@Injectable()
export class PlatformSettingsService {
    constructor(@InjectDrizzle() private readonly db: Database) {}

    async get(): Promise<PlatformSettings> {
        const [row] = await this.db.select().from(platformSettings).where(eq(platformSettings.id, SETTINGS_ROW_ID));

        if (row) {
            return row;
        }

        const [created] = await this.db
            .insert(platformSettings)
            .values({ id: SETTINGS_ROW_ID })
            .onConflictDoNothing()
            .returning();

        return created ?? (await this.get());
    }

    async update(
        patch: { requireTenantApproval?: boolean; maxTenantsPerUser?: number },
        actorId: string,
    ): Promise<PlatformSettings> {
        await this.get();

        const [updated] = await this.db
            .update(platformSettings)
            .set({ ...patch, updatedBy: actorId, updatedAt: new Date() })
            .where(eq(platformSettings.id, SETTINGS_ROW_ID))
            .returning();

        return updated!;
    }
}
