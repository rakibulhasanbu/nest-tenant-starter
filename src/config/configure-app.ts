import { VersioningType } from "@nestjs/common";
import { ConfigService } from "@nestjs/config";
import type { NestExpressApplication } from "@nestjs/platform-express";
import helmet from "helmet";
import { AllExceptionsFilter } from "@/common/filters/all-exceptions.filter.js";
import { TransformResponseInterceptor } from "@/common/interceptors/transform-response.interceptor.js";
import { buildCorsOptions } from "@/config/cors.config.js";
import type { Env } from "@/config/env.schema.js";

/**
 * Every global concern lives here rather than in `main.ts` so the e2e suite
 * boots the same app the server does. Tests that configured themselves were the
 * reason a route could pass under `/` and 404 under `/api/v1` in production.
 */
export function configureApp(app: NestExpressApplication): NestExpressApplication {
    const configService = app.get<ConfigService<Env, true>>(ConfigService);

    // Must be set before anything reads `req.ip` — the throttler keys on it and
    // refresh tokens record it against the session.
    const trustProxy = configService.get("TRUST_PROXY", { infer: true });
    if (trustProxy !== undefined) {
        app.set("trust proxy", trustProxy);
    }

    // Baseline response headers: HSTS, nosniff, frame denial, and dropping the
    // X-Powered-By giveaway. Registered before CORS so it covers every response.
    app.use(helmet());

    app.enableCors(buildCorsOptions(configService));

    app.useGlobalFilters(new AllExceptionsFilter());
    app.useGlobalInterceptors(new TransformResponseInterceptor());
    // Without this, SIGTERM skips onModuleDestroy: Database and Redis connections
    // are left hanging and in-flight requests are cut mid-response on every deploy.
    app.enableShutdownHooks();

    app.setGlobalPrefix("api");
    app.enableVersioning({
        type: VersioningType.URI,
        defaultVersion: "1",
    });

    return app;
}
