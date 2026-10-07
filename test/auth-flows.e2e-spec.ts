import { and, eq } from "drizzle-orm";
import { randomUUID } from "node:crypto";
import request from "supertest";
import { PERMISSIONS, TENANT_PERMISSION_KEYS } from "@/common/authorization/permissions.constant.js";
import { ROLE_SLUGS } from "@/common/authorization/role-templates.constant.js";
import { rolePermissions, roles } from "@/database/schema/authorization.js";
import { UserStatus } from "@/database/schema/enums.js";
import { users as usersTable } from "@/database/schema/users.js";
import {
    API,
    PASSWORD,
    PREFIX,
    authed,
    boot,
    clearThrottle,
    createMember,
    createOwnerWithTenant,
    shutdown,
    signIn,
    uniqueEmail,
    type Harness,
} from "./helpers/harness.js";

/**
 * The single-tenant flows that existed before multi-tenancy, now exercised inside
 * a tenant: reactivation, set-password, sessions, invite, roles. Boots the real
 * application graph, so it needs the same PostgreSQL and Redis `pnpm start:dev` does.
 */
describe("Auth and admin flows (e2e)", () => {
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

    describe("GET /users/me", () => {
        it("describes the caller — roles, permissions and password state, never the secrets", async () => {
            const { owner, tenant } = await createOwnerWithTenant(h);
            const { accessToken } = await signIn(h, owner.email, tenant.slug);

            const me = (await authed(h, "get", "/users/me", accessToken).expect(200)).body.data;

            expect(me).toMatchObject({
                email: owner.email,
                roleIds: expect.arrayContaining([ROLE_SLUGS.OWNER, ROLE_SLUGS.USER]),
                maxRank: 100,
                hasPassword: true,
                profile: null,
            });
            expect([...me.permissions].sort((x: string, y: string) => x.localeCompare(y))).toEqual(
                [...TENANT_PERMISSION_KEYS].sort((x, y) => x.localeCompare(y)),
            );
            expect(me).not.toHaveProperty("password");
            expect(me).not.toHaveProperty("twoFactorSecret");
        });

        it("gives a plain member the baseline role and almost nothing else", async () => {
            const { tenant } = await createOwnerWithTenant(h);
            const member = await createMember(h, tenant.id);
            const { accessToken } = await signIn(h, member.email, tenant.slug);

            const me = (await authed(h, "get", "/users/me", accessToken).expect(200)).body.data;

            expect(me).toMatchObject({
                roleIds: [ROLE_SLUGS.USER],
                maxRank: 0,
                permissions: [PERMISSIONS.TENANT_READ],
            });
        });
    });

    describe("/users/me/notifications", () => {
        it("defaults every channel on, then persists a partial update", async () => {
            const { owner, tenant } = await createOwnerWithTenant(h);
            const { accessToken } = await signIn(h, owner.email, tenant.slug);

            const before = await authed(h, "get", "/users/me/notifications", accessToken).expect(200);
            expect(before.body.data).toEqual({
                loginEmailNotification: true,
                transactionsEmailNotification: true,
                transactionsPushNotification: true,
            });

            await authed(h, "patch", "/users/me/notifications", accessToken)
                .send({ transactionsPushNotification: false })
                .expect(200);

            const after = await authed(h, "get", "/users/me/notifications", accessToken).expect(200);
            expect(after.body.data.transactionsPushNotification).toBe(false);
        });

        it("rejects unknown channels", async () => {
            const { owner, tenant } = await createOwnerWithTenant(h);
            const { accessToken } = await signIn(h, owner.email, tenant.slug);

            await authed(h, "patch", "/users/me/notifications", accessToken)
                .send({ smsNotification: true })
                .expect(400);
        });
    });

    describe("GET /auth/sessions", () => {
        it("marks the session the request came from, and only that one", async () => {
            const { owner, tenant } = await createOwnerWithTenant(h);
            const first = await signIn(h, owner.email, tenant.slug);
            await signIn(h, owner.email, tenant.slug);

            const sessions = (await authed(h, "get", "/auth/sessions", first.accessToken).expect(200)).body.data as {
                id: string;
                isCurrent: boolean;
                tenantId: string;
            }[];

            expect(sessions).toHaveLength(2);
            expect(sessions.filter(session => session.isCurrent)).toHaveLength(1);
            expect(sessions.every(session => session.tenantId === tenant.id)).toBe(true);
        });

        it("revoking a session drops it from the list", async () => {
            const { owner, tenant } = await createOwnerWithTenant(h);
            const keep = await signIn(h, owner.email, tenant.slug);
            await signIn(h, owner.email, tenant.slug);

            const before = await authed(h, "get", "/auth/sessions", keep.accessToken).expect(200);
            const other = (before.body.data as { id: string; isCurrent: boolean }[]).find(s => !s.isCurrent)!;

            await authed(h, "delete", `/auth/sessions/${other.id}`, keep.accessToken).expect(204);

            const after = await authed(h, "get", "/auth/sessions", keep.accessToken).expect(200);
            expect(after.body.data).toHaveLength(1);
        });
    });

    describe("POST /auth/set-password", () => {
        it("sets a password for an account that has none, and refuses one that does", async () => {
            const { owner, tenant } = await createOwnerWithTenant(h);
            const { accessToken } = await signIn(h, owner.email, tenant.slug);

            // Stand in for a Google-only account.
            await h.admin.update(usersTable).set({ password: null }).where(eq(usersTable.id, owner.id));

            expect((await authed(h, "get", "/users/me", accessToken).expect(200)).body.data.hasPassword).toBe(false);
            await authed(h, "post", "/auth/set-password", accessToken).send({ newPassword: PASSWORD }).expect(204);
            expect((await authed(h, "get", "/users/me", accessToken).expect(200)).body.data.hasPassword).toBe(true);
            await authed(h, "post", "/auth/set-password", accessToken).send({ newPassword: PASSWORD }).expect(400);
        });
    });

    describe("account reactivation", () => {
        it("answers a deleted account's sign-in with a 409 that carries the deadline", async () => {
            const { owner, tenant } = await createOwnerWithTenant(h);
            await h.admin.update(usersTable).set({ deletedAt: new Date() }).where(eq(usersTable.id, owner.id));

            const response = await request(h.app.getHttpServer())
                .post(`${API}/auth/signin`)
                .send({ email: owner.email, password: PASSWORD, tenantSlug: tenant.slug })
                .expect(409);

            expect(response.body).toMatchObject({ statusCode: 409, code: "ACCOUNT_PENDING_DELETION" });
            expect(Number.isNaN(Date.parse(response.body.graceEndsAt))).toBe(false);
        });

        it("restores the account once the emailed code is consumed", async () => {
            const { owner, tenant } = await createOwnerWithTenant(h);
            await h.admin.update(usersTable).set({ deletedAt: new Date() }).where(eq(usersTable.id, owner.id));
            const code = await h.emailTokens.issueReactivateAccountToken(owner.id);

            await request(h.app.getHttpServer())
                .post(`${API}/auth/reactivate-account`)
                .send({ email: owner.email, code })
                .expect(204);

            await signIn(h, owner.email, tenant.slug);
        });

        it("rejects a wrong code without saying why", async () => {
            const { owner } = await createOwnerWithTenant(h);
            await h.admin.update(usersTable).set({ deletedAt: new Date() }).where(eq(usersTable.id, owner.id));
            await h.emailTokens.issueReactivateAccountToken(owner.id);

            await request(h.app.getHttpServer())
                .post(`${API}/auth/reactivate-account`)
                .send({ email: owner.email, code: "000000" })
                .expect(400);
        });
    });

    describe("admin surface (inside one tenant)", () => {
        /** A runtime role, as the RBAC UI creates them — the seeded `admin` cannot assign roles. */
        const createInviterRole = async (tenantId: string) => {
            const slug = `${PREFIX}role-${randomUUID().slice(0, 6)}`;
            const [role] = await h.admin
                .insert(roles)
                .values({ tenantId, slug, name: "E2E Inviter", rank: 60 })
                .returning({ id: roles.id });
            await h.admin
                .insert(rolePermissions)
                .values(
                    [
                        PERMISSIONS.USER_INVITE,
                        PERMISSIONS.USER_READ_ANY,
                        PERMISSIONS.ROLE_READ,
                        PERMISSIONS.ROLE_ASSIGN,
                    ].map(permissionKey => ({ tenantId, roleId: role!.id, permissionKey })),
                );
            return slug;
        };

        it("invites a brand-new address as a member with the requested roles", async () => {
            const { tenant } = await createOwnerWithTenant(h);
            const inviter = await createMember(h, tenant.id, [await createInviterRole(tenant.id)]);
            const { accessToken } = await signIn(h, inviter.email, tenant.slug);

            const inviteeEmail = uniqueEmail();
            const response = await authed(h, "post", "/admin/users/invite", accessToken)
                .send({ email: inviteeEmail, roleIds: [ROLE_SLUGS.USER] })
                .expect(201);

            expect(response.body.data).toMatchObject({
                email: inviteeEmail,
                roleIds: [ROLE_SLUGS.USER],
                status: UserStatus.PENDING_VERIFICATION,
            });
        });

        it("adds an existing account as a member instead of creating a duplicate", async () => {
            const { owner, tenant } = await createOwnerWithTenant(h);
            const { owner: otherOwner } = await createOwnerWithTenant(h);
            const { accessToken } = await signIn(h, owner.email, tenant.slug);

            const response = await authed(h, "post", "/admin/users/invite", accessToken)
                .send({ email: otherOwner.email, roleIds: [] })
                .expect(201);

            expect(response.body.data).toMatchObject({ id: otherOwner.id, email: otherOwner.email });
            await authed(h, "post", "/admin/users/invite", accessToken)
                .send({ email: otherOwner.email, roleIds: [] })
                .expect(409);
        });

        it("refuses to grant a role at or above the inviter's own rank", async () => {
            const { tenant } = await createOwnerWithTenant(h);
            const inviter = await createMember(h, tenant.id, [await createInviterRole(tenant.id)]);
            const { accessToken } = await signIn(h, inviter.email, tenant.slug);

            await authed(h, "post", "/admin/users/invite", accessToken)
                .send({ email: uniqueEmail(), roleIds: [ROLE_SLUGS.OWNER] })
                .expect(403);
        });

        it("lists roles for a holder of role:read and 403s everyone else", async () => {
            const { tenant } = await createOwnerWithTenant(h);
            const privileged = await createMember(h, tenant.id, [await createInviterRole(tenant.id)]);
            const plain = await createMember(h, tenant.id);

            const withPermission = await signIn(h, privileged.email, tenant.slug);
            const response = await authed(h, "get", "/admin/roles", withPermission.accessToken).expect(200);
            expect((response.body.data as { id: string }[]).map(role => role.id)).toEqual(
                expect.arrayContaining([ROLE_SLUGS.USER, ROLE_SLUGS.ADMIN, ROLE_SLUGS.OWNER]),
            );

            const withoutPermission = await signIn(h, plain.email, tenant.slug);
            await authed(h, "get", "/admin/roles", withoutPermission.accessToken).expect(403);
            await authed(h, "get", "/admin/users", withoutPermission.accessToken).expect(403);
        });

        it("cannot edit a member's account — identity is global", async () => {
            const { owner, tenant } = await createOwnerWithTenant(h);
            const member = await createMember(h, tenant.id);
            const { accessToken } = await signIn(h, owner.email, tenant.slug);

            await authed(h, "patch", `/admin/users/${member.id}`, accessToken).send({ name: "Hacked" }).expect(404);
            await authed(h, "post", `/admin/users/${member.id}/restore`, accessToken).expect(404);
        });
    });

    it("keeps role rows out of other tenants' lists (tenant filter and RLS agree)", async () => {
        const a = await createOwnerWithTenant(h);
        const b = await createOwnerWithTenant(h);
        const { accessToken } = await signIn(h, a.owner.email, a.tenant.slug);

        const rows = await h.admin
            .select()
            .from(roles)
            .where(and(eq(roles.slug, ROLE_SLUGS.OWNER)));
        expect(rows.some(role => role.tenantId === b.tenant.id)).toBe(true);

        const seen = (await authed(h, "get", "/admin/roles", accessToken).expect(200)).body.data as {
            id: string;
        }[];
        expect(seen).toHaveLength(3);
    });
});
