import {
    ForbiddenException,
    Injectable,
    Logger,
    UnauthorizedException,
    type CanActivate,
    type ExecutionContext,
} from "@nestjs/common";
import { Reflector } from "@nestjs/core";
import type { Request } from "express";
import { AUTHENTICATED_ONLY_KEY } from "@/common/decorators/authenticated-only.decorator.js";
import { PERMISSIONS_KEY, type PermissionsMetadata } from "@/common/decorators/require-permissions.decorator.js";
import { IS_PUBLIC_KEY } from "@/common/decorators/public.decorator.js";
import type { AuthenticatedUser } from "@/common/types/authenticated-request.type.js";
import type { AccessTokenPayload } from "@/modules/auth/tokens.service.js";
import { UserStatus } from "@/database/schema/enums.js";
import { PermissionsService } from "@/modules/authorization/permissions.service.js";

/**
 * Authorization for every route. Runs after JwtAuthGuard, which has already put
 * the raw token claims on the request.
 *
 * Two things happen here, in order:
 *
 *  1. Account state — a suspended or soft-deleted account is refused outright.
 *     Checked here rather than at login because a token already in the wild stays
 *     signature-valid; without this, suspending an account would only take effect
 *     once its access token expired.
 *
 *  2. Freshness — the token's `tokenVersion` and `permVersion` are compared
 *     against the server's current values. A mismatch means the session was
 *     killed or the user's access changed since the token was issued, so the
 *     token is rejected (401) and the client refreshes. This is what makes
 *     revocation immediate instead of waiting out the token's TTL.
 *
 *  3. Permission — the route's required permissions are matched against the
 *     resolved set. Routes declaring neither @RequirePermissions nor
 *     @AuthenticatedOnly are denied: a missing decorator must fail closed.
 */
@Injectable()
export class PermissionsGuard implements CanActivate {
    private readonly logger = new Logger(PermissionsGuard.name);

    constructor(
        private readonly reflector: Reflector,
        private readonly permissionsService: PermissionsService,
    ) {}

    async canActivate(context: ExecutionContext): Promise<boolean> {
        const targets = [context.getHandler(), context.getClass()];

        if (this.reflector.getAllAndOverride<boolean>(IS_PUBLIC_KEY, targets)) {
            return true;
        }

        const request = context.switchToHttp().getRequest<Request & { user: AccessTokenPayload }>();
        const claims = request.user;

        const principal = await this.permissionsService.resolve(claims.sub);

        if (!principal || principal.isDeleted) {
            throw new UnauthorizedException("Invalid credentials");
        }

        if (principal.status === UserStatus.SUSPENDED) {
            throw new UnauthorizedException("This account has been suspended");
        }

        if (claims.tokenVersion !== principal.tokenVersion) {
            throw new UnauthorizedException("Session is no longer valid — please sign in again");
        }

        if (claims.permVersion !== principal.permVersion) {
            throw new UnauthorizedException("Your access has changed — please refresh your session");
        }

        const user: AuthenticatedUser = {
            id: principal.userId,
            email: claims.email,
            roleIds: principal.roleIds,
            permissions: principal.permissions,
            maxRank: principal.maxRank,
            sessionId: claims.sessionId,
            can: permission => principal.permissions.has(permission),
        };

        (request as unknown as { user: AuthenticatedUser }).user = user;

        const required = this.reflector.getAllAndOverride<PermissionsMetadata>(PERMISSIONS_KEY, targets);

        if (!required || required.permissions.length === 0) {
            if (this.reflector.getAllAndOverride<boolean>(AUTHENTICATED_ONLY_KEY, targets)) {
                return true;
            }

            this.logger.error(
                `${context.getClass().name}.${context.getHandler().name} declares no authorization — ` +
                    "add @RequirePermissions, @AuthenticatedOnly or @Public. Denying the request.",
            );
            throw new ForbiddenException("You do not have permission to perform this action");
        }

        const granted =
            required.mode === "all"
                ? required.permissions.every(permission => principal.permissions.has(permission))
                : required.permissions.some(permission => principal.permissions.has(permission));

        if (!granted) {
            throw new ForbiddenException("You do not have permission to perform this action");
        }

        return true;
    }
}
