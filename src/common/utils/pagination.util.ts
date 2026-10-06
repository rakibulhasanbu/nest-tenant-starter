import { z } from "zod";
import type { PaginationMeta } from "@/common/types/api-response.type.js";

/**
 * Spread into a list DTO's schema so every endpoint coerces and bounds
 * `page`/`limit` the same way instead of redefining it per module.
 */
export const paginationSchema = z.object({
    page: z.coerce.number().int().min(1).default(1),
    limit: z.coerce.number().int().min(1).max(100).default(20),
});

export type PaginationParams = z.infer<typeof paginationSchema>;

/** Converts a 1-indexed page/limit into the `limit`/`offset` pair a query takes. */
export function toLimitOffset({ page, limit }: PaginationParams): { limit: number; offset: number } {
    return { limit, offset: (page - 1) * limit };
}

export function buildPaginationMeta({ page, limit }: PaginationParams, total: number): PaginationMeta {
    return { page, limit, total };
}

/** Bundles a page of `items` with its `meta` in the shape the response envelope expects. */
export function paginate<T>(items: T[], params: PaginationParams, total: number): { data: T[]; meta: PaginationMeta } {
    return { data: items, meta: buildPaginationMeta(params, total) };
}
