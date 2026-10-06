import { z } from "zod";
import { createZodDto } from "nestjs-zod";

/** `password` is omitted by accounts that have none (Google-only); the service enforces it for the rest. */
export const twoFactorDisableSchema = z.strictObject({
    password: z.string().min(1).optional(),
    code: z.string().regex(/^\d{6}$/),
});

export type TwoFactorDisableInput = z.infer<typeof twoFactorDisableSchema>;

export class TwoFactorDisableDto extends createZodDto(twoFactorDisableSchema) {}
