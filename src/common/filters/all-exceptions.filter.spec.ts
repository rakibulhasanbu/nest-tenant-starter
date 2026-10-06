import { ArgumentsHost, HttpException, HttpStatus, Logger, NotFoundException } from "@nestjs/common";
import { ZodValidationException } from "nestjs-zod";
import { z } from "zod";
import { AllExceptionsFilter } from "@/common/filters/all-exceptions.filter.js";
import { DrizzleQueryError } from "drizzle-orm";

function createHost() {
    const json = vi.fn();
    const status = vi.fn(() => ({ json }));

    const host = {
        switchToHttp: () => ({
            getResponse: () => ({ status }),
            getRequest: () => ({ method: "GET", url: "/api/v1/users/me" }),
        }),
    } as unknown as ArgumentsHost;

    return { host, status, json, body: () => json.mock.calls[0]?.[0] };
}

describe("AllExceptionsFilter", () => {
    let filter: AllExceptionsFilter;
    let errorSpy: ReturnType<typeof vi.spyOn>;
    let warnSpy: ReturnType<typeof vi.spyOn>;

    beforeEach(() => {
        filter = new AllExceptionsFilter();
        errorSpy = vi.spyOn(Logger.prototype, "error").mockImplementation(() => undefined);
        warnSpy = vi.spyOn(Logger.prototype, "warn").mockImplementation(() => undefined);
    });

    afterEach(() => {
        vi.restoreAllMocks();
    });

    it("logs 4xx at warn without a stack trace", () => {
        const { host, status, body } = createHost();

        filter.catch(new NotFoundException("No such user"), host);

        expect(status).toHaveBeenCalledWith(404);
        expect(body()).toMatchObject({ statusCode: 404, message: "No such user" });
        expect(warnSpy).toHaveBeenCalledOnce();
        expect(errorSpy).not.toHaveBeenCalled();
    });

    it("logs 5xx at error with the stack trace", () => {
        const { host, body } = createHost();

        filter.catch(new Error("kaboom"), host);

        expect(body()).toMatchObject({
            statusCode: HttpStatus.INTERNAL_SERVER_ERROR,
            code: "INTERNAL_SERVER_ERROR",
            message: "Internal server error",
        });
        expect(errorSpy).toHaveBeenCalledOnce();
        expect(errorSpy.mock.calls[0]?.[1]).toEqual(expect.stringContaining("kaboom"));
    });

    it("never leaks the message of an unexpected error to the client", () => {
        const { host, body } = createHost();

        filter.catch(new Error("connection string postgres://user:hunter2@db"), host);

        expect(body().message).toBe("Internal server error");
    });

    it("flattens a Zod validation failure into field-level details", () => {
        const { host, body } = createHost();
        const parsed = z.strictObject({ email: z.email() }).safeParse({ email: "nope" });

        filter.catch(new ZodValidationException(parsed.error!), host);

        expect(body()).toMatchObject({ statusCode: 400, code: "VALIDATION_ERROR" });
        expect(body().details).toEqual([{ field: "email", message: expect.any(String) }]);
    });

    it("translates a unique-constraint violation into a 409 naming the field", () => {
        const { host, body } = createHost();
        const cause = Object.assign(new Error("duplicate key"), {
            code: "23505",
            detail: "Key (email)=(a@b.c) already exists.",
        });

        filter.catch(new DrizzleQueryError("insert into users", [], cause), host);

        expect(body()).toMatchObject({
            statusCode: HttpStatus.CONFLICT,
            code: "UNIQUE_CONSTRAINT_VIOLATION",
            message: "A record with this email already exists",
        });
    });

    it("maps a foreign-key violation to 400 and an unknown database error to a generic 500", () => {
        const foreignKey = createHost();
        const fkCause = Object.assign(new Error("fk"), { code: "23503" });
        filter.catch(new DrizzleQueryError("insert into user_roles", [], fkCause), foreignKey.host);
        expect(foreignKey.body()).toMatchObject({ statusCode: 400, code: "FOREIGN_KEY_CONSTRAINT_VIOLATION" });

        const unknown = createHost();
        const otherCause = Object.assign(new Error("???"), { code: "XX000" });
        filter.catch(new DrizzleQueryError("select 1", [], otherCause), unknown.host);
        expect(unknown.body()).toMatchObject({ statusCode: 500, code: "INTERNAL_SERVER_ERROR" });
    });

    it("passes through extra context an exception attaches to its payload", () => {
        const { host, body } = createHost();

        filter.catch(
            new HttpException(
                {
                    code: "ACCOUNT_PENDING_DELETION",
                    message: "Scheduled for deletion",
                    graceEndsAt: "2026-01-01T00:00:00.000Z",
                },
                HttpStatus.CONFLICT,
            ),
            host,
        );

        expect(body()).toEqual({
            statusCode: 409,
            code: "ACCOUNT_PENDING_DELETION",
            message: "Scheduled for deletion",
            graceEndsAt: "2026-01-01T00:00:00.000Z",
        });
    });

    it("preserves a custom code carried on an HttpException payload", () => {
        const { host, body } = createHost();

        filter.catch(
            new HttpException({ code: "EMAIL_NOT_VERIFIED", message: "Verify first" }, HttpStatus.UNAUTHORIZED),
            host,
        );

        expect(body()).toMatchObject({
            statusCode: 401,
            code: "EMAIL_NOT_VERIFIED",
            message: "Verify first",
        });
    });
});
