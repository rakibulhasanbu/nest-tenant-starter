import { z } from "zod";
import { createZodDto } from "nestjs-zod";

export const updatePlatformSettingsSchema = z
    .strictObject({
        requireTenantApproval: z.boolean().optional(),
        maxTenantsPerUser: z.number().int().min(1).max(100).optional(),
    })
    .refine(value => Object.keys(value).length > 0, "Provide at least one setting to change");

export type UpdatePlatformSettingsInput = z.infer<typeof updatePlatformSettingsSchema>;

export class UpdatePlatformSettingsDto extends createZodDto(updatePlatformSettingsSchema) {}
