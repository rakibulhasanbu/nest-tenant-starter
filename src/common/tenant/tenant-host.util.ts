import { isReservedSlug, SLUG_PATTERN } from "@/common/tenant/slug.util.js";

export type HostKind = "apex" | "platform" | "tenant";

export interface ParsedHost {
    kind: HostKind;
    /** Present when `kind` is `tenant`. */
    slug?: string;
}

/**
 * Classifies a request host against the configured root domain.
 *
 *  - `root`, `www.root`, reserved labels (`api.root`) and any host outside the root
 *    domain (an IP, a load balancer name, mobile talking to the API host) → apex
 *  - `<PLATFORM_SUBDOMAIN>.root` → platform console
 *  - `<slug>.root` → that tenant
 *
 * Returns `null` for hosts that look like a tenant but can never be one
 * (`a.b.root`, malformed labels), so the caller can answer 404 instead of guessing.
 */
export function parseHost(
    rawHost: string | undefined,
    rootDomain: string,
    platformSubdomain: string,
): ParsedHost | null {
    const host = (rawHost ?? "").split(":")[0]!.trim().toLowerCase().replace(/\.$/, "");

    if (!host || host === rootDomain) {
        return { kind: "apex" };
    }

    const suffix = `.${rootDomain}`;
    if (!host.endsWith(suffix)) {
        return { kind: "apex" };
    }

    const label = host.slice(0, -suffix.length);

    if (label === platformSubdomain) {
        return { kind: "platform" };
    }
    if (label.includes(".")) {
        return null;
    }
    if (isReservedSlug(label)) {
        return { kind: "apex" };
    }
    if (!SLUG_PATTERN.test(label)) {
        return null;
    }

    return { kind: "tenant", slug: label };
}

/** Where a tenant's web app lives. `template` wins; otherwise APP_URL's scheme and port under the root domain. */
export function buildTenantUrl(
    slug: string,
    options: { template?: string; appUrl: string; rootDomain: string },
): string {
    if (options.template) {
        return options.template.replace("{slug}", slug);
    }

    const app = new URL(options.appUrl);
    return `${app.protocol}//${slug}.${options.rootDomain}${app.port ? `:${app.port}` : ""}`;
}
