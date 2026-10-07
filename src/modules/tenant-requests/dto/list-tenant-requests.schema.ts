import { z } from "zod";
import { createZodDto } from "nestjs-zod";
import { paginationSchema } from "@/common/utils/pagination.util.js";
import { TenantRequestStatus } from "@/database/schema/enums.js";

export const listTenantRequestsSchema = z.strictObject({
    ...paginationSchema.shape,
    status: z.enum(TenantRequestStatus).optional(),
    q: z.string().trim().min(1).max(100).optional(),
});

export type ListTenantRequestsInput = z.infer<typeof listTenantRequestsSchema>;

export class ListTenantRequestsDto extends createZodDto(listTenantRequestsSchema) {}
