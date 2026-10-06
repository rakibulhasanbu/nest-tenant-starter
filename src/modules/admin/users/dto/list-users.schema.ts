import { z } from "zod";
import { createZodDto } from "nestjs-zod";
import { UserStatus } from "@/database/schema/enums.js";
import { paginationSchema } from "@/common/utils/pagination.util.js";

export const listUsersSchema = z.strictObject({
    ...paginationSchema.shape,
    search: z.string().min(1).max(100).optional(),
    /** Role slug, e.g. "admin". Free-form because roles are created at runtime. */
    roleId: z.string().min(1).max(50).optional(),
    status: z.enum(UserStatus).optional(),
    /** `z.coerce.boolean()` would read the string "false" as true — every non-empty string is truthy. */
    deleted: z.stringbool().optional(),
});

export type ListUsersInput = z.infer<typeof listUsersSchema>;

export class ListUsersDto extends createZodDto(listUsersSchema) {}
