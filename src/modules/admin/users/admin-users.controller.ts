import { Body, Controller, Delete, Get, HttpCode, HttpStatus, Param, Patch, Post, Query } from "@nestjs/common";
import { PERMISSIONS } from "@/common/authorization/permissions.constant.js";
import { CurrentUser } from "@/common/decorators/current-user.decorator.js";
import { RequirePermissions } from "@/common/decorators/require-permissions.decorator.js";
import type { AuthenticatedUser } from "@/common/types/authenticated-request.type.js";
import { AdminUsersService } from "@/modules/admin/users/admin-users.service.js";
import { AssignRolesDto } from "@/modules/admin/users/dto/assign-roles.schema.js";
import { InviteUserDto } from "@/modules/admin/users/dto/invite-user.schema.js";
import { ListUsersDto } from "@/modules/admin/users/dto/list-users.schema.js";
import { UpdateStatusDto } from "@/modules/admin/users/dto/update-status.schema.js";

@Controller("admin/users")
export class AdminUsersController {
    constructor(private readonly adminUsersService: AdminUsersService) {}

    @RequirePermissions(PERMISSIONS.USER_READ_ANY)
    @Get()
    list(@CurrentUser() actor: AuthenticatedUser, @Query() query: ListUsersDto) {
        return this.adminUsersService.list(actor, query);
    }

    @RequirePermissions(PERMISSIONS.USER_READ_ANY)
    @Get(":id")
    getById(@CurrentUser() actor: AuthenticatedUser, @Param("id") id: string) {
        return this.adminUsersService.getById(actor, id);
    }

    @RequirePermissions(PERMISSIONS.ROLE_ASSIGN)
    @Patch(":id/roles")
    assignRoles(@CurrentUser() actor: AuthenticatedUser, @Param("id") id: string, @Body() dto: AssignRolesDto) {
        return this.adminUsersService.assignRoles(actor, id, dto);
    }

    @RequirePermissions(PERMISSIONS.USER_STATUS_ANY)
    @Patch(":id/status")
    updateStatus(@CurrentUser() actor: AuthenticatedUser, @Param("id") id: string, @Body() dto: UpdateStatusDto) {
        return this.adminUsersService.updateStatus(actor, id, dto.status);
    }

    @RequirePermissions(PERMISSIONS.USER_PASSWORD_RESET_ANY)
    @HttpCode(HttpStatus.NO_CONTENT)
    @Post(":id/reset-password")
    triggerPasswordReset(@CurrentUser() actor: AuthenticatedUser, @Param("id") id: string) {
        return this.adminUsersService.triggerPasswordReset(actor, id);
    }

    @RequirePermissions(PERMISSIONS.SESSION_READ_ANY)
    @Get(":id/sessions")
    listSessions(@CurrentUser() actor: AuthenticatedUser, @Param("id") id: string) {
        return this.adminUsersService.listSessions(actor, id);
    }

    @RequirePermissions(PERMISSIONS.SESSION_REVOKE_ANY)
    @HttpCode(HttpStatus.NO_CONTENT)
    @Delete(":id/sessions/:sessionId")
    revokeSession(
        @CurrentUser() actor: AuthenticatedUser,
        @Param("id") id: string,
        @Param("sessionId") sessionId: string,
    ) {
        return this.adminUsersService.revokeSession(actor, id, sessionId);
    }

    @RequirePermissions(PERMISSIONS.SESSION_REVOKE_ANY)
    @HttpCode(HttpStatus.NO_CONTENT)
    @Delete(":id/sessions")
    revokeAllSessions(@CurrentUser() actor: AuthenticatedUser, @Param("id") id: string) {
        return this.adminUsersService.revokeAllSessions(actor, id);
    }

    @RequirePermissions(PERMISSIONS.USER_INVITE)
    @HttpCode(HttpStatus.CREATED)
    @Post("invite")
    invite(@CurrentUser() actor: AuthenticatedUser, @Body() dto: InviteUserDto) {
        return this.adminUsersService.invite(actor, dto);
    }
}
