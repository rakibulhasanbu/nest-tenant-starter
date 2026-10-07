import { z } from "zod";
import { createZodDto } from "nestjs-zod";
import { TenantStatus } from "@/database/schema/enums.js";
import { paginationSchema } from "@/common/utils/pagination.util.js";

export const listTenantsSchema = z.strictObject({
    ...paginationSchema.shape,
    status: z.enum(TenantStatus).optional(),
    q: z.string().trim().min(1).max(100).optional(),
});

export type ListTenantsInput = z.infer<typeof listTenantsSchema>;

export class ListTenantsDto extends createZodDto(listTenantsSchema) {}
