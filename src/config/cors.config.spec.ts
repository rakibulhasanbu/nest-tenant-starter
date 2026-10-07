import type { ConfigService } from "@nestjs/config";
import { buildCorsOptions, type TenantLookup } from "@/config/cors.config.js";
import type { Env } from "@/config/env.schema.js";
import { TenantStatus } from "@/database/schema/enums.js";

function configWith(corsOrigins: string[] | undefined): ConfigService<Env, true> {
    const values: Record<string, unknown> = {
        CORS_ORIGINS: corsOrigins,
        APP_ROOT_DOMAIN: "example.com",
        PLATFORM_SUBDOMAIN: "admin",
    };
    return { get: (key: string) => values[key] } as unknown as ConfigService<Env, true>;
}

/** Runs the CORS origin callback and returns what it decided. */
function decide(options: ReturnType<typeof buildCorsOptions>, origin: string | undefined): Promise<unknown> {
    return new Promise(resolve => {
        (options.origin as (origin: string | undefined, cb: (error: Error | null, allow?: unknown) => void) => void)(
            origin,
            (_error, allow) => resolve(allow),
        );
    });
}

const tenants: TenantLookup = {
    findBySlug: async slug =>
        slug === "acme"
            ? { status: TenantStatus.ACTIVE }
            : slug === "nope-rejected"
              ? { status: TenantStatus.REJECTED }
              : null,
};

describe("buildCorsOptions", () => {
    it("allows only the configured origins when a list is set", async () => {
        const options = buildCorsOptions(configWith(["https://app.example.com"]));

        expect(await decide(options, "https://app.example.com")).toBe(true);
        expect(await decide(options, "https://evil.test")).toBe(false);
    });

    it("allows any origin when unset or empty (development)", async () => {
        expect(await decide(buildCorsOptions(configWith(undefined)), "https://anything.test")).toBe(true);
        expect(await decide(buildCorsOptions(configWith([])), "https://anything.test")).toBe(true);
    });

    it("allows requests with no Origin header (mobile, curl)", async () => {
        expect(await decide(buildCorsOptions(configWith(["https://app.example.com"])), undefined)).toBe(true);
    });

    it("allows a tenant subdomain only if the slug is a real, non-rejected tenant", async () => {
        const options = buildCorsOptions(configWith(["https://app.example.com"]), tenants);

        expect(await decide(options, "https://acme.example.com")).toBe(true);
        expect(await decide(options, "https://ghost.example.com")).toBe(false);
        expect(await decide(options, "https://nope-rejected.example.com")).toBe(false);
    });

    it("allows the platform console host and nothing outside the root domain", async () => {
        const options = buildCorsOptions(configWith(["https://app.example.com"]), tenants);

        expect(await decide(options, "https://admin.example.com")).toBe(true);
        expect(await decide(options, "https://acme.evil.test")).toBe(false);
        expect(await decide(options, "https://example.com.evil.test")).toBe(false);
    });

    it("keeps credentials off — the API is Bearer-token based, not cookie based", () => {
        expect(buildCorsOptions(configWith(undefined)).credentials).toBe(false);
    });
});
