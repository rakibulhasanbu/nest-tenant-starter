import { Module } from "@nestjs/common";
import { APP_GUARD, APP_PIPE } from "@nestjs/core";
import { ConfigModule, ConfigService } from "@nestjs/config";
import { ThrottlerGuard, ThrottlerModule } from "@nestjs/throttler";
import { ScheduleModule } from "@nestjs/schedule";
import { ZodValidationPipe } from "nestjs-zod";
import { validateEnv, type Env } from "@/config/env.schema.js";
import { DrizzleModule } from "@nestjs/drizzle";
import { drizzle } from "drizzle-orm/node-postgres";
import { relations } from "@/database/schema/relations.js";
import { RedisModule } from "@/integrations/redis/redis.module.js";
import { RedisService } from "@/integrations/redis/redis.service.js";
import { RedisThrottlerStorage } from "@/integrations/redis/redis-throttler.storage.js";
import { HealthModule } from "@/modules/health/health.module.js";
import { AuthModule } from "@/modules/auth/auth.module.js";
import { AuthorizationModule } from "@/modules/authorization/authorization.module.js";
import { UsersModule } from "@/modules/users/users.module.js";
import { AdminUsersModule } from "@/modules/admin/users/admin-users.module.js";
import { AdminRolesModule } from "@/modules/admin/roles/admin-roles.module.js";
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
            inject: [RedisService],
            useFactory: (redis: RedisService) => ({
                throttlers: [{ ttl: 60_000, limit: 60 }],
                storage: new RedisThrottlerStorage(redis),
            }),
        }),
        ScheduleModule.forRoot(),
        DrizzleModule.forRootAsync({
            inject: [ConfigService],
            useFactory: (config: ConfigService<Env, true>) => ({
                drizzle,
                connection: config.get("DATABASE_URL", { infer: true }),
                relations,
            }),
        }),
        RedisModule,
        AuthorizationModule,
        HealthModule,
        AuthModule,
        UsersModule,
        AdminUsersModule,
        AdminRolesModule,
    ],
    controllers: [],
    providers: [
        { provide: APP_PIPE, useClass: ZodValidationPipe },
        { provide: APP_GUARD, useClass: ThrottlerGuard },
        // Order matters: JwtAuthGuard proves identity and puts the token claims on
        // the request; PermissionsGuard then resolves the real permission set and
        // authorizes against it.
        { provide: APP_GUARD, useClass: JwtAuthGuard },
        { provide: APP_GUARD, useClass: PermissionsGuard },
    ],
})
export class AppModule {}
