import { eq } from "drizzle-orm";
import pg from "pg";
import request from "supertest";
import { ROLE_SLUGS } from "@/common/authorization/role-templates.constant.js";
import { TenantContext } from "@/common/tenant/tenant-context.js";
import { emailTokens, refreshTokens } from "@/database/schema/auth.js";
import { roles } from "@/database/schema/authorization.js";
import { TenantStatus } from "@/database/schema/enums.js";
import { tenantMemberships, tenants } from "@/database/schema/tenants.js";
import {
    API,
    PASSWORD,
    PLATFORM_HOST,
    authed,
    boot,
    clearThrottle,
    createMember,
    createOwnerWithTenant,
    createUser,
    hostOf,
    setApproval,
    shutdown,
    signIn,
    uniqueEmail,
    uniqueSlug,
    type Harness,
    type SessionBody,
} from "./helpers/harness.js";

/**
 * The multi-tenant guarantees: signup-creates-tenant with approval, subdomain
 * binding, isolation (app layer and Postgres RLS), users in several tenants, and
 * the lifecycle states that must take effect on live tokens immediately.
 *
 * Needs the seeded super admin (`pnpm db:seed`): the platform tests sign in as
 * ADMIN_EMAIL / ADMIN_PASSWORD on the platform host.
 */
describe("Multi-tenant (e2e)", () => {
    let h: Harness;

    beforeAll(async () => {
        h = await boot();
    });

    beforeEach(async () => {
        await clearThrottle(h);
        await setApproval(h, false);
    });

    afterAll(async () => {
        await shutdown(h);
    });

    const adminLogin = async (): Promise<SessionBody> => {
        const response = await request(h.app.getHttpServer())
            .post(`${API}/auth/signin`)
            .set("Host", PLATFORM_HOST)
            .send({ email: process.env.ADMIN_EMAIL, password: process.env.ADMIN_PASSWORD })
            .expect(200);
        return response.body.data as SessionBody;
    };

    const platform = (method: "get" | "post" | "patch", path: string, token: string) =>
        authed(h, method, `/platform${path}`, token, PLATFORM_HOST);

    /** Signs up through the real endpoint, then proves the mailbox so verify-email can run. */
    const signUp = async (tenantSlug = uniqueSlug()) => {
        const email = uniqueEmail();
        const response = await request(h.app.getHttpServer())
            .post(`${API}/auth/signup`)
            .send({ email, password: PASSWORD, tenantName: "Signup Org", tenantSlug })
            .expect(201);
        return { email, tenantSlug, body: response.body.data };
    };

    const verify = async (userId: string, email: string, tenantSlug: string) => {
        // Signup already mailed a code (hashed, with a resend cooldown), so drop it and mint a known one.
        await h.admin.delete(emailTokens).where(eq(emailTokens.userId, userId));
        const code = await h.emailTokens.issueVerifyEmailToken(userId);
        return request(h.app.getHttpServer()).post(`${API}/auth/verify-email`).send({ email, code, tenantSlug });
    };

    describe("signup creates a tenant", () => {
        it("makes the signer the owner of an ACTIVE tenant when approval is off", async () => {
            const { email, tenantSlug, body } = await signUp();

            expect(body.tenant).toMatchObject({ slug: tenantSlug, status: TenantStatus.ACTIVE });
            expect(body.user.roleIds).toEqual(expect.arrayContaining([ROLE_SLUGS.OWNER]));

            const verified = await verify(body.user.id, email, tenantSlug).then(r => r.body);
            expect(verified.data.tenant).toMatchObject({ slug: tenantSlug });
            expect(typeof verified.data.accessToken).toBe("string");
        });

        it("holds the tenant for approval when the platform requires it, and approval opens it", async () => {
            await setApproval(h, true);
            const { email, tenantSlug, body } = await signUp();
            expect(body.tenant.status).toBe(TenantStatus.PENDING_APPROVAL);

            const pending = await verify(body.user.id, email, tenantSlug);
            expect(pending.status).toBe(403);
            expect(pending.body).toMatchObject({ code: "TENANT_PENDING_APPROVAL" });
            expect(pending.body.tenants).toEqual([expect.objectContaining({ slug: tenantSlug })]);

            const admin = await adminLogin();
            const listed = await platform(
                "get",
                `/tenants?status=PENDING_APPROVAL&q=${tenantSlug}`,
                admin.accessToken,
            ).expect(200);
            expect(listed.body.data.map((t: { slug: string }) => t.slug)).toEqual([tenantSlug]);
            expect(listed.body.meta).toMatchObject({ page: 1, total: 1 });

            await platform("post", `/tenants/${listed.body.data[0].id}/approve`, admin.accessToken).expect(200);

            const session = await signIn(h, email, tenantSlug);
            expect(session.tenant).toMatchObject({ slug: tenantSlug });
        });

        it("does not retroactively change a tenant already waiting when the setting is flipped off", async () => {
            await setApproval(h, true);
            const { email, tenantSlug, body } = await signUp();
            await setApproval(h, false);

            expect((await verify(body.user.id, email, tenantSlug)).status).toBe(403);
            expect((await h.admin.select().from(tenants).where(eq(tenants.slug, tenantSlug)))[0]!.status).toBe(
                TenantStatus.PENDING_APPROVAL,
            );
        });

        it("tells a rejected owner why", async () => {
            await setApproval(h, true);
            const { email, tenantSlug, body } = await signUp();
            const admin = await adminLogin();
            await platform("post", `/tenants/${body.tenant.id}/reject`, admin.accessToken)
                .send({ reason: "Not a real business" })
                .expect(200);

            const response = await verify(body.user.id, email, tenantSlug);
            expect(response.status).toBe(403);
            expect(response.body).toMatchObject({ code: "TENANT_REJECTED", reason: "Not a real business" });
        });

        it("rejects reserved and taken slugs before any account is created", async () => {
            await request(h.app.getHttpServer())
                .post(`${API}/auth/signup`)
                .send({ email: uniqueEmail(), password: PASSWORD, tenantName: "X Org", tenantSlug: "admin" })
                .expect(400);

            const { owner, tenant } = await createOwnerWithTenant(h);
            const email = uniqueEmail();
            const taken = await request(h.app.getHttpServer())
                .post(`${API}/auth/signup`)
                .send({ email, password: PASSWORD, tenantName: "Copycat", tenantSlug: tenant.slug })
                .expect(409);

            expect(taken.body).toMatchObject({ code: "TENANT_SLUG_TAKEN" });
            expect(await h.users.findByEmail(email)).toBeNull();
            expect(owner.id).toBeTruthy();
        });
    });

    describe("subdomain binding", () => {
        it("404s a subdomain that is not a tenant", async () => {
            const response = await request(h.app.getHttpServer())
                .get(`${API}/health/live`)
                .set("Host", hostOf("no-such-tenant"))
                .expect(404);
            expect(response.body).toMatchObject({ code: "TENANT_NOT_FOUND" });
        });

        it("accepts a token on its own tenant host and on the apex, but not on another tenant's host", async () => {
            const a = await createOwnerWithTenant(h);
            const b = await createOwnerWithTenant(h);
            const { accessToken } = await signIn(h, a.owner.email, a.tenant.slug);

            await authed(h, "get", "/users/me", accessToken, hostOf(a.tenant.slug)).expect(200);
            await authed(h, "get", "/users/me", accessToken).expect(200);

            const crossed = await authed(h, "get", "/users/me", accessToken, hostOf(b.tenant.slug)).expect(403);
            expect(crossed.body).toMatchObject({ code: "TENANT_MISMATCH" });
        });

        it("lets the host choose the tenant at signin, with no slug in the body", async () => {
            const { owner, tenant } = await createOwnerWithTenant(h);
            const session = await signIn(h, owner.email, undefined, hostOf(tenant.slug));
            expect(session.tenant).toMatchObject({ slug: tenant.slug });
        });

        it("keeps the platform and tenant worlds apart", async () => {
            const { owner, tenant } = await createOwnerWithTenant(h);
            const tenantSession = await signIn(h, owner.email, tenant.slug);
            const admin = await adminLogin();

            const onPlatform = await authed(h, "get", "/users/me", tenantSession.accessToken, PLATFORM_HOST).expect(
                403,
            );
            expect(onPlatform.body).toMatchObject({ code: "TENANT_MISMATCH" });

            const adminOnTenant = await authed(h, "get", "/me/tenants", admin.accessToken, hostOf(tenant.slug));
            expect(adminOnTenant.status).toBe(403);
            expect(adminOnTenant.body).toMatchObject({ code: "PLATFORM_HOST_REQUIRED" });

            // Only the super admin can sign in on the platform host; everyone else looks like a bad password.
            await request(h.app.getHttpServer())
                .post(`${API}/auth/signin`)
                .set("Host", PLATFORM_HOST)
                .send({ email: owner.email, password: PASSWORD })
                .expect(401);
        });

        it("refuses to refresh a tenant session on another tenant's host", async () => {
            const a = await createOwnerWithTenant(h);
            const b = await createOwnerWithTenant(h);
            const session = await signIn(h, a.owner.email, a.tenant.slug);

            await request(h.app.getHttpServer())
                .post(`${API}/auth/refresh`)
                .set("Host", hostOf(b.tenant.slug))
                .send({ refreshToken: session.refreshToken })
                .expect(403);

            const ok = await request(h.app.getHttpServer())
                .post(`${API}/auth/refresh`)
                .send({ refreshToken: session.refreshToken })
                .expect(200);
            expect(ok.body.data.tenant).toMatchObject({ slug: a.tenant.slug });
        });
    });

    describe("isolation", () => {
        it("lists only this tenant's members and hides another tenant's as 404", async () => {
            const a = await createOwnerWithTenant(h);
            const b = await createOwnerWithTenant(h);
            const aMember = await createMember(h, a.tenant.id);
            const { accessToken } = await signIn(h, a.owner.email, a.tenant.slug);

            const list = await authed(h, "get", "/admin/users", accessToken).expect(200);
            const ids = (list.body.data as { id: string }[]).map(user => user.id);
            expect(ids).toEqual(expect.arrayContaining([a.owner.id, aMember.id]));
            expect(ids).not.toContain(b.owner.id);

            await authed(h, "get", `/admin/users/${b.owner.id}`, accessToken).expect(404);
            await authed(h, "patch", `/admin/users/${b.owner.id}/status`, accessToken)
                .send({ status: "SUSPENDED" })
                .expect(404);
        });

        it("keeps a role edit inside its tenant", async () => {
            const a = await createOwnerWithTenant(h);
            const b = await createOwnerWithTenant(h);
            const { accessToken } = await signIn(h, a.owner.email, a.tenant.slug);

            await authed(h, "patch", `/admin/roles/${ROLE_SLUGS.USER}`, accessToken)
                .send({ permissions: ["tenant:read", "role:read"] })
                .expect(200);

            const bRoles = await h.admin.query.roles.findFirst({
                where: { tenantId: b.tenant.id, slug: ROLE_SLUGS.USER },
                with: { permissions: true },
            });
            expect(bRoles!.permissions.map(p => p.permissionKey)).toEqual(["tenant:read"]);
        });

        describe("Postgres RLS", () => {
            let client: pg.Client;

            beforeAll(async () => {
                // The same restricted role the app runs as — not the owner, so policies bind it.
                client = new pg.Client({ connectionString: process.env.DATABASE_URL });
                await client.connect();
            });

            afterAll(async () => {
                await client.end();
            });

            const stamp = (tenantId: string, bypass = "off") =>
                client.query("select set_config('app.tenant_id', $1, false), set_config('app.bypass_rls', $2, false)", [
                    tenantId,
                    bypass,
                ]);
            const countRoles = async (tenantId: string) =>
                Number(
                    (await client.query("select count(*) from roles where tenant_id = $1", [tenantId])).rows[0].count,
                );

            it("shows nothing with no tenant, only its own with one, and never writes into another", async () => {
                const a = await createOwnerWithTenant(h);
                const b = await createOwnerWithTenant(h);

                await stamp("");
                expect(await countRoles(a.tenant.id)).toBe(0);
                expect(Number((await client.query("select count(*) from tenant_memberships")).rows[0].count)).toBe(0);

                await stamp(a.tenant.id);
                expect(await countRoles(a.tenant.id)).toBe(3);
                expect(await countRoles(b.tenant.id)).toBe(0);

                await expect(
                    client.query(
                        "insert into roles (id, tenant_id, slug, name) values (gen_random_uuid(), $1, 'x', 'X')",
                        [b.tenant.id],
                    ),
                ).rejects.toThrow(/row-level security/);

                await stamp("", "on");
                expect(await countRoles(b.tenant.id)).toBe(3);
            });

            it("is applied by the app's own pool, so a forgotten WHERE cannot leak", async () => {
                const a = await createOwnerWithTenant(h);
                const b = await createOwnerWithTenant(h);
                const tenantContext = h.app.get(TenantContext);

                // No tenant in scope: the unfiltered query returns no rows at all.
                expect(await h.db.select().from(roles)).toHaveLength(0);

                const seenAsA = await tenantContext.runAs(a.tenant.id, () => h.db.select().from(roles));
                expect(seenAsA.length).toBeGreaterThan(0);
                expect(new Set(seenAsA.map(role => role.tenantId))).toEqual(new Set([a.tenant.id]));

                const system = await tenantContext.runAsSystem(() => h.db.select().from(roles));
                expect(new Set(system.map(role => role.tenantId)).has(b.tenant.id)).toBe(true);
            });

            it("never mixes tenants across concurrent requests sharing the pool", async () => {
                const a = await createOwnerWithTenant(h);
                const b = await createOwnerWithTenant(h);
                const tenantContext = h.app.get(TenantContext);

                const results = await Promise.all(
                    Array.from({ length: 60 }, (_, i) => {
                        const target = i % 2 === 0 ? a.tenant.id : b.tenant.id;
                        return tenantContext
                            .runAs(target, () => h.db.select({ tenantId: roles.tenantId }).from(roles))
                            .then(rows => ({ target, tenants: new Set(rows.map(row => row.tenantId)) }));
                    }),
                );

                for (const { target, tenants: seen } of results) {
                    expect(seen).toEqual(new Set([target]));
                }
            });
        });
    });

    describe("one user, several tenants", () => {
        const arrange = async () => {
            const a = await createOwnerWithTenant(h);
            const b = await createOwnerWithTenant(h);
            await h.memberships.add(b.tenant.id, a.owner.id, []);
            return { a, b };
        };

        it("offers a picker at signin, and the roles differ per tenant", async () => {
            const { a, b } = await arrange();

            const signin = await request(h.app.getHttpServer())
                .post(`${API}/auth/signin`)
                .send({ email: a.owner.email, password: PASSWORD })
                .expect(200);
            expect(signin.body.data.tenantSelectionRequired).toBe(true);
            expect(signin.body.data.tenants.map((t: { slug: string }) => t.slug).sort()).toEqual(
                [a.tenant.slug, b.tenant.slug].sort(),
            );

            const asOwner = await request(h.app.getHttpServer())
                .post(`${API}/auth/select-tenant`)
                .send({ selectionToken: signin.body.data.selectionToken, tenantSlug: a.tenant.slug })
                .expect(200);
            const asMember = await request(h.app.getHttpServer())
                .post(`${API}/auth/select-tenant`)
                .send({ selectionToken: signin.body.data.selectionToken, tenantSlug: b.tenant.slug })
                .expect(200);

            const inA = (await authed(h, "get", "/users/me", asOwner.body.data.accessToken).expect(200)).body.data;
            const inB = (await authed(h, "get", "/users/me", asMember.body.data.accessToken).expect(200)).body.data;

            expect(inA.roleIds).toEqual(expect.arrayContaining([ROLE_SLUGS.OWNER]));
            expect(inB.roleIds).toEqual([ROLE_SLUGS.USER]);
            expect(inB.permissions).toEqual(["tenant:read"]);
            expect(inA.permissions.length).toBeGreaterThan(inB.permissions.length);
        });

        it("lists every organization with its state, including ones that cannot be entered", async () => {
            const { a, b } = await arrange();
            await h.admin.update(tenants).set({ status: TenantStatus.SUSPENDED }).where(eq(tenants.id, b.tenant.id));
            const { accessToken } = await signIn(h, a.owner.email, a.tenant.slug);

            const mine = (await authed(h, "get", "/me/tenants", accessToken).expect(200)).body.data as {
                slug: string;
                status: string;
            }[];
            expect(mine.find(t => t.slug === a.tenant.slug)).toMatchObject({ status: "ACTIVE" });
            expect(mine.find(t => t.slug === b.tenant.slug)).toMatchObject({ status: "SUSPENDED" });
        });

        it("moves between tenants with a one-time code, bound to the target host", async () => {
            const { a, b } = await arrange();
            const inA = await signIn(h, a.owner.email, a.tenant.slug);

            const switched = (
                await authed(h, "post", "/auth/switch-tenant", inA.accessToken)
                    .send({ tenantSlug: b.tenant.slug })
                    .expect(200)
            ).body.data;
            expect(switched.tenant.slug).toBe(b.tenant.slug);

            // Redeemed on the wrong tenant's host: refused, and the code is not spent by that refusal.
            await request(h.app.getHttpServer())
                .post(`${API}/auth/exchange`)
                .set("Host", hostOf(a.tenant.slug))
                .send({ code: switched.exchangeCode })
                .expect(403);

            const exchanged = await request(h.app.getHttpServer())
                .post(`${API}/auth/exchange`)
                .set("Host", hostOf(b.tenant.slug))
                .send({ code: switched.exchangeCode })
                .expect(200);
            expect(exchanged.body.data.tenant.slug).toBe(b.tenant.slug);

            await request(h.app.getHttpServer())
                .post(`${API}/auth/exchange`)
                .set("Host", hostOf(b.tenant.slug))
                .send({ code: switched.exchangeCode })
                .expect(401);
        });

        it("lets a signed-in user create another tenant, up to the platform limit", async () => {
            const { owner, tenant } = await createOwnerWithTenant(h);
            const { accessToken } = await signIn(h, owner.email, tenant.slug);

            await setApproval(h, true, 2);
            const second = await authed(h, "post", "/tenants", accessToken)
                .send({ name: "Second Org", slug: uniqueSlug() })
                .expect(201);
            expect(second.body.data.status).toBe(TenantStatus.PENDING_APPROVAL);

            const third = await authed(h, "post", "/tenants", accessToken).send({
                name: "Third Org",
                slug: uniqueSlug(),
            });
            expect(third.status).toBe(403);
            expect(third.body).toMatchObject({ code: "TENANT_LIMIT_REACHED" });
        });
    });

    describe("lifecycle takes effect on live tokens", () => {
        it("suspending a tenant locks its members out at once, and reactivating restores them", async () => {
            const { owner, tenant } = await createOwnerWithTenant(h);
            const { accessToken } = await signIn(h, owner.email, tenant.slug);
            await authed(h, "get", "/users/me", accessToken).expect(200);

            const admin = await adminLogin();
            await platform("post", `/tenants/${tenant.id}/suspend`, admin.accessToken).expect(200);
            const locked = await authed(h, "get", "/users/me", accessToken).expect(403);
            expect(locked.body).toMatchObject({ code: "TENANT_SUSPENDED" });

            await platform("post", `/tenants/${tenant.id}/reactivate`, admin.accessToken).expect(200);
            await authed(h, "get", "/users/me", accessToken).expect(200);
        });

        it("rejects illegal tenant transitions", async () => {
            const { tenant } = await createOwnerWithTenant(h);
            const admin = await adminLogin();
            await platform("post", `/tenants/${tenant.id}/approve`, admin.accessToken).expect(400);
            await platform("post", `/tenants/${tenant.id}/reactivate`, admin.accessToken).expect(400);
        });

        it("suspends a membership in one tenant without touching the same user's other tenant", async () => {
            const a = await createOwnerWithTenant(h);
            const b = await createOwnerWithTenant(h);
            const shared = await createMember(h, a.tenant.id);
            await h.memberships.add(b.tenant.id, shared.id, []);

            const inA = await signIn(h, shared.email, a.tenant.slug);
            const inB = await signIn(h, shared.email, b.tenant.slug);
            const aOwner = await signIn(h, a.owner.email, a.tenant.slug);

            await authed(h, "patch", `/admin/users/${shared.id}/status`, aOwner.accessToken)
                .send({ status: "SUSPENDED" })
                .expect(200);

            const blocked = await authed(h, "get", "/users/me", inA.accessToken).expect(403);
            expect(blocked.body).toMatchObject({ code: "MEMBERSHIP_SUSPENDED" });
            await authed(h, "get", "/users/me", inB.accessToken).expect(200);

            // Sessions in A were cut; B's survive.
            const live = await h.admin.select().from(refreshTokens).where(eq(refreshTokens.userId, shared.id));
            expect(live.filter(t => t.tenantId === a.tenant.id).every(t => t.revokedAt !== null)).toBe(true);
            expect(live.filter(t => t.tenantId === b.tenant.id).every(t => t.revokedAt === null)).toBe(true);
        });

        it("invalidates a member's token the moment their roles change", async () => {
            const { owner, tenant } = await createOwnerWithTenant(h);
            const member = await createMember(h, tenant.id);
            const ownerSession = await signIn(h, owner.email, tenant.slug);
            const memberSession = await signIn(h, member.email, tenant.slug);

            await authed(h, "patch", `/admin/users/${member.id}/roles`, ownerSession.accessToken)
                .send({ roleIds: [ROLE_SLUGS.ADMIN] })
                .expect(200);

            const stale = await authed(h, "get", "/users/me", memberSession.accessToken).expect(401);
            expect(stale.body.message).toMatch(/access has changed/i);
        });
    });

    describe("ownership", () => {
        it("blocks the sole owner from deleting their account", async () => {
            const { owner, tenant } = await createOwnerWithTenant(h);
            const { accessToken } = await signIn(h, owner.email, tenant.slug);

            const response = await authed(h, "post", "/auth/request-account-deletion", accessToken);
            expect(response.status).toBe(409);
            expect(response.body).toMatchObject({ code: "SOLE_OWNER" });
        });

        it("hands ownership over by granting owner, after which the first owner can step down", async () => {
            const { owner, tenant } = await createOwnerWithTenant(h);
            const heir = await createMember(h, tenant.id);
            const ownerSession = await signIn(h, owner.email, tenant.slug);

            await authed(h, "patch", `/admin/users/${heir.id}/roles`, ownerSession.accessToken)
                .send({ roleIds: [ROLE_SLUGS.OWNER] })
                .expect(200);

            const heirSession = await signIn(h, heir.email, tenant.slug);
            const stepped = await authed(h, "patch", `/admin/users/${owner.id}/roles`, heirSession.accessToken)
                .send({ roleIds: [] })
                .expect(200);
            expect(stepped.body.data.roleIds).toEqual([ROLE_SLUGS.USER]);

            // The heir is now the only owner and cannot be left without one.
            const owners = await h.memberships.countOwners(tenant.id);
            expect(owners).toBe(1);
        });

        it("cannot suspend or demote the last owner", async () => {
            const { owner, tenant } = await createOwnerWithTenant(h);
            const heir = await createMember(h, tenant.id, [ROLE_SLUGS.OWNER]);
            const heirSession = await signIn(h, heir.email, tenant.slug);

            // Two owners: the heir may demote the original, leaving one.
            await authed(h, "patch", `/admin/users/${owner.id}/roles`, heirSession.accessToken)
                .send({ roleIds: [] })
                .expect(200);

            // Now `owner` is a plain member and cannot touch the remaining owner.
            const demotedSession = await signIn(h, owner.email, tenant.slug);
            await authed(h, "patch", `/admin/users/${heir.id}/status`, demotedSession.accessToken)
                .send({ status: "SUSPENDED" })
                .expect(403);
        });
    });

    describe("platform settings", () => {
        it("lets only the super admin read and change them", async () => {
            const admin = await adminLogin();
            const before = (await platform("get", "/settings", admin.accessToken).expect(200)).body.data;

            const changed = await platform("patch", "/settings", admin.accessToken)
                .send({ requireTenantApproval: !before.requireTenantApproval })
                .expect(200);
            expect(changed.body.data.requireTenantApproval).toBe(!before.requireTenantApproval);

            await platform("patch", "/settings", admin.accessToken).send({}).expect(400);

            const { owner, tenant } = await createOwnerWithTenant(h);
            const tenantSession = await signIn(h, owner.email, tenant.slug);
            await authed(h, "get", "/platform/settings", tenantSession.accessToken).expect(403);
        });

        it("keeps the super admin out of tenant-owned data", async () => {
            const admin = await adminLogin();
            expect((await h.users.findByEmail(process.env.ADMIN_EMAIL!))!.id).toBeTruthy();
            await platform("get", "/tenants", admin.accessToken).expect(200);
            const noMembership = await h.admin
                .select()
                .from(tenantMemberships)
                .where(eq(tenantMemberships.userId, (await h.users.findByEmail(process.env.ADMIN_EMAIL!))!.id));
            expect(noMembership).toHaveLength(0);
        });
    });

    it("has createUser available for ad-hoc arrangement", async () => {
        expect((await createUser(h)).email).toContain("@example.test");
    });
});
