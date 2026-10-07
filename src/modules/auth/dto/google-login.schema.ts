import { z } from "zod";
import { createZodDto } from "nestjs-zod";
import { tenantSlugSchema } from "@/common/tenant/slug.util.js";
import { tenantSlugField } from "@/modules/auth/dto/tenant-fields.js";

export const googleLoginSchema = z.strictObject({
    idToken: z.string().min(1),
    /** Which existing organization to sign in to (mobile, apex site). */
    tenantSlug: tenantSlugField,
    /** Required only the first time a Google identity signs up: it creates its own organization. */
    newTenant: z.strictObject({ name: z.string().trim().min(2).max(100), slug: tenantSlugSchema }).optional(),
});

export type GoogleLoginInput = z.infer<typeof googleLoginSchema>;

export class GoogleLoginDto extends createZodDto(googleLoginSchema) {}
