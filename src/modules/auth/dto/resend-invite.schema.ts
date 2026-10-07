import { z } from "zod";
import { createZodDto } from "nestjs-zod";

export const resendInviteSchema = z.strictObject({
    email: z.email().transform(email => email.toLowerCase()),
});

export type ResendInviteInput = z.infer<typeof resendInviteSchema>;

export class ResendInviteDto extends createZodDto(resendInviteSchema) {}
