import { buildTenantUrl, parseHost } from "@/common/tenant/tenant-host.util.js";

describe("parseHost", () => {
    const parse = (host: string | undefined) => parseHost(host, "example.com", "admin");

    it("treats the root, www and a missing host as the apex", () => {
        expect(parse("example.com")).toEqual({ kind: "apex" });
        expect(parse("www.example.com")).toEqual({ kind: "apex" });
        expect(parse(undefined)).toEqual({ kind: "apex" });
    });

    it("reads the tenant slug from a subdomain, ignoring port and case", () => {
        expect(parse("acme.example.com")).toEqual({ kind: "tenant", slug: "acme" });
        expect(parse("ACME.Example.com:3001")).toEqual({ kind: "tenant", slug: "acme" });
    });

    it("recognises the platform console host", () => {
        expect(parse("admin.example.com")).toEqual({ kind: "platform" });
    });

    it("serves reserved infrastructure labels as the apex, never as a tenant", () => {
        expect(parse("api.example.com")).toEqual({ kind: "apex" });
        expect(parse("login.example.com")).toEqual({ kind: "apex" });
    });

    it("treats hosts outside the root domain (IPs, load balancers) as the apex", () => {
        expect(parse("127.0.0.1:3000")).toEqual({ kind: "apex" });
        expect(parse("evilexample.com")).toEqual({ kind: "apex" });
    });

    it("rejects hosts that can never be a tenant", () => {
        expect(parse("a.b.example.com")).toBeNull();
        expect(parse("-bad-.example.com")).toBeNull();
        expect(parse("x.example.com")).toBeNull();
    });
});

describe("buildTenantUrl", () => {
    it("uses APP_URL's scheme and port under the root domain", () => {
        expect(buildTenantUrl("acme", { appUrl: "http://localhost:3001", rootDomain: "localhost" })).toBe(
            "http://acme.localhost:3001",
        );
        expect(buildTenantUrl("acme", { appUrl: "https://example.com", rootDomain: "example.com" })).toBe(
            "https://acme.example.com",
        );
    });

    it("prefers an explicit template", () => {
        expect(buildTenantUrl("acme", { template: "https://{slug}.app.io", appUrl: "http://x", rootDomain: "x" })).toBe(
            "https://acme.app.io",
        );
    });
});
