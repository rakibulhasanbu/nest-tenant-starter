import { z } from "zod";
import { createZodDto } from "nestjs-zod";
import { paginationSchema } from "@/common/utils/pagination.util.js";

const filters = {
    ...paginationSchema.shape,
    /** Exact action ("role.updated") or a prefix ending in ".*" ("role.*"). */
    action: z
        .string()
        .trim()
        .regex(/^[a-z][a-z0-9.-]*(\.\*)?$/)
        .max(80)
        .optional(),
    actorId: z.string().min(1).optional(),
    from: z.coerce.date().optional(),
    to: z.coerce.date().optional(),
};

export const listAuditLogsSchema = z.strictObject(filters);
export type ListAuditLogsInput = z.infer<typeof listAuditLogsSchema>;
export class ListAuditLogsDto extends createZodDto(listAuditLogsSchema) {}

/** The super admin can also narrow to one tenant, or to platform-level rows only. */
export const listPlatformAuditLogsSchema = z.strictObject({
    ...filters,
    tenantId: z.string().min(1).optional(),
    platformOnly: z
        .enum(["true", "false"])
        .transform(value => value === "true")
        .optional(),
});
export type ListPlatformAuditLogsInput = z.infer<typeof listPlatformAuditLogsSchema>;
export class ListPlatformAuditLogsDto extends createZodDto(listPlatformAuditLogsSchema) {}
