import { Body, Controller, ForbiddenException, Get, HttpCode, HttpStatus, Patch, Post } from "@nestjs/common";
import { PERMISSIONS } from "@/common/authorization/permissions.constant.js";
import { AuthenticatedOnly } from "@/common/decorators/authenticated-only.decorator.js";
import { CurrentUser } from "@/common/decorators/current-user.decorator.js";
import { RequirePermissions } from "@/common/decorators/require-permissions.decorator.js";
import type { AuthenticatedUser } from "@/common/types/authenticated-request.type.js";
import type { Tenant } from "@/database/schema/tenants.js";
import { CreateTenantDto } from "@/modules/tenants/dto/create-tenant.schema.js";
import { UpdateTenantDto } from "@/modules/tenants/dto/update-tenant.schema.js";
import { TenantsService } from "@/modules/tenants/tenants.service.js";

@Controller()
export class TenantsController {
    constructor(private readonly tenantsService: TenantsService) {}

    /** The tenant the caller is currently acting in. */
    @RequirePermissions(PERMISSIONS.TENANT_READ)
    @Get("tenant")
    async getCurrent(@CurrentUser() actor: AuthenticatedUser) {
        return this.toView(await this.tenantsService.findByIdOrThrow(this.tenantIdOf(actor)));
    }

    @RequirePermissions(PERMISSIONS.TENANT_UPDATE)
    @Patch("tenant")
    async updateCurrent(@CurrentUser() actor: AuthenticatedUser, @Body() dto: UpdateTenantDto) {
        return this.toView(await this.tenantsService.updateName(this.tenantIdOf(actor), dto.name));
    }

    /**
     * An already signed-in user starting another organization. No new account is
     * involved — they become `owner` of the new tenant, which waits for approval
     * or is active immediately depending on the platform setting.
     */
    @AuthenticatedOnly()
    @HttpCode(HttpStatus.CREATED)
    @Post("tenants")
    async create(@CurrentUser() actor: AuthenticatedUser, @Body() dto: CreateTenantDto) {
        if (actor.isPlatform) {
            throw new ForbiddenException("The platform account cannot own organizations");
        }
        return this.toView(await this.tenantsService.createForOwner(actor.id, dto));
    }

    /** Every organization the caller belongs to, with the state that explains why one can or cannot be entered. */
    @AuthenticatedOnly()
    @Get("me/tenants")
    listMine(@CurrentUser() actor: AuthenticatedUser) {
        return this.tenantsService.listForUser(actor.id);
    }

    private tenantIdOf(actor: AuthenticatedUser): string {
        if (!actor.tenantId) {
            throw new ForbiddenException("This route needs an organization context");
        }
        return actor.tenantId;
    }

    private toView(tenant: Tenant) {
        const { createdBy: _createdBy, reviewedBy: _reviewedBy, ...rest } = tenant;
        return { ...rest, url: this.tenantsService.urlFor(tenant.slug) };
    }
}
