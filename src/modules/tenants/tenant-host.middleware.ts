import { Injectable, NotFoundException, type NestMiddleware } from "@nestjs/common";
import { ConfigService } from "@nestjs/config";
import type { NextFunction, Request, Response } from "express";
import type { RequestWithHost } from "@/common/types/host-context.type.js";
import { runWithTenantStore } from "@/common/tenant/tenant-context.js";
import { parseHost } from "@/common/tenant/tenant-host.util.js";
import type { Env } from "@/config/env.schema.js";
import { TenantsService } from "@/modules/tenants/tenants.service.js";

/**
 * First thing every request passes through. It does two jobs:
 *
 *  1. Opens the request-local tenant store (so everything downstream, including
 *     the database pool, can see the tenant the guard later sets).
 *  2. Reads the host: `acme.<root>` becomes `hostContext.tenant`. Authorization
 *     never trusts this alone — the guard requires it to *agree* with the token's
 *     tenant claim — so it cannot be used to reach another tenant's data.
 *
 * An unknown tenant subdomain is a 404 with the same body whatever the cause.
 */
@Injectable()
export class TenantHostMiddleware implements NestMiddleware {
    private readonly rootDomain: string;
    private readonly platformSubdomain: string;

    constructor(
        configService: ConfigService<Env, true>,
        private readonly tenantsService: TenantsService,
    ) {
        this.rootDomain = configService.get("APP_ROOT_DOMAIN", { infer: true });
        this.platformSubdomain = configService.get("PLATFORM_SUBDOMAIN", { infer: true });
    }

    use(req: Request, _res: Response, next: NextFunction): void {
        // Behind a proxy Express resolves `req.hostname` from X-Forwarded-Host only when `trust proxy` is set.
        const parsed = parseHost(req.hostname, this.rootDomain, this.platformSubdomain);

        runWithTenantStore({}, () => {
            this.resolve(parsed, req as RequestWithHost).then(
                () => next(),
                (error: unknown) => next(error),
            );
        });
    }

    private async resolve(parsed: ReturnType<typeof parseHost>, req: RequestWithHost): Promise<void> {
        if (!parsed) {
            throw new NotFoundException({ code: "TENANT_NOT_FOUND", message: "Organization not found" });
        }

        if (parsed.kind !== "tenant") {
            req.hostContext = { kind: parsed.kind, tenant: null };
            return;
        }

        const tenant = await this.tenantsService.findBySlug(parsed.slug!);
        if (!tenant) {
            throw new NotFoundException({ code: "TENANT_NOT_FOUND", message: "Organization not found" });
        }

        req.hostContext = {
            kind: "tenant",
            tenant: { id: tenant.id, slug: tenant.slug, name: tenant.name, status: tenant.status },
        };
    }
}
