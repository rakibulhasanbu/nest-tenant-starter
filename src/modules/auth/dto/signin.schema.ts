import { z } from "zod";
import { createZodDto } from "nestjs-zod";
import { tenantSlugField } from "@/modules/auth/dto/tenant-fields.js";

export const signinSchema = z.strictObject({
    email: z.email(),
    password: z.string().min(1),
    /** Which organization to sign in to when the request is not on its subdomain (mobile, apex site). */
    tenantSlug: tenantSlugField,
    deviceType: z.string().min(1).max(50).optional(),
    deviceName: z.string().min(1).max(100).optional(),
});

export type SigninInput = z.infer<typeof signinSchema>;

export class SigninDto extends createZodDto(signinSchema) {}
