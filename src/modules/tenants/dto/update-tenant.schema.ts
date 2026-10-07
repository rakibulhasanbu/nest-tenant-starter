import { z } from "zod";
import { createZodDto } from "nestjs-zod";

/** The slug is deliberately absent: it is the tenant's address and never changes. */
export const updateTenantSchema = z.strictObject({
    name: z.string().trim().min(2).max(100),
});

export type UpdateTenantInput = z.infer<typeof updateTenantSchema>;

export class UpdateTenantDto extends createZodDto(updateTenantSchema) {}
