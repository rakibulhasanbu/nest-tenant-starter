import { z } from "zod";
import { createZodDto } from "nestjs-zod";
import { Gender } from "@/database/schema/enums.js";

/** Mirrors the `user_profiles` table: optional personal details, nested so the
 *  request body has the same shape as the response. */
const updateMeProfileSchema = z.strictObject({
    dateOfBirth: z.iso.date().optional(),
    gender: z.enum(Gender).optional(),
    bio: z.string().max(500).optional(),
});

export const updateMeSchema = z.strictObject({
    name: z.string().min(1).max(100).optional(),
    username: z
        .string()
        .min(3)
        .max(30)
        .regex(/^[a-z0-9_.]+$/, "Only lowercase letters, numbers, underscores and dots are allowed")
        .optional(),
    phone: z.string().min(5).max(20).optional(),
    avatarUrl: z.url().optional(),
    profile: updateMeProfileSchema.optional(),
});

export type UpdateMeInput = z.infer<typeof updateMeSchema>;

export class UpdateMeDto extends createZodDto(updateMeSchema) {}
