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
import { PLATFORM_PERMISSIONS } from "@/common/authorization/permissions.constant.js";
import type { HostContext } from "@/common/types/host-context.type.js";
import { TenantContext } from "@/common/tenant/tenant-context.js";
import { assertTenantUsable } from "@/common/tenant/tenant-state.util.js";
import { MembershipStatus, UserStatus } from "@/database/schema/enums.js";
import { PermissionsService } from "@/modules/authorization/permissions.service.js";
import { TenantsService } from "@/modules/tenants/tenants.service.js";

/**
 * Authorization for every route. Runs after JwtAuthGuard, which has already put
 * the raw token claims on the request.
 *
 * In order:
 *
 *  1. Tenant binding — the token's `tenantId` is the only tenant authority. If the
 *     request arrived on a tenant subdomain, that host's tenant must equal it
 *     (else 403 TENANT_MISMATCH), so a token from `acme` is useless on `globex`.
 *     Platform tokens (`tenantId: null`) are valid only on the platform host.
 *
 *  2. State — the tenant must be ACTIVE (pending/rejected/suspended tenants get a
 *     specific code), and the account and membership must not be suspended or
 *     deleted. Checked here rather than at login because a token already in the
 *     wild stays signature-valid; this is what makes suspension immediate.
 *
 *  3. Freshness — the token's `tokenVersion` and `permVersion` are compared
 *     against the server's current values. A mismatch means the session was
 *     killed or the member's access changed since the token was issued, so the
 *     token is rejected (401) and the client refreshes.
 *
 *  4. Permission — the route's required permissions are matched against the
 *     resolved set. Routes declaring neither @RequirePermissions nor
 *     @AuthenticatedOnly are denied: a missing decorator must fail closed.
 */
@Injectable()
export class PermissionsGuard implements CanActivate {
    private readonly logger = new Logger(PermissionsGuard.name);

    constructor(
        private readonly reflector: Reflector,
        private readonly permissionsService: PermissionsService,
        private readonly tenantsService: TenantsService,
        private readonly tenantContext: TenantContext,
    ) {}

    async canActivate(context: ExecutionContext): Promise<boolean> {
        const targets = [context.getHandler(), context.getClass()];

        if (this.reflector.getAllAndOverride<boolean>(IS_PUBLIC_KEY, targets)) {
            return true;
        }

        const request = context
            .switchToHttp()
            .getRequest<Request & { user: AccessTokenPayload; hostContext?: HostContext }>();
        const claims = request.user;
        // The token signature is already verified, so this is safe to tag logs and rate limits with.
        this.tenantContext.setUser(claims.sub);
        const host: HostContext = request.hostContext ?? { kind: "apex", tenant: null };

        const user =
            claims.tenantId === null
                ? await this.authorizePlatform(claims, host)
                : await this.authorizeTenant(claims, claims.tenantId, host);

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
                ? required.permissions.every(permission => user.permissions.has(permission))
                : required.permissions.some(permission => user.permissions.has(permission));

        if (!granted) {
            throw new ForbiddenException("You do not have permission to perform this action");
        }

        return true;
    }

    private async authorizePlatform(claims: AccessTokenPayload, host: HostContext): Promise<AuthenticatedUser> {
        if (host.kind !== "platform") {
            throw new ForbiddenException({
                code: "PLATFORM_HOST_REQUIRED",
                message: "Platform sessions can only be used on the platform host",
            });
        }

        const principal = await this.permissionsService.resolvePlatform(claims.sub);

        if (!principal || principal.isDeleted) {
            throw new UnauthorizedException("Invalid credentials");
        }
        if (principal.status === UserStatus.SUSPENDED) {
            throw new UnauthorizedException("This account has been suspended");
        }
        if (claims.tokenVersion !== principal.tokenVersion) {
            throw new UnauthorizedException("Session is no longer valid — please sign in again");
        }

        const permissions = new Set(PLATFORM_PERMISSIONS);

        return {
            id: principal.userId,
            email: claims.email,
            tenantId: null,
            isPlatform: true,
            roleIds: [],
            permissions,
            maxRank: 0,
            sessionId: claims.sessionId,
            can: permission => permissions.has(permission),
        };
    }

    private async authorizeTenant(
        claims: AccessTokenPayload,
        tenantId: string,
        host: HostContext,
    ): Promise<AuthenticatedUser> {
        if (host.kind === "platform" || (host.kind === "tenant" && host.tenant?.id !== tenantId)) {
            throw new ForbiddenException({
                code: "TENANT_MISMATCH",
                message: "This session belongs to a different organization",
            });
        }

        const tenant = await this.tenantsService.findById(tenantId);
        if (!tenant) {
            throw new UnauthorizedException("Invalid credentials");
        }
        assertTenantUsable(tenant.status, tenant.rejectionReason);

        // From here on every query this request makes is scoped to the tenant by RLS.
        this.tenantContext.setTenant(tenantId);

        const principal = await this.permissionsService.resolve(tenantId, claims.sub);

        if (!principal || principal.isDeleted) {
            throw new UnauthorizedException("Invalid credentials");
        }
        if (principal.status === UserStatus.SUSPENDED) {
            throw new UnauthorizedException("This account has been suspended");
        }
        if (principal.membershipStatus === MembershipStatus.SUSPENDED) {
            throw new ForbiddenException({
                code: "MEMBERSHIP_SUSPENDED",
                message: "Your access to this organization has been suspended",
            });
        }
        if (claims.tokenVersion !== principal.tokenVersion) {
            throw new UnauthorizedException("Session is no longer valid — please sign in again");
        }
        if (claims.permVersion !== principal.permVersion) {
            throw new UnauthorizedException("Your access has changed — please refresh your session");
        }

        return {
            id: principal.userId,
            email: claims.email,
            tenantId,
            isPlatform: false,
            roleIds: principal.roleIds,
            permissions: principal.permissions,
            maxRank: principal.maxRank,
            sessionId: claims.sessionId,
            can: permission => principal.permissions.has(permission),
        };
    }
}
