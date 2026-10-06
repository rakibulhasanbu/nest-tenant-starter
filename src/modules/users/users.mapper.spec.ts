import type { UserWithRoles } from "@/modules/users/users.service.js";
import { toPublicUser } from "@/modules/users/users.mapper.js";

function buildUser(overrides: Partial<UserWithRoles> = {}): UserWithRoles {
    return {
        id: "usr_1",
        email: "a@example.com",
        password: "$argon2id$secret",
        twoFactorSecret: "TOTPSECRET",
        twoFactorRecoveryCodes: ["hash1", "hash2"],
        twoFactorLastUsedStep: 12345,
        roles: [{ roleId: "role_admin" }, { roleId: "role_user" }],
        profile: null,
        ...overrides,
    } as unknown as UserWithRoles;
}

describe("toPublicUser", () => {
    it("strips every credential field", () => {
        const publicUser = toPublicUser(buildUser());

        expect(publicUser).not.toHaveProperty("password");
        expect(publicUser).not.toHaveProperty("twoFactorSecret");
        expect(publicUser).not.toHaveProperty("twoFactorRecoveryCodes");
        expect(publicUser).not.toHaveProperty("twoFactorLastUsedStep");
        expect(JSON.stringify(publicUser)).not.toContain("argon2id");
    });

    it("flattens roles to ids", () => {
        expect(toPublicUser(buildUser()).roleIds).toEqual(["role_admin", "role_user"]);
    });

    it("exposes dateOfBirth as a calendar date, never a timestamp", () => {
        const publicUser = toPublicUser(
            buildUser({
                profile: {
                    dateOfBirth: "1995-03-14",
                    gender: "MALE",
                    bio: "hi",
                },
            } as unknown as Partial<UserWithRoles>),
        );

        expect(publicUser.profile).toEqual({ dateOfBirth: "1995-03-14", gender: "MALE", bio: "hi" });
    });

    it("returns a null profile when the user has none", () => {
        expect(toPublicUser(buildUser()).profile).toBeNull();
    });

    it("reports whether password login is set up, without exposing the hash", () => {
        expect(toPublicUser(buildUser()).hasPassword).toBe(true);
        expect(toPublicUser(buildUser({ password: null })).hasPassword).toBe(false);
    });
});
