import { isReservedSlug, tenantSlugSchema } from "@/common/tenant/slug.util.js";

describe("tenantSlugSchema", () => {
    it.each(["acme", "my-company", "a1b", "x".repeat(32)])("accepts %s", slug => {
        expect(tenantSlugSchema.safeParse(slug).success).toBe(true);
    });

    it.each(["ab", "-acme", "acme-", "Acme", "has_underscore", "has.dot", "x".repeat(33), ""])("rejects %j", slug => {
        expect(tenantSlugSchema.safeParse(slug).success).toBe(false);
    });

    it("rejects reserved slugs", () => {
        expect(isReservedSlug("admin")).toBe(true);
        expect(tenantSlugSchema.safeParse("admin").success).toBe(false);
        expect(tenantSlugSchema.safeParse("billing").success).toBe(false);
    });
});
