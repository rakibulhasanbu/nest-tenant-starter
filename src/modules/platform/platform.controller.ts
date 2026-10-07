import { Body, Controller, Get, HttpCode, HttpStatus, Param, Patch, Post, Query } from "@nestjs/common";
import { PERMISSIONS } from "@/common/authorization/permissions.constant.js";
import { CurrentUser } from "@/common/decorators/current-user.decorator.js";
import { RequirePermissions } from "@/common/decorators/require-permissions.decorator.js";
import type { AuthenticatedUser } from "@/common/types/authenticated-request.type.js";
import { paginate } from "@/common/utils/pagination.util.js";
import { ListTenantsDto } from "@/modules/platform/dto/list-tenants.schema.js";
import { RejectTenantDto } from "@/modules/platform/dto/reject-tenant.schema.js";
import { UpdatePlatformSettingsDto } from "@/modules/platform/dto/update-settings.schema.js";
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
    ) {}

    @RequirePermissions(PERMISSIONS.PLATFORM_TENANT_READ)
    @Get("tenants")
    async listTenants(@Query() query: ListTenantsDto) {
        const { items, total } = await this.tenantsService.listForPlatform(query);
        return paginate(items, query, total);
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
