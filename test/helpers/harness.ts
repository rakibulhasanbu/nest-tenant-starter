import "dotenv/config";
import { randomUUID } from "node:crypto";
import type { NestExpressApplication } from "@nestjs/platform-express";
import { Test } from "@nestjs/testing";
import { getDrizzleToken } from "@nestjs/drizzle";
import * as argon2 from "argon2";
import { drizzle } from "drizzle-orm/node-postgres";
import { eq, like } from "drizzle-orm";
import request from "supertest";
import { AppModule } from "@/app.module.js";
import { configureApp } from "@/config/configure-app.js";
import type { Database } from "@/database/database.type.js";
import { TenantStatus, UserStatus } from "@/database/schema/enums.js";
import { relations } from "@/database/schema/relations.js";
import { platformSettings, tenants } from "@/database/schema/tenants.js";
import { users } from "@/database/schema/users.js";
import { RedisService } from "@/integrations/redis/redis.service.js";
import { EmailTokensService } from "@/modules/auth/email-tokens.service.js";
import { MembershipsService } from "@/modules/tenants/memberships.service.js";
import { TenantsService } from "@/modules/tenants/tenants.service.js";
import { UsersService } from "@/modules/users/users.service.js";

// Tenant lookups are cached in-process; tests flip tenant status behind the app's back.
process.env.TENANT_CACHE_TTL_MS = "0";

export const API = "/api/v1";
export const PASSWORD = "e2e-Passw0rd!";
/** Everything a suite creates carries this prefix so cleanup can find it and nothing else. */
export const PREFIX = "e2e-";
export const ROOT = process.env.APP_ROOT_DOMAIN ?? "localhost";
export const PLATFORM_HOST = `${process.env.PLATFORM_SUBDOMAIN ?? "admin"}.${ROOT}`;
export const hostOf = (slug: string) => `${slug}.${ROOT}`;

export interface Harness {
    app: NestExpressApplication;
    /** The app's own (restricted, RLS-bound) connection. */
    db: Database;
    /** Owner connection: bypasses RLS, for arranging and inspecting state. */
    admin: ReturnType<typeof createAdminDb>;
    users: UsersService;
    tenants: TenantsService;
    memberships: MembershipsService;
    emailTokens: EmailTokensService;
    redis: RedisService;
    originalSettings: typeof platformSettings.$inferSelect | undefined;
}

function createAdminDb() {
    return drizzle({ connection: (process.env.DATABASE_ADMIN_URL ?? process.env.DATABASE_URL)!, relations });
}

export async function boot(): Promise<Harness> {
    const moduleFixture = await Test.createTestingModule({ imports: [AppModule] }).compile();
    const app = configureApp(moduleFixture.createNestApplication<NestExpressApplication>());
    await app.init();

    const admin = createAdminDb();
    const [originalSettings] = await admin.select().from(platformSettings).where(eq(platformSettings.id, 1));

    return {
        app,
        db: app.get<Database>(getDrizzleToken()),
        admin,
        users: app.get(UsersService),
        tenants: app.get(TenantsService),
        memberships: app.get(MembershipsService),
        emailTokens: app.get(EmailTokensService),
        redis: app.get(RedisService),
        originalSettings,
    };
}

export async function shutdown(h: Harness | undefined): Promise<void> {
    if (!h) return;
    // Users first: deleting them cascades their memberships and role assignments, which
    // is what lets the tenants (and their roles) go afterwards.
    await h.admin.delete(users).where(like(users.email, `${PREFIX}%`));
    await h.admin.delete(tenants).where(like(tenants.slug, `${PREFIX}%`));
    if (h.originalSettings) {
        await h.admin
            .update(platformSettings)
            .set({
                requireTenantApproval: h.originalSettings.requireTenantApproval,
                maxTenantsPerUser: h.originalSettings.maxTenantsPerUser,
            })
            .where(eq(platformSettings.id, 1));
    }
    await h.admin.$client.end();
    await h.app.close();
}

/** The per-IP budgets are small and every request comes from loopback, so clear the shared counters. */
export async function clearThrottle(h: Harness): Promise<void> {
    if (!h.redis.isAvailable) return;
    const keys = await h.redis.client.keys("throttle:*");
    if (keys.length > 0) {
        await h.redis.client.del(...keys);
    }
}

export async function setApproval(h: Harness, requireTenantApproval: boolean, maxTenantsPerUser = 50): Promise<void> {
    await h.admin
        .update(platformSettings)
        .set({ requireTenantApproval, maxTenantsPerUser })
        .where(eq(platformSettings.id, 1));
}

export const uniqueSlug = () => `${PREFIX}${randomUUID().slice(0, 8)}`;
export const uniqueEmail = () => `${PREFIX}${randomUUID()}@example.test`;

/** An ACTIVE, verified account with no tenant yet. */
export async function createUser(h: Harness, email = uniqueEmail()) {
    const user = await h.users.createUser({
        email,
        passwordHash: await argon2.hash(PASSWORD),
        status: UserStatus.ACTIVE,
        emailVerifiedAt: new Date(),
    });
    return { id: user.id, email };
}

/** A user who owns a fresh ACTIVE tenant. Pass `status` to arrange another lifecycle state. */
export async function createOwnerWithTenant(h: Harness, status: TenantStatus = TenantStatus.ACTIVE) {
    const owner = await createUser(h);
    const tenant = await h.tenants.createForOwner(owner.id, { name: "E2E Org", slug: uniqueSlug() });
    if (tenant.status !== status) {
        await h.admin.update(tenants).set({ status }).where(eq(tenants.id, tenant.id));
    }
    return { owner, tenant: { ...tenant, status } };
}

/** An account that is a member (not owner) of an existing tenant. */
export async function createMember(h: Harness, tenantId: string, roleSlugs: string[] = []) {
    const user = await createUser(h);
    await h.memberships.add(tenantId, user.id, roleSlugs);
    return user;
}

export interface SessionBody {
    accessToken: string;
    refreshToken: string;
    tenant: { id: string; slug: string; name: string; url: string } | null;
}

/** Signs in naming the tenant in the body (the way mobile and the apex site do). */
export async function signIn(h: Harness, email: string, tenantSlug?: string, host?: string): Promise<SessionBody> {
    const req = request(h.app.getHttpServer()).post(`${API}/auth/signin`);
    if (host) req.set("Host", host);
    const response = await req.send({ email, password: PASSWORD, ...(tenantSlug ? { tenantSlug } : {}) }).expect(200);
    return response.body.data as SessionBody;
}

export function authed(
    h: Harness,
    method: "get" | "post" | "patch" | "delete",
    path: string,
    accessToken: string,
    host?: string,
) {
    const req = request(h.app.getHttpServer())[method](`${API}${path}`).set("Authorization", `Bearer ${accessToken}`);
    return host ? req.set("Host", host) : req;
}
