import { Body, Controller, Delete, Get, HttpCode, HttpStatus, Param, Patch, Post } from "@nestjs/common";
import { PERMISSIONS } from "@/common/authorization/permissions.constant.js";
import { CurrentUser } from "@/common/decorators/current-user.decorator.js";
import { RequirePermissions } from "@/common/decorators/require-permissions.decorator.js";
import type { AuthenticatedUser } from "@/common/types/authenticated-request.type.js";
import { AdminRolesService } from "@/modules/admin/roles/admin-roles.service.js";
import { CreateRoleDto } from "@/modules/admin/roles/dto/create-role.schema.js";
import { UpdateRoleDto } from "@/modules/admin/roles/dto/update-role.schema.js";

@Controller("admin")
export class AdminRolesController {
    constructor(private readonly adminRolesService: AdminRolesService) {}

    @RequirePermissions(PERMISSIONS.PERMISSION_READ)
    @Get("permissions")
    listPermissions() {
        return this.adminRolesService.listPermissions();
    }

    @RequirePermissions(PERMISSIONS.ROLE_READ)
    @Get("roles")
    list(@CurrentUser() actor: AuthenticatedUser) {
        return this.adminRolesService.list(actor);
    }

    @RequirePermissions(PERMISSIONS.ROLE_READ)
    @Get("roles/:id")
    getById(@CurrentUser() actor: AuthenticatedUser, @Param("id") id: string) {
        return this.adminRolesService.getBySlug(actor, id);
    }

    @RequirePermissions(PERMISSIONS.ROLE_WRITE)
    @HttpCode(HttpStatus.CREATED)
    @Post("roles")
    create(@CurrentUser() actor: AuthenticatedUser, @Body() dto: CreateRoleDto) {
        return this.adminRolesService.create(actor, dto);
    }

    @RequirePermissions(PERMISSIONS.ROLE_WRITE)
    @Patch("roles/:id")
    update(@CurrentUser() actor: AuthenticatedUser, @Param("id") id: string, @Body() dto: UpdateRoleDto) {
        return this.adminRolesService.update(actor, id, dto);
    }

    @RequirePermissions(PERMISSIONS.ROLE_WRITE)
    @HttpCode(HttpStatus.NO_CONTENT)
    @Delete("roles/:id")
    remove(@CurrentUser() actor: AuthenticatedUser, @Param("id") id: string) {
        return this.adminRolesService.remove(actor, id);
    }
}
