// The config module validates the environment when the app module is imported, so this must run before any import.
vi.hoisted(() => {
    process.env.RATE_LIMIT_TENANT_PER_MINUTE = "5";
});

import {
    authed,
    boot,
    clearThrottle,
    createOwnerWithTenant,
    hostOf,
    shutdown,
    signIn,
    type Harness,
} from "./helpers/harness.js";

/** One busy tenant must not be able to use up the capacity of the others. */
describe("Per-tenant rate limiting (e2e)", () => {
    let h: Harness;

    beforeAll(async () => {
        h = await boot();
    });

    beforeEach(async () => {
        await clearThrottle(h);
    });

    afterAll(async () => {
        await shutdown(h);
    });

    it("stops a tenant that exhausts its own budget, without touching another tenant", async () => {
        const a = await createOwnerWithTenant(h);
        const b = await createOwnerWithTenant(h);
        const tokenA = (await signIn(h, a.owner.email, a.tenant.slug)).accessToken;
        const tokenB = (await signIn(h, b.owner.email, b.tenant.slug)).accessToken;
        await clearThrottle(h);

        // The tenant budget is shared across routes and users: five calls spend it.
        for (let i = 0; i < 5; i++) {
            await authed(h, "get", "/tenant", tokenA, hostOf(a.tenant.slug)).expect(200);
        }
        await authed(h, "get", "/tenant", tokenA, hostOf(a.tenant.slug)).expect(429);
        await authed(h, "get", "/users/me", tokenA, hostOf(a.tenant.slug)).expect(429);

        // Tenant B has its own budget.
        await authed(h, "get", "/tenant", tokenB, hostOf(b.tenant.slug)).expect(200);
    });
});
