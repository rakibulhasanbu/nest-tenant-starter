import "dotenv/config";
import { randomUUID } from "node:crypto";
import type { NestExpressApplication } from "@nestjs/platform-express";
import { Test, type TestingModule } from "@nestjs/testing";
import * as argon2 from "argon2";
import request from "supertest";
import { AppModule } from "@/app.module.js";
import { PERMISSIONS } from "@/common/authorization/permissions.constant.js";
import { SYSTEM_ROLE_IDS } from "@/common/authorization/system-roles.constant.js";
import { configureApp } from "@/config/configure-app.js";
import { UserStatus } from "@/database/schema/enums.js";
import { getDrizzleToken } from "@nestjs/drizzle";
import { eq, like } from "drizzle-orm";
import type { Database } from "@/database/database.type.js";
import { roles, rolePermissions } from "@/database/schema/authorization.js";
import { users as usersTable } from "@/database/schema/users.js";
import { RedisService } from "@/integrations/redis/redis.service.js";
import { EmailTokensService } from "@/modules/auth/email-tokens.service.js";
import { UsersService } from "@/modules/users/users.service.js";

const API = "/api/v1";
const PASSWORD = "e2e-Passw0rd!";

/**
 * Everything this suite creates is named with these prefixes and deleted in
 * `afterAll`, so it can run against the same development database as
 * `app.e2e-spec.ts` without leaving accounts behind.
 */
const EMAIL_PREFIX = "e2e-";
const ROLE_PREFIX = "e2e-role-";

/**
 * Covers the flows wired into the clients that had no coverage at all:
 * reactivation, set-password, invite, the roles endpoints, and the `isCurrent`
 * flag on the sessions list. Boots the real application graph, so it needs the
 * same PostgreSQL and Redis `pnpm start:dev` does.
 *
 * The per-IP signin budget is five a minute and every request here comes from
 * the same loopback address, so the shared rate-limit counters are cleared
 * between tests.
 */
describe("Auth and admin flows (e2e)", () => {
    let app: NestExpressApplication;
    let db: Database;
    let users: UsersService;
    let emailTokens: EmailTokensService;
    let redis: RedisService;

    beforeAll(async () => {
        const moduleFixture: TestingModule = await Test.createTestingModule({
            imports: [AppModule],
        }).compile();

        app = configureApp(moduleFixture.createNestApplication<NestExpressApplication>());
        await app.init();

        db = app.get<Database>(getDrizzleToken());
        users = app.get(UsersService);
        emailTokens = app.get(EmailTokensService);
        redis = app.get(RedisService);
    });

    // Only the throttle keys — the permission cache lives in the same Redis and
    // is none of this suite's business.
    beforeEach(async () => {
        if (!redis.isAvailable) return;
        const keys = await redis.client.keys("throttle:*");
        if (keys.length > 0) {
            await redis.client.del(...keys);
        }
    });

    afterAll(async () => {
        // Users first: a role cannot be deleted while it is still assigned.
        await db?.delete(usersTable).where(like(usersTable.email, `${EMAIL_PREFIX}%`));
        await db?.delete(roles).where(like(roles.id, `${ROLE_PREFIX}%`));
        await app?.close();
    });

    /** An ACTIVE, verified account — the state every login rule expects. */
    const createUser = async (roleIds: string[] = []) => {
        const email = `${EMAIL_PREFIX}${randomUUID()}@example.test`;
        const user = await users.createUser({
            email,
            passwordHash: await argon2.hash(PASSWORD),
            roleIds,
            status: UserStatus.ACTIVE,
            emailVerifiedAt: new Date(),
        });

        return { id: user.id, email };
    };

    const signIn = async (email: string, password = PASSWORD) => {
        const response = await request(app.getHttpServer())
            .post(`${API}/auth/signin`)
            .send({ email, password })
            .expect(200);

        return response.body.data as { accessToken: string; refreshToken: string };
    };

    const authed = (method: "get" | "post" | "patch" | "delete", path: string, accessToken: string) =>
        request(app.getHttpServer())[method](`${API}${path}`).set("Authorization", `Bearer ${accessToken}`);

    describe("GET /users/me", () => {
        it("describes the caller — roles, permissions and password state, never the secrets", async () => {
            const { email } = await createUser();
            const { accessToken } = await signIn(email);

            const response = await authed("get", "/users/me", accessToken).expect(200);
            const me = response.body.data;

            expect(me).toMatchObject({
                email,
                roleIds: [SYSTEM_ROLE_IDS.USER],
                // The baseline role grants nothing and ranks lowest.
                permissions: [],
                maxRank: 0,
                hasPassword: true,
                profile: null,
            });
            expect(me).not.toHaveProperty("password");
            expect(me).not.toHaveProperty("twoFactorSecret");
        });
    });

    describe("/users/me/notifications", () => {
        it("defaults every channel on, then persists a partial update", async () => {
            const { email } = await createUser();
            const { accessToken } = await signIn(email);

            const before = await authed("get", "/users/me/notifications", accessToken).expect(200);
            expect(before.body.data).toEqual({
                loginEmailNotification: true,
                transactionsEmailNotification: true,
                transactionsPushNotification: true,
            });

            await authed("patch", "/users/me/notifications", accessToken)
                .send({ transactionsPushNotification: false })
                .expect(200);

            const after = await authed("get", "/users/me/notifications", accessToken).expect(200);
            expect(after.body.data).toEqual({
                loginEmailNotification: true,
                transactionsEmailNotification: true,
                transactionsPushNotification: false,
            });
        });

        it("rejects unknown channels", async () => {
            const { email } = await createUser();
            const { accessToken } = await signIn(email);

            await authed("patch", "/users/me/notifications", accessToken).send({ smsNotification: true }).expect(400);
        });
    });

    describe("GET /auth/sessions", () => {
        it("marks the session the request came from, and only that one", async () => {
            const { email } = await createUser();
            const first = await signIn(email);
            await signIn(email);

            const fromFirst = await authed("get", "/auth/sessions", first.accessToken).expect(200);
            const sessions = fromFirst.body.data as { id: string; isCurrent: boolean }[];

            expect(sessions).toHaveLength(2);
            expect(sessions.filter(session => session.isCurrent)).toHaveLength(1);
        });

        it("revoking a session drops it from the list", async () => {
            const { email } = await createUser();
            const keep = await signIn(email);
            await signIn(email);

            const before = await authed("get", "/auth/sessions", keep.accessToken).expect(200);
            const other = (before.body.data as { id: string; isCurrent: boolean }[]).find(
                session => !session.isCurrent,
            )!;

            await authed("delete", `/auth/sessions/${other.id}`, keep.accessToken).expect(204);

            const after = await authed("get", "/auth/sessions", keep.accessToken).expect(200);
            expect(after.body.data).toHaveLength(1);
            expect(after.body.data[0]).toMatchObject({ isCurrent: true });
        });
    });

    describe("POST /auth/set-password", () => {
        it("sets a password for an account that has none, and refuses one that does", async () => {
            const { id, email } = await createUser();
            const { accessToken } = await signIn(email);

            // Stand in for a Google-only account: those never get a
            // password, and signing in as one is impossible by definition.
            await db.update(usersTable).set({ password: null }).where(eq(usersTable.id, id));

            const before = await authed("get", "/users/me", accessToken).expect(200);
            expect(before.body.data.hasPassword).toBe(false);

            await authed("post", "/auth/set-password", accessToken).send({ newPassword: PASSWORD }).expect(204);

            const after = await authed("get", "/users/me", accessToken).expect(200);
            expect(after.body.data.hasPassword).toBe(true);

            // A second call is the change-password case, which needs the current one.
            await authed("post", "/auth/set-password", accessToken).send({ newPassword: PASSWORD }).expect(400);
        });
    });

    describe("account reactivation", () => {
        it("answers a deleted account's sign-in with a 409 that carries the deadline", async () => {
            const { id, email } = await createUser();
            await db.update(usersTable).set({ deletedAt: new Date() }).where(eq(usersTable.id, id));

            const response = await request(app.getHttpServer())
                .post(`${API}/auth/signin`)
                .send({ email, password: PASSWORD })
                .expect(409);

            expect(response.body).toMatchObject({ statusCode: 409, code: "ACCOUNT_PENDING_DELETION" });
            // Rebuilt by AllExceptionsFilter from the thrown body — the whole
            // point of passing extra context through rather than dropping it.
            expect(typeof response.body.graceEndsAt).toBe("string");
            expect(Number.isNaN(Date.parse(response.body.graceEndsAt))).toBe(false);
        });

        it("restores the account once the emailed code is consumed", async () => {
            const { id, email } = await createUser();
            await db.update(usersTable).set({ deletedAt: new Date() }).where(eq(usersTable.id, id));

            // The code only exists hashed in the database, so the test issues its
            // own rather than trying to read back the one the 409 mails out.
            const code = await emailTokens.issueReactivateAccountToken(id);

            await request(app.getHttpServer()).post(`${API}/auth/reactivate-account`).send({ email, code }).expect(204);

            expect(await db.query.users.findFirst({ where: { id } })).toMatchObject({ deletedAt: null });
            await signIn(email);
        });

        it("rejects a wrong code without saying why", async () => {
            const { id, email } = await createUser();
            await db.update(usersTable).set({ deletedAt: new Date() }).where(eq(usersTable.id, id));
            await emailTokens.issueReactivateAccountToken(id);

            await request(app.getHttpServer())
                .post(`${API}/auth/reactivate-account`)
                .send({ email, code: "000000" })
                .expect(400);
        });
    });

    describe("admin surface", () => {
        /** A runtime role, as the RBAC UI creates them — the seeded `admin` cannot invite. */
        const createInviterRole = async () => {
            const id = `${ROLE_PREFIX}${randomUUID()}`;
            await db.insert(roles).values({ id, name: "E2E Inviter", rank: 60 });
            await db
                .insert(rolePermissions)
                .values(
                    [
                        PERMISSIONS.USER_INVITE,
                        PERMISSIONS.USER_READ_ANY,
                        PERMISSIONS.ROLE_READ,
                        PERMISSIONS.ROLE_ASSIGN,
                    ].map(permissionKey => ({ roleId: id, permissionKey })),
                );

            return id;
        };

        it("invites a user with the requested roles", async () => {
            const roleId = await createInviterRole();
            const { email } = await createUser([roleId]);
            const { accessToken } = await signIn(email);

            const inviteeEmail = `${EMAIL_PREFIX}${randomUUID()}@example.test`;
            const response = await authed("post", "/admin/users/invite", accessToken)
                .send({ email: inviteeEmail, roleIds: [SYSTEM_ROLE_IDS.USER] })
                .expect(201);

            expect(response.body.data).toMatchObject({
                email: inviteeEmail,
                roleIds: [SYSTEM_ROLE_IDS.USER],
                status: UserStatus.PENDING_VERIFICATION,
            });
        });

        it("refuses to grant a role at or above the inviter's own rank", async () => {
            const roleId = await createInviterRole();
            const { email } = await createUser([roleId]);
            const { accessToken } = await signIn(email);

            await authed("post", "/admin/users/invite", accessToken)
                .send({
                    email: `${EMAIL_PREFIX}${randomUUID()}@example.test`,
                    roleIds: [SYSTEM_ROLE_IDS.SUPER_ADMIN],
                })
                .expect(403);
        });

        it("lists roles for a holder of role:read and 403s everyone else", async () => {
            const roleId = await createInviterRole();
            const privileged = await createUser([roleId]);
            const plain = await createUser();

            const withPermission = await signIn(privileged.email);
            const response = await authed("get", "/admin/roles", withPermission.accessToken).expect(200);
            expect((response.body.data as { id: string }[]).map(role => role.id)).toEqual(
                expect.arrayContaining([SYSTEM_ROLE_IDS.USER, SYSTEM_ROLE_IDS.ADMIN]),
            );

            const withoutPermission = await signIn(plain.email);
            await authed("get", "/admin/roles", withoutPermission.accessToken).expect(403);
            await authed("get", "/admin/users", withoutPermission.accessToken).expect(403);
        });
    });
});
