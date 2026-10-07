import { z } from "zod";
import { createZodDto } from "nestjs-zod";
import { tenantSlugSchema } from "@/common/tenant/slug.util.js";

export const switchTenantSchema = z.strictObject({
    tenantSlug: tenantSlugSchema,
});

export type SwitchTenantInput = z.infer<typeof switchTenantSchema>;

export class SwitchTenantDto extends createZodDto(switchTenantSchema) {}
