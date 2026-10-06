import { buildPaginationMeta, paginate, toLimitOffset } from "@/common/utils/pagination.util.js";

describe("toLimitOffset", () => {
    it("computes offset from page and limit", () => {
        expect(toLimitOffset({ page: 1, limit: 20 })).toEqual({ limit: 20, offset: 0 });
        expect(toLimitOffset({ page: 3, limit: 10 })).toEqual({ limit: 10, offset: 20 });
    });
});

describe("buildPaginationMeta", () => {
    it("carries page and limit through alongside total", () => {
        expect(buildPaginationMeta({ page: 2, limit: 20 }, 45)).toEqual({ page: 2, limit: 20, total: 45 });
    });
});

describe("paginate", () => {
    it("wraps items and meta in the response envelope shape", () => {
        const items = [{ id: "a" }, { id: "b" }];

        expect(paginate(items, { page: 1, limit: 20 }, 2)).toEqual({
            data: items,
            meta: { page: 1, limit: 20, total: 2 },
        });
    });
});
