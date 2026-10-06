import { Injectable } from "@nestjs/common";
import { InjectDrizzle } from "@nestjs/drizzle";
import { and, eq } from "drizzle-orm";
import type { Database } from "@/database/database.type.js";
import { socialIdentities } from "@/database/schema/auth.js";
import type { AuthProvider } from "@/database/schema/enums.js";

@Injectable()
export class SocialIdentitiesService {
    constructor(@InjectDrizzle() private readonly db: Database) {}

    async findByProviderAccount(provider: AuthProvider, providerAccountId: string) {
        return (
            (await this.db.query.socialIdentities.findFirst({
                where: { provider, providerAccountId },
                with: { user: true },
            })) ?? null
        );
    }

    async findByUserAndProvider(userId: string, provider: AuthProvider) {
        const [identity] = await this.db
            .select()
            .from(socialIdentities)
            .where(and(eq(socialIdentities.userId, userId), eq(socialIdentities.provider, provider)))
            .limit(1);

        return identity ?? null;
    }

    async link(userId: string, provider: AuthProvider, providerAccountId: string, email: string) {
        const [identity] = await this.db
            .insert(socialIdentities)
            .values({ userId, provider, providerAccountId, email })
            .returning();

        return identity!;
    }
}
