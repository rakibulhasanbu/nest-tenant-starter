import { z } from "zod";
import { createZodDto } from "nestjs-zod";

/** `extra` carries any question added to the form later, so the schema does not change with it. */
export const createTenantRequestSchema = z.strictObject({
    businessName: z.string().trim().min(2).max(100),
    ownerName: z.string().trim().min(2).max(100),
    email: z.email().transform(email => email.toLowerCase()),
    phone: z.string().trim().min(5).max(30),
    dateOfBirth: z.iso.date().refine(value => new Date(value) < new Date(), "Date of birth must be in the past"),
    address: z.string().trim().min(5).max(300),
    extra: z.record(z.string().max(50), z.union([z.string().max(500), z.number(), z.boolean()])).default({}),
});

export type CreateTenantRequestInput = z.infer<typeof createTenantRequestSchema>;

export class CreateTenantRequestDto extends createZodDto(createTenantRequestSchema) {}
