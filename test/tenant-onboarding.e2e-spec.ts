import { eq } from "drizzle-orm";
import request from "supertest";
import { TenantOnboardingMode, TenantStatus } from "@/database/schema/enums.js";
import { platformSettings, tenants } from "@/database/schema/tenants.js";
import { EMAIL_SENDER, type EmailSender } from "@/integrations/email/email-sender.interface.js";
import {
    API,
    PASSWORD,
    PLATFORM_HOST,
    authed,
    boot,
    clearThrottle,
    hostOf,
    shutdown,
    uniqueEmail,
    uniqueSlug,
    type Harness,
    type SessionBody,
} from "./helpers/harness.js";

/**
 * Admin-led onboarding: with self signup off, a prospect submits a registration
 * request, the super admin approves it, creates the tenant and invites the owner,
 * and the owner accepts the invite and signs in.
 */
describe("Tenant onboarding (e2e)", () => {
    let h: Harness;
    let invites: ReturnType<typeof vi.spyOn>;

    beforeAll(async () => {
        h = await boot();
        invites = vi.spyOn(h.app.get<EmailSender>(EMAIL_SENDER), "sendTenantOwnerInvite");
    });

    beforeEach(async () => {
        await clearThrottle(h);
        invites.mockClear();
        await setMode(TenantOnboardingMode.ADMIN_ONLY);
    });

    afterAll(async () => {
        await shutdown(h);
    });

    const setMode = (mode: TenantOnboardingMode) =>
        h.admin.update(platformSettings).set({ tenantOnboardingMode: mode }).where(eq(platformSettings.id, 1));

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

    const formBody = (email = uniqueEmail()) => ({
        businessName: "E2E Bakery",
        ownerName: "Ada Baker",
        email,
        phone: "+8801700000000",
        dateOfBirth: "1990-05-20",
        address: "12 Baker Street, Dhaka",
        extra: { referral: "friend" },
    });

    const submit = (body: object) => request(h.app.getHttpServer()).post(`${API}/tenant-requests`).send(body);

    it("reports which flow the client should show", async () => {
        const adminOnly = await request(h.app.getHttpServer()).get(`${API}/tenant-requests/config`).expect(200);
        expect(adminOnly.body.data).toMatchObject({ mode: "ADMIN_ONLY", selfSignupEnabled: false });

        await setMode(TenantOnboardingMode.SELF_SIGNUP);
        const open = await request(h.app.getHttpServer()).get(`${API}/tenant-requests/config`).expect(200);
        expect(open.body.data).toMatchObject({ mode: "SELF_SIGNUP", selfSignupEnabled: true });
    });

    it("blocks self signup, and the registration form when self signup is on", async () => {
        const blocked = await request(h.app.getHttpServer())
            .post(`${API}/auth/signup`)
            .send({
                email: uniqueEmail(),
                password: PASSWORD,
                name: "Nope",
                tenantName: "Nope Org",
                tenantSlug: uniqueSlug(),
            })
            .expect(403);
        expect(blocked.body).toMatchObject({ code: "SELF_SIGNUP_DISABLED" });

        await setMode(TenantOnboardingMode.SELF_SIGNUP);
        const closed = await submit(formBody()).expect(403);
        expect(closed.body).toMatchObject({ code: "REGISTRATION_REQUESTS_DISABLED" });
    });

    it("rejects a duplicate open request for the same email", async () => {
        const body = formBody();
        await submit(body).expect(201);
        const again = await submit({ ...body, email: body.email.toUpperCase() }).expect(409);
        expect(again.body).toMatchObject({ code: "TENANT_REQUEST_ALREADY_OPEN" });
    });

    it("runs request → approve → create + invite → accept → sign in", async () => {
        const admin = await adminLogin();
        const body = formBody();
        const created = await submit(body).expect(201);
        const requestId = created.body.data.id as string;

        // Creating a tenant from a request nobody approved is refused.
        await platform("post", "/tenants", admin.accessToken)
            .send({ name: "E2E Bakery", slug: uniqueSlug(), requestId })
            .expect(409);

        const listed = await platform(
            "get",
            `/tenant-requests?status=PENDING&q=${body.email}`,
            admin.accessToken,
        ).expect(200);
        expect(listed.body.data).toHaveLength(1);

        await platform("post", `/tenant-requests/${requestId}/approve`, admin.accessToken).expect(200);
        await platform("post", `/tenant-requests/${requestId}/approve`, admin.accessToken).expect(409);

        const slug = uniqueSlug();
        const tenantResponse = await platform("post", "/tenants", admin.accessToken)
            .send({ name: "E2E Bakery", slug, requestId })
            .expect(201);
        expect(tenantResponse.body.data).toMatchObject({
            tenant: { slug, status: TenantStatus.ACTIVE },
            owner: { email: body.email, isNewAccount: true },
            inviteSent: true,
        });
        expect(invites).toHaveBeenCalledTimes(1);

        // One request seeds one tenant.
        await platform("post", "/tenants", admin.accessToken)
            .send({ name: "Again", slug: uniqueSlug(), requestId })
            .expect(409);

        // Resend is throttled right after sending.
        const reissue = await platform(
            "post",
            `/tenants/${tenantResponse.body.data.tenant.id}/resend-invite`,
            admin.accessToken,
        );
        expect(reissue.status).toBe(429);

        const { acceptUrl, expiresAt } = invites.mock.calls[0]![0] as { acceptUrl: string; expiresAt: Date };
        const token = new URL(acceptUrl).searchParams.get("token")!;
        expect(acceptUrl).toContain(`${slug}.`);
        const ttlDays = (new Date(expiresAt).getTime() - Date.now()) / 86_400_000;
        expect(ttlDays).toBeGreaterThan(6.9);

        // A wrong token is refused; the real one is single-use and sets the first password.
        await request(h.app.getHttpServer())
            .post(`${API}/auth/accept-invite`)
            .send({ token: "0".repeat(64), password: "Brand-new-pass1!" })
            .expect(400);

        const accepted = await request(h.app.getHttpServer())
            .post(`${API}/auth/accept-invite`)
            .send({ token, password: "Brand-new-pass1!" })
            .expect(200);
        expect(accepted.body.data.tenant).toMatchObject({ slug });

        await request(h.app.getHttpServer())
            .post(`${API}/auth/accept-invite`)
            .send({ token, password: "Another-pass1!" })
            .expect(400);

        await request(h.app.getHttpServer())
            .post(`${API}/auth/signin`)
            .set("Host", hostOf(slug))
            .send({ email: body.email, password: "Brand-new-pass1!" })
            .expect(200);

        // Nothing left to resend once they have accepted.
        await platform(
            "post",
            `/tenants/${tenantResponse.body.data.tenant.id}/resend-invite`,
            admin.accessToken,
        ).expect(409);
    });

    it("lets the admin create a tenant with no form, and re-issues a lapsed invite", async () => {
        const admin = await adminLogin();
        const ownerEmail = uniqueEmail();
        const created = await platform("post", "/tenants", admin.accessToken)
            .send({ name: "No Form Org", slug: uniqueSlug(), ownerEmail })
            .expect(201);
        const tenantId = created.body.data.tenant.id as string;

        // Simulate the cooldown having passed.
        await h.admin.$client.query(
            `UPDATE tenant_invitations SET sent_at = now() - interval '5 minutes' WHERE tenant_id = $1`,
            [tenantId],
        );
        await platform("post", `/tenants/${tenantId}/resend-invite`, admin.accessToken).expect(204);
        expect(invites).toHaveBeenCalledTimes(2);
    });

    it("rejects a request and lets the prospect resubmit", async () => {
        const admin = await adminLogin();
        const body = formBody();
        const created = await submit(body).expect(201);

        await platform("post", `/tenant-requests/${created.body.data.id}/reject`, admin.accessToken)
            .send({ reason: "Incomplete details" })
            .expect(200);

        await submit(body).expect(201);
    });

    it("adds an existing account to the new tenant without a password invite", async () => {
        const admin = await adminLogin();
        const body = formBody();
        await h.users.createUser({ email: body.email, passwordHash: "x", emailVerifiedAt: new Date() });

        const created = await platform("post", "/tenants", admin.accessToken)
            .send({ name: "Existing Owner Org", slug: uniqueSlug(), ownerEmail: body.email })
            .expect(201);
        expect(created.body.data.owner).toMatchObject({ isNewAccount: false });
        expect(invites).not.toHaveBeenCalled();

        const [row] = await h.admin.select().from(tenants).where(eq(tenants.id, created.body.data.tenant.id));
        expect(row!.status).toBe(TenantStatus.ACTIVE);
    });
});
