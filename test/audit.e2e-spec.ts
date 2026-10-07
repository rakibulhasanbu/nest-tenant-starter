import { eq } from "drizzle-orm";
import request from "supertest";
import { TenantContext } from "@/common/tenant/tenant-context.js";
import { auditLogs } from "@/database/schema/audit-logs.js";
import {
    API,
    PLATFORM_HOST,
    authed,
    boot,
    clearThrottle,
    createMember,
    createOwnerWithTenant,
    hostOf,
    shutdown,
    signIn,
    type Harness,
    type SessionBody,
} from "./helpers/harness.js";

/** Audit entries come from domain events, so each test waits a beat for the listener to write. */
describe("Audit log (e2e)", () => {
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

    const settle = () => new Promise(resolve => setTimeout(resolve, 100));

    const adminLogin = async (): Promise<SessionBody> => {
        const response = await request(h.app.getHttpServer())
            .post(`${API}/auth/signin`)
            .set("Host", PLATFORM_HOST)
            .send({ email: process.env.ADMIN_EMAIL, password: process.env.ADMIN_PASSWORD })
            .expect(200);
        return response.body.data as SessionBody;
    };

    const trail = async (token: string, host: string, query = "") =>
        (await authed(h, "get", `/audit-logs${query}`, token, host).expect(200)).body as {
            data: {
                action: string;
                actorId: string | null;
                targetId: string | null;
                metadata: Record<string, unknown>;
                requestId: string | null;
            }[];
            meta: { total: number };
        };

    it("records role and membership changes with who did them, and shows them to the tenant only", async () => {
        const a = await createOwnerWithTenant(h);
        const b = await createOwnerWithTenant(h);
        const member = await createMember(h, a.tenant.id);
        const tokenA = (await signIn(h, a.owner.email, a.tenant.slug)).accessToken;
        const tokenB = (await signIn(h, b.owner.email, b.tenant.slug)).accessToken;
        const hostA = hostOf(a.tenant.slug);

        await authed(h, "patch", `/admin/users/${member.id}/roles`, tokenA, hostA)
            .send({ roleIds: ["admin"] })
            .expect(200);
        await authed(h, "patch", `/admin/users/${member.id}/status`, tokenA, hostA)
            .send({ status: "SUSPENDED" })
            .expect(200);
        await authed(h, "post", "/admin/roles", tokenA, hostA)
            .send({ id: "auditor", name: "Auditor", rank: 10, permissions: ["tenant:read"] })
            .expect(201);
        await authed(h, "patch", "/admin/roles/auditor", tokenA, hostA).send({ name: "Auditor 2" }).expect(200);
        await authed(h, "delete", "/admin/roles/auditor", tokenA, hostA).expect(204);
        await settle();

        const seen = await trail(tokenA, hostA);
        const actions = seen.data.map(row => row.action);
        expect(actions).toEqual(
            expect.arrayContaining([
                "membership.roles-assigned",
                "membership.status-changed",
                "role.created",
                "role.updated",
                "role.deleted",
            ]),
        );
        const assigned = seen.data.find(row => row.action === "membership.roles-assigned")!;
        expect(assigned).toMatchObject({ actorId: a.owner.id, targetId: member.id });
        expect(assigned.metadata).toMatchObject({ roles: expect.arrayContaining(["admin"]) });
        // Ties back to the request's log lines.
        expect(assigned.requestId).toEqual(expect.any(String));

        // Filtering by action prefix, and tenant B sees none of it.
        const roles = await trail(tokenA, hostA, "?action=role.*");
        expect(roles.data.every(row => row.action.startsWith("role."))).toBe(true);
        const other = await trail(tokenB, hostOf(b.tenant.slug));
        expect(other.data.some(row => row.targetId === member.id)).toBe(false);
    });

    it("keeps the trail from members who lack the permission", async () => {
        const a = await createOwnerWithTenant(h);
        const plain = await createMember(h, a.tenant.id);
        const token = (await signIn(h, plain.email, a.tenant.slug)).accessToken;
        await authed(h, "get", "/audit-logs", token, hostOf(a.tenant.slug)).expect(403);
    });

    it("records a super-admin decision against the tenant and at platform level", async () => {
        const a = await createOwnerWithTenant(h);
        const admin = await adminLogin();

        await authed(h, "post", `/platform/tenants/${a.tenant.id}/suspend`, admin.accessToken, PLATFORM_HOST).expect(
            200,
        );
        await authed(h, "post", `/platform/tenants/${a.tenant.id}/reactivate`, admin.accessToken, PLATFORM_HOST).expect(
            200,
        );
        await settle();

        const tokenA = (await signIn(h, a.owner.email, a.tenant.slug)).accessToken;
        const own = await trail(tokenA, hostOf(a.tenant.slug), "?action=tenant.*");
        expect(own.data.map(row => row.action)).toEqual(
            expect.arrayContaining(["tenant.suspended", "tenant.reactivated"]),
        );
        expect(own.data.find(row => row.action === "tenant.suspended")!.actorId).not.toBeNull();

        const all = await authed(
            h,
            "get",
            `/platform/audit-logs?tenantId=${a.tenant.id}`,
            admin.accessToken,
            PLATFORM_HOST,
        ).expect(200);
        expect(all.body.meta.total).toBeGreaterThanOrEqual(2);

        // Tenant sessions cannot reach the platform trail.
        await authed(h, "get", "/platform/audit-logs", tokenA, hostOf(a.tenant.slug)).expect(403);
    });

    it("cannot be edited or erased through the application's database role", async () => {
        const a = await createOwnerWithTenant(h);
        const member = await createMember(h, a.tenant.id);
        const token = (await signIn(h, a.owner.email, a.tenant.slug)).accessToken;
        await authed(h, "patch", `/admin/users/${member.id}/status`, token, hostOf(a.tenant.slug))
            .send({ status: "SUSPENDED" })
            .expect(200);
        await settle();

        const [row] = await h.admin.select().from(auditLogs).where(eq(auditLogs.tenantId, a.tenant.id));
        expect(row).toBeDefined();

        // The app's pool (the restricted role), even in system scope, may only add and read.
        const tenantContext = h.app.get(TenantContext);
        await expect(
            tenantContext.runAsSystem(() =>
                h.db.update(auditLogs).set({ action: "tampered" }).where(eq(auditLogs.id, row!.id)),
            ),
        ).rejects.toThrow();
        await expect(
            tenantContext.runAsSystem(() => h.db.delete(auditLogs).where(eq(auditLogs.id, row!.id))),
        ).rejects.toThrow();
    });
});
