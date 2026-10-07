import { Global, Module } from "@nestjs/common";
import { UsersModule } from "@/modules/users/users.module.js";
import { PermissionsCacheService } from "@/modules/authorization/permissions-cache.service.js";
import { PermissionsService } from "@/modules/authorization/permissions.service.js";
import { RolesService } from "@/modules/authorization/roles.service.js";
import { RoleProvisioningService } from "@/modules/authorization/role-provisioning.service.js";

/**
 * Global because the permission guard runs on every route and therefore needs
 * PermissionsService available application-wide, not just where it is imported.
 */
@Global()
@Module({
    imports: [UsersModule],
    providers: [PermissionsCacheService, PermissionsService, RoleProvisioningService, RolesService],
    exports: [PermissionsCacheService, PermissionsService, RoleProvisioningService, RolesService],
})
export class AuthorizationModule {}
