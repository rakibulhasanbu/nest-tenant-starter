import type { CorsOptions } from "@nestjs/common/interfaces/external/cors-options.interface.js";
import type { ConfigService } from "@nestjs/config";
import type { Env } from "@/config/env.schema.js";
import { parseHost } from "@/common/tenant/tenant-host.util.js";
import { TenantStatus } from "@/database/schema/enums.js";

/** Minimal lookup the CORS check needs — keeps this file free of the tenants module. */
export interface TenantLookup {
    findBySlug(slug: string): Promise<{ status: TenantStatus } | null>;
}

/**
 * Static origins from CORS_ORIGINS, plus — when a lookup is given — every
 * `https://<slug>.<APP_ROOT_DOMAIN>` whose slug is a real, non-rejected tenant
 * (and the platform console host). Origins are never reflected blindly: a
 * wildcard match alone is not enough, the subdomain must resolve to a tenant.
 */
export function buildCorsOptions(configService: ConfigService<Env, true>, tenants?: TenantLookup): CorsOptions {
    const corsOrigins = configService.get("CORS_ORIGINS", { infer: true });
    const rootDomain = configService.get("APP_ROOT_DOMAIN", { infer: true });
    const platformSubdomain = configService.get("PLATFORM_SUBDOMAIN", { infer: true });
    const allowAll = !corsOrigins || corsOrigins.length === 0;

    return {
        origin: (origin, callback) => {
            if (!origin) {
                callback(null, true);
                return;
            }
            if (allowAll || corsOrigins!.includes(origin)) {
                callback(null, true);
                return;
            }

            void isTenantOrigin(origin, rootDomain, platformSubdomain, tenants).then(
                allowed => callback(null, allowed),
                () => callback(null, false),
            );
        },
        methods: ["GET", "POST", "PUT", "PATCH", "DELETE", "OPTIONS"],
        allowedHeaders: ["Content-Type", "Authorization"],
        credentials: false,
    };
}

async function isTenantOrigin(
    origin: string,
    rootDomain: string,
    platformSubdomain: string,
    tenants?: TenantLookup,
): Promise<boolean> {
    let hostname: string;
    try {
        hostname = new URL(origin).hostname;
    } catch {
        return false;
    }

    const parsed = parseHost(hostname, rootDomain, platformSubdomain);
    if (!parsed || parsed.kind === "apex") {
        return false;
    }
    if (parsed.kind === "platform") {
        return true;
    }

    const tenant = await tenants?.findBySlug(parsed.slug!);
    return tenant !== null && tenant !== undefined && tenant.status !== TenantStatus.REJECTED;
}
