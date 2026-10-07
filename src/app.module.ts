import { Module, RequestMethod, type MiddlewareConsumer, type NestModule } from "@nestjs/common";
import { APP_GUARD, APP_PIPE } from "@nestjs/core";
import { ConfigModule, ConfigService } from "@nestjs/config";
import { ThrottlerGuard, ThrottlerModule } from "@nestjs/throttler";
import { EventEmitterModule } from "@nestjs/event-emitter";
import { ScheduleModule } from "@nestjs/schedule";
import { ZodValidationPipe } from "nestjs-zod";
import { validateEnv, type Env } from "@/config/env.schema.js";
import { DrizzleModule } from "@nestjs/drizzle";
import { drizzle } from "drizzle-orm/node-postgres";
import { currentTenantStore } from "@/common/tenant/tenant-context.js";
import { TenantAwarePool } from "@/database/tenant-aware-pool.js";
import { relations } from "@/database/schema/relations.js";
import { TenantContextModule } from "@/common/tenant/tenant-context.module.js";
import { RedisModule } from "@/integrations/redis/redis.module.js";
import { RedisService } from "@/integrations/redis/redis.service.js";
import { RedisThrottlerStorage } from "@/integrations/redis/redis-throttler.storage.js";
import { HealthModule } from "@/modules/health/health.module.js";
import { AuthModule } from "@/modules/auth/auth.module.js";
import { AuthorizationModule } from "@/modules/authorization/authorization.module.js";
import { UsersModule } from "@/modules/users/users.module.js";
import { AdminUsersModule } from "@/modules/admin/users/admin-users.module.js";
import { AdminRolesModule } from "@/modules/admin/roles/admin-roles.module.js";
import { TenantsModule } from "@/modules/tenants/tenants.module.js";
import { TenantRequestsModule } from "@/modules/tenant-requests/tenant-requests.module.js";
import { AuditModule } from "@/modules/audit/audit.module.js";
import { PlatformModule } from "@/modules/platform/platform.module.js";
import { TenantHostMiddleware } from "@/modules/tenants/tenant-host.middleware.js";
import { JwtAuthGuard } from "@/common/guards/jwt-auth.guard.js";
import { PermissionsGuard } from "@/common/guards/permissions.guard.js";

@Module({
    imports: [
        ConfigModule.forRoot({ isGlobal: true, validate: validateEnv }),
        // Shared counters: the default per-process storage multiplies every limit
        // by the number of running instances. RedisService is global, so it can be
        // injected here.
        ThrottlerModule.forRootAsync({
            imports: [RedisModule],
            inject: [RedisService, ConfigService],
            useFactory: (redis: RedisService, config: ConfigService<Env, true>) => ({
                throttlers: [
                    // Per signed-in user, or per IP while anonymous. Each route has its own bucket.
                    {
                        name: "default",
                        ttl: 60_000,
                        limit: config.get("RATE_LIMIT_PER_MINUTE", { infer: true }),
                        getTracker: req => {
                            const { userId } = currentTenantStore() ?? {};
                            return userId ? `user:${userId}` : `ip:${req.ip}`;
                        },
                    },
                    // One shared budget per tenant across every route and user, so one busy tenant
                    // cannot starve the rest. Only applies once a request belongs to a tenant.
                    {
                        name: "tenant",
                        ttl: 60_000,
                        limit: config.get("RATE_LIMIT_TENANT_PER_MINUTE", { infer: true }),
                        skipIf: () => !currentTenantStore()?.tenantId,
                        getTracker: () => currentTenantStore()?.tenantId ?? "",
                        generateKey: (_context, tracker, name) => `${name}:${tracker}`,
                    },
                ],
                storage: new RedisThrottlerStorage(redis),
            }),
        }),
        ScheduleModule.forRoot(),
        // Domain events (tenant.created, ...) — in-process now, the seam for a message broker later.
        EventEmitterModule.forRoot(),
        // The pool stamps every connection with the request's tenant so Postgres RLS can enforce isolation.
        DrizzleModule.forRootAsync({
            inject: [ConfigService],
            useFactory: (config: ConfigService<Env, true>) => {
                const pool = new TenantAwarePool({ connectionString: config.get("DATABASE_URL", { infer: true }) });
                pool.on("error", error => console.error("Unexpected database pool error", error.message));
                return { db: drizzle({ client: pool, relations }) };
            },
        }),
        RedisModule,
        TenantContextModule,
        AuthorizationModule,
        TenantsModule,
        PlatformModule,
        AuditModule,
        TenantRequestsModule,
        HealthModule,
        AuthModule,
        UsersModule,
        AdminUsersModule,
        AdminRolesModule,
    ],
    controllers: [],
    providers: [
        { provide: APP_PIPE, useClass: ZodValidationPipe },
        // Order matters: JwtAuthGuard proves identity and puts the token claims on
        // the request; PermissionsGuard then resolves the real permission set and
        // authorizes against it, and records the user and tenant. The throttler runs
        // last so it can count per user and per tenant — a request that fails
        // authentication is rejected before it is counted.
        { provide: APP_GUARD, useClass: JwtAuthGuard },
        { provide: APP_GUARD, useClass: PermissionsGuard },
        { provide: APP_GUARD, useClass: ThrottlerGuard },
    ],
})
export class AppModule implements NestModule {
    configure(consumer: MiddlewareConsumer): void {
        // Opens the request's tenant scope and resolves the host's tenant before any guard runs.
        consumer.apply(TenantHostMiddleware).forRoutes({ path: "*path", method: RequestMethod.ALL });
    }
}
