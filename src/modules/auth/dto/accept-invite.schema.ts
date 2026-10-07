import { z } from "zod";
import { createZodDto } from "nestjs-zod";

/** The token comes from the emailed link; it already names the tenant, so no email or slug is sent. */
export const acceptInviteSchema = z.strictObject({
    token: z.string().regex(/^[0-9a-f]{64}$/),
    password: z.string().min(8).max(72),
    deviceType: z.string().min(1).max(50).optional(),
    deviceName: z.string().min(1).max(100).optional(),
});

export type AcceptInviteInput = z.infer<typeof acceptInviteSchema>;

export class AcceptInviteDto extends createZodDto(acceptInviteSchema) {}
