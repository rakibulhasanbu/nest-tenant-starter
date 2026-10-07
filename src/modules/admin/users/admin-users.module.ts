import { Module } from "@nestjs/common";
import { AuthModule } from "@/modules/auth/auth.module.js";
import { UsersModule } from "@/modules/users/users.module.js";
import { TenantsModule } from "@/modules/tenants/tenants.module.js";
import { AdminUsersController } from "@/modules/admin/users/admin-users.controller.js";
import { AdminUsersService } from "@/modules/admin/users/admin-users.service.js";

@Module({
    imports: [UsersModule, AuthModule, TenantsModule],
    controllers: [AdminUsersController],
    providers: [AdminUsersService],
})
export class AdminUsersModule {}
