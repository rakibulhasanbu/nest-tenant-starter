import { z } from "zod";
import { createZodDto } from "nestjs-zod";

export const rejectTenantSchema = z.strictObject({
    reason: z.string().trim().min(1).max(500).optional(),
});

export type RejectTenantInput = z.infer<typeof rejectTenantSchema>;

export class RejectTenantDto extends createZodDto(rejectTenantSchema) {}
