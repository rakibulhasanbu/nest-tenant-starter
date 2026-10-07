import { z } from "zod";
import { createZodDto } from "nestjs-zod";
import { TenantOnboardingMode } from "@/database/schema/enums.js";

export const updatePlatformSettingsSchema = z
    .strictObject({
        tenantOnboardingMode: z.enum(TenantOnboardingMode).optional(),
        requireTenantApproval: z.boolean().optional(),
        maxTenantsPerUser: z.number().int().min(1).max(100).optional(),
    })
    .refine(value => Object.keys(value).length > 0, "Provide at least one setting to change");

export type UpdatePlatformSettingsInput = z.infer<typeof updatePlatformSettingsSchema>;

export class UpdatePlatformSettingsDto extends createZodDto(updatePlatformSettingsSchema) {}
