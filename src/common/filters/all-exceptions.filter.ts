import { ArgumentsHost, Catch, ExceptionFilter, HttpException, HttpStatus, Logger } from "@nestjs/common";
import { Request, Response } from "express";
import { ZodValidationException } from "nestjs-zod";
import { DrizzleQueryError } from "drizzle-orm";
import type { ApiErrorResponse } from "@/common/types/api-response.type.js";

@Catch()
export class AllExceptionsFilter implements ExceptionFilter {
    private readonly logger = new Logger(AllExceptionsFilter.name);

    catch(exception: unknown, host: ArgumentsHost) {
        const ctx = host.switchToHttp();
        const response = ctx.getResponse<Response>();
        const request = ctx.getRequest<Request>();

        const body = this.buildErrorBody(exception);

        const message = `${request.method} ${request.url} ${body.statusCode} - ${
            exception instanceof Error ? exception.message : String(exception)
        }`;

        // 4xx is the client saying something wrong, not the server breaking. A
        // stack trace per bad password or missing row buries the 5xx that matter
        // and costs real money in log ingestion.
        if (body.statusCode >= HttpStatus.INTERNAL_SERVER_ERROR) {
            this.logger.error(message, exception instanceof Error ? exception.stack : undefined);
        } else {
            this.logger.warn(message);
        }

        response.status(body.statusCode).json(body);
    }

    private buildErrorBody(exception: unknown): ApiErrorResponse {
        if (exception instanceof ZodValidationException) {
            const zodError = exception.getZodError() as { issues?: ZodIssueLike[] } | undefined;
            const issues = zodError?.issues ?? [];

            return {
                statusCode: HttpStatus.BAD_REQUEST,
                code: "VALIDATION_ERROR",
                message: issues[0]?.message ?? "Validation failed",
                details: issues.map(issue => ({
                    field: issue.path.join("."),
                    message: issue.message,
                })),
            };
        }

        if (exception instanceof DrizzleQueryError) {
            return this.buildDatabaseErrorBody(exception);
        }

        if (exception instanceof HttpException) {
            const status = exception.getStatus();
            const exceptionResponse = exception.getResponse();
            const isObject = typeof exceptionResponse === "object" && exceptionResponse !== null;
            const message = !isObject
                ? exceptionResponse
                : ((exceptionResponse as { message?: string | string[] }).message ?? exception.message);
            const code = isObject && (exceptionResponse as { code?: string }).code;

            return {
                // Anything the thrower attached beyond the standard shape is
                // context the client is meant to act on (a deadline, a retry
                // hint), so it survives instead of being silently dropped here.
                ...(isObject ? extractErrorContext(exceptionResponse as Record<string, unknown>) : {}),
                statusCode: status,
                code: code || (HttpStatus[status] ?? "ERROR"),
                message: Array.isArray(message) ? message.join(", ") : message,
            };
        }

        return {
            statusCode: HttpStatus.INTERNAL_SERVER_ERROR,
            code: "INTERNAL_SERVER_ERROR",
            message: "Internal server error",
        };
    }

    /**
     * Driver errors are not HttpExceptions, so without this a taken username or
     * a duplicate email surfaced as a 500 that told the client nothing. Only the
     * constraint violations a caller can actually act on are translated (by
     * Postgres SQLSTATE); anything else stays a generic 500 rather than leaking
     * schema internals.
     */
    private buildDatabaseErrorBody(exception: DrizzleQueryError): ApiErrorResponse {
        const cause = exception.cause as { code?: string; detail?: string } | undefined;

        switch (cause?.code) {
            case PG_UNIQUE_VIOLATION:
                return {
                    statusCode: HttpStatus.CONFLICT,
                    code: "UNIQUE_CONSTRAINT_VIOLATION",
                    message: describeUniqueTarget(cause.detail),
                };
            case PG_FOREIGN_KEY_VIOLATION:
                return {
                    statusCode: HttpStatus.BAD_REQUEST,
                    code: "FOREIGN_KEY_CONSTRAINT_VIOLATION",
                    message: "A referenced record does not exist",
                };
            default:
                return {
                    statusCode: HttpStatus.INTERNAL_SERVER_ERROR,
                    code: "INTERNAL_SERVER_ERROR",
                    message: "Internal server error",
                };
        }
    }
}

const PG_UNIQUE_VIOLATION = "23505";
const PG_FOREIGN_KEY_VIOLATION = "23503";

/**
 * Keys that describe the envelope rather than the error, so they are rebuilt
 * from the exception itself rather than copied through. `status` is in here
 * because Nest's own payloads use it interchangeably with `statusCode`.
 */
const RESERVED_ERROR_KEYS = new Set(["statusCode", "status", "code", "message", "error"]);

function extractErrorContext(response: Record<string, unknown>): Record<string, unknown> {
    return Object.fromEntries(Object.entries(response).filter(([key]) => !RESERVED_ERROR_KEYS.has(key)));
}

/** Postgres reports the offending columns in `detail`, e.g. `Key (email)=(a@b.c) already exists.` */
function describeUniqueTarget(detail: string | undefined): string {
    const fields = detail?.match(/^Key \((.+?)\)=/)?.[1]?.split(", ") ?? [];

    return fields.length > 0
        ? `A record with this ${fields.join(", ")} already exists`
        : "A record with these details already exists";
}

interface ZodIssueLike {
    path: PropertyKey[];
    message: string;
}
