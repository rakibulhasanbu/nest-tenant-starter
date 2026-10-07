import { Module } from "@nestjs/common";
import { JwtModule } from "@nestjs/jwt";
import { PassportModule } from "@nestjs/passport";
import { EmailModule } from "@/integrations/email/email.module.js";
import { UsersModule } from "@/modules/users/users.module.js";
import { TenantsModule } from "@/modules/tenants/tenants.module.js";
import { AuthController } from "@/modules/auth/auth.controller.js";
import { AuthService } from "@/modules/auth/auth.service.js";
import { TokensService } from "@/modules/auth/tokens.service.js";
import { EmailTokensService } from "@/modules/auth/email-tokens.service.js";
import { GoogleAuthService } from "@/modules/auth/google-auth.service.js";
import { SocialIdentitiesService } from "@/modules/auth/social-identities.service.js";
import { TwoFactorService } from "@/modules/auth/two-factor.service.js";
import { AuthCleanupTask } from "@/modules/auth/auth-cleanup.task.js";
import { JwtStrategy } from "@/modules/auth/strategies/jwt.strategy.js";

@Module({
    imports: [PassportModule, JwtModule.register({}), UsersModule, TenantsModule, EmailModule],
    controllers: [AuthController],
    providers: [
        AuthService,
        TokensService,
        EmailTokensService,
        SocialIdentitiesService,
        GoogleAuthService,
        TwoFactorService,
        AuthCleanupTask,
        JwtStrategy,
    ],
    exports: [TokensService, EmailTokensService, AuthService],
})
export class AuthModule {}
