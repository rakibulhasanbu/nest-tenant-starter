import { z } from "zod";
import { createZodDto } from "nestjs-zod";
import { tenantSlugSchema } from "@/common/tenant/slug.util.js";

export const signupSchema = z.strictObject({
    email: z.email(),
    password: z.string().min(8).max(72),
    name: z.string().min(1).max(100).optional(),
    phone: z.string().min(5).max(20).optional(),
    /** Signing up creates an organization, and the signer becomes its owner. */
    tenantName: z.string().trim().min(2).max(100),
    /** Becomes the subdomain: `<tenantSlug>.<root domain>`. Permanent. */
    tenantSlug: tenantSlugSchema,
});

export type SignupInput = z.infer<typeof signupSchema>;

export class SignupDto extends createZodDto(signupSchema) {}
