import { z } from "zod";
import { createZodDto } from "nestjs-zod";
import { tenantSlugField } from "@/modules/auth/dto/tenant-fields.js";

export const twoFactorLoginVerifySchema = z
    .strictObject({
        twoFactorToken: z.string().min(1),
        code: z
            .string()
            .regex(/^\d{6}$/)
            .optional(),
        recoveryCode: z.string().min(1).optional(),
        tenantSlug: tenantSlugField,
        deviceType: z.string().min(1).max(50).optional(),
        deviceName: z.string().min(1).max(100).optional(),
    })
    .refine(data => Boolean(data.code) !== Boolean(data.recoveryCode), {
        message: "Provide exactly one of code or recoveryCode",
        path: ["code"],
    });

export type TwoFactorLoginVerifyInput = z.infer<typeof twoFactorLoginVerifySchema>;

export class TwoFactorLoginVerifyDto extends createZodDto(twoFactorLoginVerifySchema) {}
