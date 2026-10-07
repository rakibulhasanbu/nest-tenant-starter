import { eq } from "drizzle-orm";
import request from "supertest";
import { TenantOnboardingMode, TenantRequestStatus } from "@/database/schema/enums.js";
import { tenantRegistrationRequests } from "@/database/schema/tenant-requests.js";
import { platformSettings, tenants } from "@/database/schema/tenants.js";
import { users } from "@/database/schema/users.js";
import { EMAIL_SENDER, type EmailSender } from "@/integrations/email/email-sender.interface.js";
import { TenantInvitationsService } from "@/modules/tenant-invitations/tenant-invitations.service.js";
import { TenantRequestsService } from "@/modules/tenant-requests/tenant-requests.service.js";
import {
    API,
    PLATFORM_HOST,
    authed,
    boot,
    clearThrottle,
    createUser,
    shutdown,
    uniqueEmail,
    uniqueSlug,
    type Harness,
    type SessionBody,
} from "./helpers/harness.js";

/**
 * Reminders, retention and cleanup around onboarding. Time is moved by rewriting
 * timestamps in the database; the services are called directly, as the cron would.
 */
describe("Tenant onboarding lifecycle (e2e)", () => {
    let h: Harness;
    let requests: TenantRequestsService;
    let invitations: TenantInvitationsService;
    let sender: EmailSender;
    const spies: Record<string, ReturnType<typeof vi.spyOn>> = {};

    beforeAll(async () => {
        h = await boot();
        requests = h.app.get(TenantRequestsService);
        invitations = h.app.get(TenantInvitationsService);
        sender = h.app.get<EmailSender>(EMAIL_SENDER);
        for (const name of [
            "sendTenantRequestSubmitted",
            "sendTenantRequestReceived",
            "sendTenantRequestReminder",
            "sendTenantOwnerInvite",
            "sendTenantOwnerInviteReminder",
            "sendTenantInvitationAbandoned",
        ] as const) {
            spies[name] = vi.spyOn(sender, name);
        }
    });

    beforeEach(async () => {
        await clearThrottle(h);
        Object.values(spies).forEach(spy => spy.mockClear());
        await h.admin
            .update(platformSettings)
            .set({ tenantOnboardingMode: TenantOnboardingMode.ADMIN_ONLY })
            .where(eq(platformSettings.id, 1));
    });

    afterAll(async () => {
        await shutdown(h);
    });

    const sql = (text: string, params: unknown[] = []) => h.admin.$client.query(text, params);
    const daysAgo = (days: number) => new Date(Date.now() - days * 86_400_000);
    // The mail goes out from an event listener a tick after the action.
    const settle = () => new Promise(resolve => setTimeout(resolve, 50));

    const adminLogin = async (): Promise<SessionBody> => {
        const response = await request(h.app.getHttpServer())
            .post(`${API}/auth/signin`)
            .set("Host", PLATFORM_HOST)
            .send({ email: process.env.ADMIN_EMAIL, password: process.env.ADMIN_PASSWORD })
            .expect(200);
        return response.body.data as SessionBody;
    };
    const platform = (method: "get" | "post", path: string, token: string) =>
        authed(h, method, `/platform${path}`, token, PLATFORM_HOST);

    const submit = async (email = uniqueEmail()) => {
        const response = await request(h.app.getHttpServer())
            .post(`${API}/tenant-requests`)
            .send({
                businessName: "Lifecycle Bakery",
                ownerName: "Ada Baker",
                email,
                phone: "+8801700000000",
                dateOfBirth: "1990-05-20",
                address: "12 Baker Street, Dhaka",
            })
            .expect(201);
        return { id: response.body.data.id as string, email };
    };

    const requestRow = async (id: string) => {
        const [row] = await h.admin
            .select()
            .from(tenantRegistrationRequests)
            .where(eq(tenantRegistrationRequests.id, id));
        return row!;
    };

    /** Approves a request and creates its tenant + invitation, as the super admin would. */
    const onboard = async () => {
        const admin = await adminLogin();
        const { id, email } = await submit();
        await platform("post", `/tenant-requests/${id}/approve`, admin.accessToken).expect(200);
        const slug = uniqueSlug();
        const created = await platform("post", "/tenants", admin.accessToken)
            .send({ name: "Lifecycle Org", slug, requestId: id })
            .expect(201);
        const tenantId = created.body.data.tenant.id as string;
        const call = spies.sendTenantOwnerInvite!.mock.calls.at(-1)![0] as { acceptUrl: string };
        return {
            admin,
            requestId: id,
            email,
            slug,
            tenantId,
            token: new URL(call.acceptUrl).searchParams.get("token")!,
        };
    };

    const ageInvitation = (tenantId: string, days: number) =>
        sql(
            `UPDATE tenant_invitations SET sent_at = now() - make_interval(days => $2), created_at = now() - make_interval(days => $2) WHERE tenant_id = $1`,
            [tenantId, days],
        );

    describe("registration requests", () => {
        it("tells the super admin about a new request, and the applicant that it arrived", async () => {
            const { email } = await submit();
            await settle();

            expect(spies.sendTenantRequestSubmitted).toHaveBeenCalledWith(
                expect.objectContaining({ to: process.env.ADMIN_EMAIL, ownerEmail: email }),
            );
            expect(spies.sendTenantRequestReceived).toHaveBeenCalledWith(expect.objectContaining({ to: email }));
        });

        it("reminds the super admin after 3 days, at most twice, and not before", async () => {
            const { id } = await submit();
            expect(await requests.sendDueReminders()).toBe(0);

            await sql(`UPDATE tenant_registration_requests SET created_at = $2 WHERE id = $1`, [id, daysAgo(4)]);
            expect(await requests.sendDueReminders()).toBeGreaterThanOrEqual(1);
            await settle();
            expect(spies.sendTenantRequestReminder).toHaveBeenCalledWith(
                expect.objectContaining({ stage: "REVIEW", reminderNumber: 1 }),
            );

            // The clock restarts from the last reminder.
            expect(await requests.sendDueReminders()).toBe(0);
            await sql(`UPDATE tenant_registration_requests SET last_reminded_at = $2 WHERE id = $1`, [id, daysAgo(4)]);
            await requests.sendDueReminders();
            expect((await requestRow(id)).reminderCount).toBe(2);

            // Spent: no third reminder however long it sits.
            await sql(`UPDATE tenant_registration_requests SET last_reminded_at = $2 WHERE id = $1`, [id, daysAgo(30)]);
            await requests.sendDueReminders();
            expect((await requestRow(id)).reminderCount).toBe(2);
        });

        it("sends one reminder even when two instances run the job at once", async () => {
            const { id } = await submit();
            await sql(`UPDATE tenant_registration_requests SET created_at = $2 WHERE id = $1`, [id, daysAgo(4)]);

            await Promise.all([requests.sendDueReminders(), requests.sendDueReminders(), requests.sendDueReminders()]);
            expect((await requestRow(id)).reminderCount).toBe(1);
        });

        it("nudges again for an approved request that never became a tenant, with a fresh count", async () => {
            const admin = await adminLogin();
            const { id } = await submit();
            await sql(`UPDATE tenant_registration_requests SET created_at = $2, reminder_count = 2 WHERE id = $1`, [
                id,
                daysAgo(10),
            ]);
            await platform("post", `/tenant-requests/${id}/approve`, admin.accessToken).expect(200);
            expect((await requestRow(id)).reminderCount).toBe(0);

            await sql(`UPDATE tenant_registration_requests SET reviewed_at = $2 WHERE id = $1`, [id, daysAgo(4)]);
            await requests.sendDueReminders();
            await settle();
            expect(spies.sendTenantRequestReminder).toHaveBeenCalledWith(
                expect.objectContaining({ stage: "CREATE_TENANT", reminderNumber: 1 }),
            );
        });

        it("deletes rejected requests after 90 days and keeps newer and approved ones", async () => {
            const admin = await adminLogin();
            const old = await submit();
            const recent = await submit();
            const approved = await submit();
            await platform("post", `/tenant-requests/${old.id}/reject`, admin.accessToken).send({}).expect(200);
            await platform("post", `/tenant-requests/${recent.id}/reject`, admin.accessToken).send({}).expect(200);
            await platform("post", `/tenant-requests/${approved.id}/approve`, admin.accessToken).expect(200);

            await sql(`UPDATE tenant_registration_requests SET reviewed_at = $2 WHERE id = $1`, [old.id, daysAgo(91)]);
            await sql(`UPDATE tenant_registration_requests SET reviewed_at = $2 WHERE id = $1`, [
                recent.id,
                daysAgo(89),
            ]);
            await sql(`UPDATE tenant_registration_requests SET reviewed_at = $2 WHERE id = $1`, [
                approved.id,
                daysAgo(200),
            ]);

            await requests.purgeRejected();

            const [gone] = await h.admin
                .select()
                .from(tenantRegistrationRequests)
                .where(eq(tenantRegistrationRequests.id, old.id));
            expect(gone).toBeUndefined();
            expect((await requestRow(recent.id)).status).toBe(TenantRequestStatus.REJECTED);
            expect((await requestRow(approved.id)).status).toBe(TenantRequestStatus.APPROVED);
        });
    });

    describe("owner invitations", () => {
        it("lets the invitee ask for a new link, which kills the old one", async () => {
            const { email, tenantId, token, slug } = await onboard();
            await ageInvitation(tenantId, 0);
            await sql(`UPDATE tenant_invitations SET sent_at = now() - interval '5 minutes' WHERE tenant_id = $1`, [
                tenantId,
            ]);

            await request(h.app.getHttpServer()).post(`${API}/auth/resend-invite`).send({ email }).expect(204);
            // An address with no invitation gets the identical answer.
            await request(h.app.getHttpServer())
                .post(`${API}/auth/resend-invite`)
                .send({ email: uniqueEmail() })
                .expect(204);

            const fresh = new URL(
                (spies.sendTenantOwnerInvite!.mock.calls.at(-1)![0] as { acceptUrl: string }).acceptUrl,
            ).searchParams.get("token")!;
            expect(fresh).not.toBe(token);

            await request(h.app.getHttpServer())
                .post(`${API}/auth/accept-invite`)
                .send({ token, password: "Brand-new-pass1!" })
                .expect(400);
            const accepted = await request(h.app.getHttpServer())
                .post(`${API}/auth/accept-invite`)
                .send({ token: fresh, password: "Brand-new-pass1!" })
                .expect(200);
            expect(accepted.body.data.tenant).toMatchObject({ slug });
        });

        it("refuses an expired link", async () => {
            const { tenantId, token } = await onboard();
            await sql(`UPDATE tenant_invitations SET expires_at = now() - interval '1 minute' WHERE tenant_id = $1`, [
                tenantId,
            ]);

            await request(h.app.getHttpServer())
                .post(`${API}/auth/accept-invite`)
                .send({ token, password: "Brand-new-pass1!" })
                .expect(400);
        });

        it("refuses a link for a tenant that is no longer active", async () => {
            const { admin, tenantId, token } = await onboard();
            await platform("post", `/tenants/${tenantId}/suspend`, admin.accessToken).expect(200);

            await request(h.app.getHttpServer())
                .post(`${API}/auth/accept-invite`)
                .send({ token, password: "Brand-new-pass1!" })
                .expect(400);
        });

        it("reminds an owner who has not accepted — with a new link — at most twice", async () => {
            const { tenantId, token } = await onboard();
            expect(await invitations.sendDueReminders()).toBe(0);

            await ageInvitation(tenantId, 4);
            await invitations.sendDueReminders();
            expect(spies.sendTenantOwnerInviteReminder).toHaveBeenCalledTimes(1);
            const reminded = spies.sendTenantOwnerInviteReminder!.mock.calls[0]![0] as {
                acceptUrl: string;
                reminderNumber: number;
            };
            expect(reminded.reminderNumber).toBe(1);
            expect(new URL(reminded.acceptUrl).searchParams.get("token")).not.toBe(token);

            await sql(`UPDATE tenant_invitations SET sent_at = now() - interval '4 days' WHERE tenant_id = $1`, [
                tenantId,
            ]);
            await invitations.sendDueReminders();
            await sql(`UPDATE tenant_invitations SET sent_at = now() - interval '4 days' WHERE tenant_id = $1`, [
                tenantId,
            ]);
            await invitations.sendDueReminders();
            expect(spies.sendTenantOwnerInviteReminder).toHaveBeenCalledTimes(2);
        });

        it("sends one reminder even when several instances run the job at once", async () => {
            const { tenantId } = await onboard();
            await ageInvitation(tenantId, 4);

            await Promise.all([
                invitations.sendDueReminders(),
                invitations.sendDueReminders(),
                invitations.sendDueReminders(),
            ]);
            expect(spies.sendTenantOwnerInviteReminder).toHaveBeenCalledTimes(1);
        });

        it("stops reminding once the invitation is accepted", async () => {
            const { tenantId, token } = await onboard();
            await request(h.app.getHttpServer())
                .post(`${API}/auth/accept-invite`)
                .send({ token, password: "Brand-new-pass1!" })
                .expect(200);
            await ageInvitation(tenantId, 30);

            await invitations.sendDueReminders();
            await invitations.cleanupAbandoned();
            expect(spies.sendTenantOwnerInviteReminder).not.toHaveBeenCalled();
            const [tenant] = await h.admin.select().from(tenants).where(eq(tenants.id, tenantId));
            expect(tenant).toBeDefined();
        });
    });

    describe("abandoned invitations", () => {
        it("removes the tenant and placeholder account after 14 days, reopens the request and tells the admin", async () => {
            const { tenantId, requestId, email } = await onboard();
            await ageInvitation(tenantId, 15);

            expect(await invitations.cleanupAbandoned()).toBeGreaterThanOrEqual(1);
            await settle();

            const [tenant] = await h.admin.select().from(tenants).where(eq(tenants.id, tenantId));
            expect(tenant).toBeUndefined();
            expect(await h.users.findByEmail(email)).toBeNull();

            // The request is convertible again, so the admin can start over.
            const reopened = await requestRow(requestId);
            expect(reopened.status).toBe(TenantRequestStatus.APPROVED);
            expect(reopened.tenantId).toBeNull();
            expect(spies.sendTenantInvitationAbandoned).toHaveBeenCalledWith(
                expect.objectContaining({ to: process.env.ADMIN_EMAIL, ownerEmail: email }),
            );
        });

        it("leaves a young invitation alone", async () => {
            const { tenantId } = await onboard();
            await ageInvitation(tenantId, 10);

            await invitations.cleanupAbandoned();
            const [tenant] = await h.admin.select().from(tenants).where(eq(tenants.id, tenantId));
            expect(tenant).toBeDefined();
        });

        it("never removes anything once the owner has verified the account", async () => {
            const { tenantId, email } = await onboard();
            await ageInvitation(tenantId, 30);
            await h.admin.update(users).set({ emailVerifiedAt: new Date() }).where(eq(users.email, email));

            await invitations.cleanupAbandoned();
            const [tenant] = await h.admin.select().from(tenants).where(eq(tenants.id, tenantId));
            expect(tenant).toBeDefined();
            expect(await h.users.findByEmail(email)).not.toBeNull();
        });

        it("never removes a tenant that has gained another member", async () => {
            const { tenantId, email } = await onboard();
            await ageInvitation(tenantId, 30);
            const colleague = await createUser(h);
            await h.memberships.add(tenantId, colleague.id, []);

            await invitations.cleanupAbandoned();
            const [tenant] = await h.admin.select().from(tenants).where(eq(tenants.id, tenantId));
            expect(tenant).toBeDefined();
            expect(await h.users.findByEmail(email)).not.toBeNull();
        });
    });
});
