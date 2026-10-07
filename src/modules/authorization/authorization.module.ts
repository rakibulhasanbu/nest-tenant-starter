import { Global, Module } from "@nestjs/common";
import { PermissionsCacheService } from "@/modules/authorization/permissions-cache.service.js";
import { PermissionsService } from "@/modules/authorization/permissions.service.js";
import { RoleProvisioningService } from "@/modules/authorization/role-provisioning.service.js";

/**
 * Global because the permission guard runs on every route and therefore needs
 * PermissionsService available application-wide, not just where it is imported.
 */
@Global()
@Module({
    providers: [PermissionsCacheService, PermissionsService, RoleProvisioningService],
    exports: [PermissionsCacheService, PermissionsService, RoleProvisioningService],
})
export class AuthorizationModule {}
