import { z } from "zod";
import { createZodDto } from "nestjs-zod";
import { tenantSlugField } from "@/modules/auth/dto/tenant-fields.js";

export const verifyEmailSchema = z.strictObject({
    email: z.email(),
    code: z.string().regex(/^\d{6}$/),
    tenantSlug: tenantSlugField,
    deviceType: z.string().min(1).max(50).optional(),
    deviceName: z.string().min(1).max(100).optional(),
});

export type VerifyEmailInput = z.infer<typeof verifyEmailSchema>;

export class VerifyEmailDto extends createZodDto(verifyEmailSchema) {}

export const resendVerificationSchema = z.strictObject({
    email: z.email(),
});

export type ResendVerificationInput = z.infer<typeof resendVerificationSchema>;

export class ResendVerificationDto extends createZodDto(resendVerificationSchema) {}
