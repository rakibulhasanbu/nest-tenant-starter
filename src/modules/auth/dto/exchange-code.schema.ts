import { z } from "zod";
import { createZodDto } from "nestjs-zod";
import { deviceFields } from "@/modules/auth/dto/tenant-fields.js";

export const exchangeCodeSchema = z.strictObject({
    code: z.string().min(1),
    ...deviceFields,
});

export type ExchangeCodeInput = z.infer<typeof exchangeCodeSchema>;

export class ExchangeCodeDto extends createZodDto(exchangeCodeSchema) {}
