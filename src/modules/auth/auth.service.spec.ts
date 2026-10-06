import { BadRequestException, ConflictException, UnauthorizedException } from "@nestjs/common";
import * as argon2 from "argon2";
import { AuthService } from "@/modules/auth/auth.service.js";
import { EmailTokenType, UserStatus } from "@/database/schema/enums.js";
import type { UserWithRoles } from "@/modules/users/users.service.js";

const CORRECT_PASSWORD = "correct-horse-battery";
const DELETED_AT = new Date("2026-09-20T00:00:00.000Z");

async function buildDeletedUser(overrides: Partial<UserWithRoles> = {}): Promise<UserWithRoles> {
    return {
        id: "usr_1",
        email: "gone@example.com",
        password: await argon2.hash(CORRECT_PASSWORD),
        status: UserStatus.ACTIVE,
        deletedAt: DELETED_AT,
        lockedUntil: null,
        twoFactorEnabled: false,
        permVersion: 0,
        tokenVersion: 0,
        roles: [],
        profile: null,
        ...overrides,
    } as unknown as UserWithRoles;
}

function buildService(user: UserWithRoles | null) {
    const usersService = {
        findByEmail: vi.fn().mockResolvedValue(user),
        createUser: vi.fn(),
        recordFailedLogin: vi.fn().mockResolvedValue(undefined),
        resetFailedLogin: vi.fn().mockResolvedValue(undefined),
        restore: vi.fn().mockResolvedValue(user),
    };
    const emailTokensService = {
        issueReactivateAccountToken: vi.fn().mockResolvedValue("123456"),
        consume: vi.fn().mockResolvedValue(true),
    };
    const emailSender = { sendReactivateAccount: vi.fn().mockResolvedValue(undefined) };
    const permissionsService = { invalidateCache: vi.fn().mockResolvedValue(undefined) };
    const configService = { get: vi.fn().mockReturnValue(15) };

    const service = new AuthService(
        usersService as never,
        {} as never,
        emailTokensService as never,
        {} as never,
        {} as never,
        {} as never,
        permissionsService as never,
        configService as never,
        emailSender as never,
    );

    return { service, usersService, emailTokensService, emailSender, permissionsService };
}

describe("AuthService — deletion grace period", () => {
    it("offers reactivation instead of a dead-end conflict when signing up with a deleted address", async () => {
        const { service, emailSender } = buildService(await buildDeletedUser());

        await expect(service.signup({ email: "gone@example.com", password: "whatever" } as never)).rejects.toThrow(
            ConflictException,
        );
        expect(emailSender.sendReactivateAccount).toHaveBeenCalledWith(
            expect.objectContaining({ to: "gone@example.com", code: "123456" }),
        );
    });

    it("never creates a second row for an address still held by a deleted account", async () => {
        const { service, usersService } = buildService(await buildDeletedUser());

        await expect(service.signup({ email: "gone@example.com", password: "whatever" } as never)).rejects.toThrow();
        expect(usersService.createUser).not.toHaveBeenCalled();
    });

    it("mails the reactivation code only once the password proves ownership", async () => {
        const { service, emailSender } = buildService(await buildDeletedUser());

        await expect(service.signin({ email: "gone@example.com", password: "wrong" } as never, {})).rejects.toThrow(
            UnauthorizedException,
        );
        expect(emailSender.sendReactivateAccount).not.toHaveBeenCalled();

        await expect(
            service.signin({ email: "gone@example.com", password: CORRECT_PASSWORD } as never, {}),
        ).rejects.toThrow(ConflictException);
        expect(emailSender.sendReactivateAccount).toHaveBeenCalledOnce();
    });

    it("reports the deadline so a client can say how long is left", async () => {
        const { service } = buildService(await buildDeletedUser());

        const error = await service.signin({ email: "gone@example.com", password: CORRECT_PASSWORD } as never, {}).then(
            () => null,
            (caught: ConflictException) => caught.getResponse() as Record<string, unknown>,
        );

        expect(error).toMatchObject({
            code: "ACCOUNT_PENDING_DELETION",
            // 15 grace days on from the deletion — the client needs the deadline
            // to tell the user how long they have left.
            graceEndsAt: new Date("2026-10-05T00:00:00.000Z").toISOString(),
        });
    });

    it("restores the account when the code checks out, without issuing a session", async () => {
        const { service, usersService, emailTokensService, permissionsService } = buildService(
            await buildDeletedUser(),
        );

        await expect(service.reactivateAccount("gone@example.com", "123456")).resolves.toBeUndefined();
        expect(emailTokensService.consume).toHaveBeenCalledWith("usr_1", EmailTokenType.REACTIVATE_ACCOUNT, "123456");
        expect(usersService.restore).toHaveBeenCalledWith("usr_1");
        expect(permissionsService.invalidateCache).toHaveBeenCalledWith("usr_1");
    });

    it("refuses to reactivate an account that was never deleted", async () => {
        const { service, usersService } = buildService(await buildDeletedUser({ deletedAt: null }));

        await expect(service.reactivateAccount("gone@example.com", "123456")).rejects.toThrow(BadRequestException);
        expect(usersService.restore).not.toHaveBeenCalled();
    });

    it("refuses to reactivate a suspended account, and says nothing about why", async () => {
        const { service, usersService } = buildService(await buildDeletedUser({ status: UserStatus.SUSPENDED }));

        await expect(service.reactivateAccount("gone@example.com", "123456")).rejects.toThrow(
            "Invalid or expired reactivation code",
        );
        expect(usersService.restore).not.toHaveBeenCalled();
    });
});
