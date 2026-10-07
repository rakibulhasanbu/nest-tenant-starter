import { z } from "zod";
import { createZodDto } from "nestjs-zod";
import { tenantSlugSchema } from "@/common/tenant/slug.util.js";
import { deviceFields } from "@/modules/auth/dto/tenant-fields.js";

export const selectTenantSchema = z.strictObject({
    selectionToken: z.string().min(1),
    tenantSlug: tenantSlugSchema,
    ...deviceFields,
});

export type SelectTenantInput = z.infer<typeof selectTenantSchema>;

export class SelectTenantDto extends createZodDto(selectTenantSchema) {}
