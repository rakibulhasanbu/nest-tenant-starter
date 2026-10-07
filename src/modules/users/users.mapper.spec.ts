import type { UserWithProfile } from "@/modules/users/users.service.js";
import { toPublicUser } from "@/modules/users/users.mapper.js";

function buildUser(overrides: Partial<UserWithProfile> = {}): UserWithProfile {
    return {
        id: "usr_1",
        email: "a@example.com",
        password: "$argon2id$secret",
        twoFactorSecret: "TOTPSECRET",
        twoFactorRecoveryCodes: ["hash1", "hash2"],
        twoFactorLastUsedStep: 12345,
        profile: null,
        ...overrides,
    } as unknown as UserWithProfile;
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

    it("reports the role slugs of the tenant it was asked about, not anything on the account", () => {
        expect(toPublicUser(buildUser(), ["admin", "user"]).roleIds).toEqual(["admin", "user"]);
        expect(toPublicUser(buildUser()).roleIds).toEqual([]);
    });

    it("exposes dateOfBirth as a calendar date, never a timestamp", () => {
        const publicUser = toPublicUser(
            buildUser({
                profile: {
                    dateOfBirth: "1995-03-14",
                    gender: "MALE",
                    bio: "hi",
                },
            } as unknown as Partial<UserWithProfile>),
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
