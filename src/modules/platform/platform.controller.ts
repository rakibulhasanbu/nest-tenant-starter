import { Body, Controller, Get, HttpCode, HttpStatus, Param, Patch, Post, Query } from "@nestjs/common";
import { PERMISSIONS } from "@/common/authorization/permissions.constant.js";
import { CurrentUser } from "@/common/decorators/current-user.decorator.js";
import { RequirePermissions } from "@/common/decorators/require-permissions.decorator.js";
import type { AuthenticatedUser } from "@/common/types/authenticated-request.type.js";
import { paginate } from "@/common/utils/pagination.util.js";
import { CreatePlatformTenantDto } from "@/modules/platform/dto/create-platform-tenant.schema.js";
import { ListTenantsDto } from "@/modules/platform/dto/list-tenants.schema.js";
import { RejectTenantDto } from "@/modules/platform/dto/reject-tenant.schema.js";
import { UpdatePlatformSettingsDto } from "@/modules/platform/dto/update-settings.schema.js";
import { TenantOnboardingService } from "@/modules/platform/tenant-onboarding.service.js";
import { ListTenantRequestsDto } from "@/modules/tenant-requests/dto/list-tenant-requests.schema.js";
import { TenantRequestsService } from "@/modules/tenant-requests/tenant-requests.service.js";
import { PlatformSettingsService } from "@/modules/tenants/platform-settings.service.js";
import { TenantsService } from "@/modules/tenants/tenants.service.js";

/**
 * The super admin console API. Reachable only with a platform token on the
 * platform host (the guard enforces both); every route also names the platform
 * permission it needs, so the constant in code stays the single source of truth.
 */
@Controller("platform")
export class PlatformController {
    constructor(
        private readonly tenantsService: TenantsService,
        private readonly settingsService: PlatformSettingsService,
        private readonly onboardingService: TenantOnboardingService,
        private readonly requestsService: TenantRequestsService,
    ) {}

    @RequirePermissions(PERMISSIONS.PLATFORM_TENANT_READ)
    @Get("tenants")
    async listTenants(@Query() query: ListTenantsDto) {
        const { items, total } = await this.tenantsService.listForPlatform(query);
        return paginate(items, query, total);
    }

    /** Creates an ACTIVE tenant and invites its owner (from a registration request, or from scratch). */
    @RequirePermissions(PERMISSIONS.PLATFORM_TENANT_CREATE)
    @Post("tenants")
    createTenant(@CurrentUser() actor: AuthenticatedUser, @Body() dto: CreatePlatformTenantDto) {
        return this.onboardingService.createAndInvite(dto, actor.id);
    }

    @RequirePermissions(PERMISSIONS.PLATFORM_TENANT_CREATE)
    @HttpCode(HttpStatus.NO_CONTENT)
    @Post("tenants/:id/resend-invite")
    async resendInvite(@Param("id") id: string) {
        await this.onboardingService.resendInvite(id);
    }

    @RequirePermissions(PERMISSIONS.PLATFORM_TENANT_READ)
    @Get("tenant-requests")
    async listRequests(@Query() query: ListTenantRequestsDto) {
        const { items, total } = await this.requestsService.list(query);
        return paginate(items, query, total);
    }

    @RequirePermissions(PERMISSIONS.PLATFORM_TENANT_READ)
    @Get("tenant-requests/:id")
    getRequest(@Param("id") id: string) {
        return this.requestsService.getByIdOrThrow(id);
    }

    @RequirePermissions(PERMISSIONS.PLATFORM_TENANT_REVIEW)
    @HttpCode(HttpStatus.OK)
    @Post("tenant-requests/:id/approve")
    approveRequest(@CurrentUser() actor: AuthenticatedUser, @Param("id") id: string) {
        return this.requestsService.approve(id, actor.id);
    }

    @RequirePermissions(PERMISSIONS.PLATFORM_TENANT_REVIEW)
    @HttpCode(HttpStatus.OK)
    @Post("tenant-requests/:id/reject")
    rejectRequest(@CurrentUser() actor: AuthenticatedUser, @Param("id") id: string, @Body() dto: RejectTenantDto) {
        return this.requestsService.reject(id, actor.id, dto.reason);
    }

    @RequirePermissions(PERMISSIONS.PLATFORM_TENANT_READ)
    @Get("tenants/:id")
    getTenant(@Param("id") id: string) {
        return this.tenantsService.getForPlatform(id);
    }

    @RequirePermissions(PERMISSIONS.PLATFORM_TENANT_REVIEW)
    @HttpCode(HttpStatus.OK)
    @Post("tenants/:id/approve")
    approve(@CurrentUser() actor: AuthenticatedUser, @Param("id") id: string) {
        return this.tenantsService.approve(id, actor.id);
    }

    @RequirePermissions(PERMISSIONS.PLATFORM_TENANT_REVIEW)
    @HttpCode(HttpStatus.OK)
    @Post("tenants/:id/reject")
    reject(@CurrentUser() actor: AuthenticatedUser, @Param("id") id: string, @Body() dto: RejectTenantDto) {
        return this.tenantsService.reject(id, actor.id, dto.reason);
    }

    @RequirePermissions(PERMISSIONS.PLATFORM_TENANT_SUSPEND)
    @HttpCode(HttpStatus.OK)
    @Post("tenants/:id/suspend")
    suspend(@Param("id") id: string) {
        return this.tenantsService.suspend(id);
    }

    @RequirePermissions(PERMISSIONS.PLATFORM_TENANT_SUSPEND)
    @HttpCode(HttpStatus.OK)
    @Post("tenants/:id/reactivate")
    reactivate(@Param("id") id: string) {
        return this.tenantsService.reactivate(id);
    }

    @RequirePermissions(PERMISSIONS.PLATFORM_SETTINGS_READ)
    @Get("settings")
    getSettings() {
        return this.settingsService.get();
    }

    @RequirePermissions(PERMISSIONS.PLATFORM_SETTINGS_WRITE)
    @Patch("settings")
    updateSettings(@CurrentUser() actor: AuthenticatedUser, @Body() dto: UpdatePlatformSettingsDto) {
        return this.settingsService.update(dto, actor.id);
    }
}
