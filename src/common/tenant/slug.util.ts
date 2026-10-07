import { z } from "zod";
import { RESERVED_SLUGS } from "@/common/tenant/reserved-slugs.constant.js";

/** 3–32 chars, lowercase letters/digits/hyphens, no leading or trailing hyphen — a valid DNS label. */
export const SLUG_PATTERN = /^[a-z0-9][a-z0-9-]{1,30}[a-z0-9]$/;

export function isReservedSlug(slug: string): boolean {
    return RESERVED_SLUGS.has(slug);
}

/** Shared by every DTO that accepts a tenant slug, so the rules cannot drift. */
export const tenantSlugSchema = z
    .string()
    .regex(
        SLUG_PATTERN,
        "Slug must be 3-32 characters: lowercase letters, digits and hyphens, not starting or ending with a hyphen",
    )
    .refine(slug => !isReservedSlug(slug), "This slug is reserved");
