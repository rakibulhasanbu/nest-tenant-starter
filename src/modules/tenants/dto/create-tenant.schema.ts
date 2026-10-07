import { z } from "zod";
import { createZodDto } from "nestjs-zod";
import { tenantSlugSchema } from "@/common/tenant/slug.util.js";

export const createTenantSchema = z.strictObject({
    name: z.string().trim().min(2).max(100),
    slug: tenantSlugSchema,
});

export type CreateTenantInput = z.infer<typeof createTenantSchema>;

export class CreateTenantDto extends createZodDto(createTenantSchema) {}
