import { z } from "zod";
import { createZodDto } from "nestjs-zod";
import { tenantSlugField } from "@/modules/auth/dto/tenant-fields.js";

export const resetPasswordSchema = z.strictObject({
    email: z.email(),
    code: z.string().regex(/^\d{6}$/),
    password: z.string().min(8).max(72),
    tenantSlug: tenantSlugField,
    deviceType: z.string().min(1).max(50).optional(),
    deviceName: z.string().min(1).max(100).optional(),
});

export type ResetPasswordInput = z.infer<typeof resetPasswordSchema>;

export class ResetPasswordDto extends createZodDto(resetPasswordSchema) {}
