import { Body, Controller, Delete, Get, HttpCode, HttpStatus, Param, Post, Req } from "@nestjs/common";
import { Throttle } from "@nestjs/throttler";
import type { Request } from "express";
import { CurrentUser } from "@/common/decorators/current-user.decorator.js";
import { AuthenticatedOnly } from "@/common/decorators/authenticated-only.decorator.js";
import { Public } from "@/common/decorators/public.decorator.js";
import type { AuthenticatedUser } from "@/common/types/authenticated-request.type.js";
import { AuthService } from "@/modules/auth/auth.service.js";
import { SignupDto } from "@/modules/auth/dto/signup.schema.js";
import { SigninDto } from "@/modules/auth/dto/signin.schema.js";
import { RefreshTokenDto } from "@/modules/auth/dto/refresh-token.schema.js";
import { LogoutDto } from "@/modules/auth/dto/logout.schema.js";
import { VerifyEmailDto, ResendVerificationDto } from "@/modules/auth/dto/verify-email.schema.js";
import { ForgotPasswordDto } from "@/modules/auth/dto/forgot-password.schema.js";
import { ReactivateAccountDto } from "@/modules/auth/dto/reactivate-account.schema.js";
import { ResetPasswordDto } from "@/modules/auth/dto/reset-password.schema.js";
import { ChangePasswordDto } from "@/modules/auth/dto/change-password.schema.js";
import { GoogleLoginDto } from "@/modules/auth/dto/google-login.schema.js";
import { SetPasswordDto } from "@/modules/auth/dto/set-password.schema.js";
import { DeleteAccountDto } from "@/modules/auth/dto/delete-account.schema.js";
import { TwoFactorEnableDto } from "@/modules/auth/dto/two-factor-enable.schema.js";
import { TwoFactorDisableDto } from "@/modules/auth/dto/two-factor-disable.schema.js";
import { TwoFactorLoginVerifyDto } from "@/modules/auth/dto/two-factor-login-verify.schema.js";

@Controller("auth")
export class AuthController {
    constructor(private readonly authService: AuthService) {}

    @Public()
    @Throttle({ default: { limit: 5, ttl: 60_000 } })
    @Post("signup")
    signup(@Body() dto: SignupDto) {
        return this.authService.signup(dto);
    }

    @Public()
    @Throttle({ default: { limit: 10, ttl: 60_000 } })
    @HttpCode(HttpStatus.OK)
    @Post("signin")
    signin(@Body() dto: SigninDto, @Req() req: Request) {
        return this.authService.signin(dto, { userAgent: req.headers["user-agent"], ipAddress: req.ip });
    }

    @Public()
    @HttpCode(HttpStatus.OK)
    @Post("refresh")
    refresh(@Body() dto: RefreshTokenDto, @Req() req: Request) {
        return this.authService.refresh(
            dto.refreshToken,
            { userAgent: req.headers["user-agent"], ipAddress: req.ip },
            { deviceType: dto.deviceType, deviceName: dto.deviceName },
        );
    }

    @Public()
    @HttpCode(HttpStatus.NO_CONTENT)
    @Post("logout")
    async logout(@Body() dto: LogoutDto) {
        await this.authService.logout(dto.refreshToken);
    }

    @Public()
    @HttpCode(HttpStatus.OK)
    @Post("verify-email")
    verifyEmail(@Body() dto: VerifyEmailDto, @Req() req: Request) {
        return this.authService.verifyEmail(
            dto.email,
            dto.code,
            { userAgent: req.headers["user-agent"], ipAddress: req.ip },
            { deviceType: dto.deviceType, deviceName: dto.deviceName },
        );
    }

    @Public()
    @Throttle({ default: { limit: 3, ttl: 60_000 } })
    @HttpCode(HttpStatus.NO_CONTENT)
    @Post("resend-verification")
    async resendVerification(@Body() dto: ResendVerificationDto) {
        await this.authService.resendVerification(dto.email);
    }

    /**
     * Undoes a self-service deletion within its grace period. No session comes
     * back — the account is restored and the user signs in as usual, so 2FA and
     * every other login rule still apply.
     */
    @Public()
    @Throttle({ default: { limit: 5, ttl: 60_000 } })
    @HttpCode(HttpStatus.NO_CONTENT)
    @Post("reactivate-account")
    async reactivateAccount(@Body() dto: ReactivateAccountDto) {
        await this.authService.reactivateAccount(dto.email, dto.code);
    }

    @Public()
    @Throttle({ default: { limit: 3, ttl: 60_000 } })
    @HttpCode(HttpStatus.NO_CONTENT)
    @Post("forgot-password")
    async forgotPassword(@Body() dto: ForgotPasswordDto) {
        await this.authService.forgotPassword(dto.email);
    }

    @Public()
    @HttpCode(HttpStatus.OK)
    @Post("reset-password")
    resetPassword(@Body() dto: ResetPasswordDto, @Req() req: Request) {
        return this.authService.resetPassword(
            dto.email,
            dto.code,
            dto.password,
            { userAgent: req.headers["user-agent"], ipAddress: req.ip },
            { deviceType: dto.deviceType, deviceName: dto.deviceName },
        );
    }

    @Public()
    @Throttle({ default: { limit: 10, ttl: 60_000 } })
    @HttpCode(HttpStatus.OK)
    @Post("google")
    googleLogin(@Body() dto: GoogleLoginDto, @Req() req: Request) {
        return this.authService.loginWithGoogle(dto.idToken, {
            userAgent: req.headers["user-agent"],
            ipAddress: req.ip,
        });
    }

    @AuthenticatedOnly()
    @HttpCode(HttpStatus.NO_CONTENT)
    @Post("set-password")
    async setPassword(@CurrentUser() currentUser: AuthenticatedUser, @Body() dto: SetPasswordDto) {
        await this.authService.setPassword(currentUser.id, dto.newPassword);
    }

    @AuthenticatedOnly()
    @HttpCode(HttpStatus.NO_CONTENT)
    @Post("change-password")
    async changePassword(@CurrentUser() currentUser: AuthenticatedUser, @Body() dto: ChangePasswordDto) {
        await this.authService.changePassword(currentUser.id, dto.currentPassword, dto.newPassword);
    }

    @AuthenticatedOnly()
    @Throttle({ default: { limit: 3, ttl: 60_000 } })
    @HttpCode(HttpStatus.NO_CONTENT)
    @Post("request-account-deletion")
    async requestAccountDeletion(@CurrentUser() currentUser: AuthenticatedUser) {
        await this.authService.requestAccountDeletion(currentUser.id);
    }

    @AuthenticatedOnly()
    @HttpCode(HttpStatus.NO_CONTENT)
    @Post("delete-account")
    async deleteAccount(@CurrentUser() currentUser: AuthenticatedUser, @Body() dto: DeleteAccountDto) {
        await this.authService.deleteAccount(currentUser.id, dto.code);
    }

    @AuthenticatedOnly()
    @Get("sessions")
    listSessions(@CurrentUser() currentUser: AuthenticatedUser) {
        return this.authService.listSessions(currentUser.id, currentUser.sessionId);
    }

    @AuthenticatedOnly()
    @HttpCode(HttpStatus.NO_CONTENT)
    @Delete("sessions/:sessionId")
    revokeSession(@CurrentUser() currentUser: AuthenticatedUser, @Param("sessionId") sessionId: string) {
        return this.authService.revokeSession(currentUser.id, sessionId);
    }

    @AuthenticatedOnly()
    @HttpCode(HttpStatus.NO_CONTENT)
    @Delete("sessions")
    revokeAllSessions(@CurrentUser() currentUser: AuthenticatedUser) {
        return this.authService.revokeAllSessions(currentUser.id);
    }

    @AuthenticatedOnly()
    @HttpCode(HttpStatus.OK)
    @Post("2fa/setup")
    setupTwoFactor(@CurrentUser() currentUser: AuthenticatedUser) {
        return this.authService.setupTwoFactor(currentUser.id);
    }

    @AuthenticatedOnly()
    @HttpCode(HttpStatus.OK)
    @Post("2fa/enable")
    enableTwoFactor(@CurrentUser() currentUser: AuthenticatedUser, @Body() dto: TwoFactorEnableDto) {
        return this.authService.enableTwoFactor(currentUser.id, dto.code);
    }

    @AuthenticatedOnly()
    @HttpCode(HttpStatus.NO_CONTENT)
    @Post("2fa/disable")
    async disableTwoFactor(@CurrentUser() currentUser: AuthenticatedUser, @Body() dto: TwoFactorDisableDto) {
        await this.authService.disableTwoFactor(currentUser.id, dto.password, dto.code);
    }

    @Public()
    @Throttle({ default: { limit: 10, ttl: 60_000 } })
    @HttpCode(HttpStatus.OK)
    @Post("2fa/login-verify")
    loginWithTwoFactor(@Body() dto: TwoFactorLoginVerifyDto, @Req() req: Request) {
        return this.authService.loginWithTwoFactor(
            dto.twoFactorToken,
            dto.code,
            dto.recoveryCode,
            { userAgent: req.headers["user-agent"], ipAddress: req.ip },
            { deviceType: dto.deviceType, deviceName: dto.deviceName },
        );
    }
}
