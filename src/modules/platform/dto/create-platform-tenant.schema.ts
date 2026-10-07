import { z } from "zod";
import { createZodDto } from "nestjs-zod";
import { tenantSlugSchema } from "@/common/tenant/slug.util.js";

/** `requestId` is optional: the admin can also create a tenant with no registration form behind it. */
export const createPlatformTenantSchema = z
    .strictObject({
        name: z.string().trim().min(2).max(100),
        slug: tenantSlugSchema,
        ownerEmail: z
            .email()
            .transform(email => email.toLowerCase())
            .optional(),
        requestId: z.string().min(1).optional(),
    })
    .refine(value => value.ownerEmail || value.requestId, {
        message: "Provide ownerEmail, or a requestId whose email becomes the owner",
        path: ["ownerEmail"],
    });

export type CreatePlatformTenantInput = z.infer<typeof createPlatformTenantSchema>;

export class CreatePlatformTenantDto extends createZodDto(createPlatformTenantSchema) {}
