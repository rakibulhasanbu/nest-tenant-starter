import { ContextAwareLogger } from "@/common/logging/context-aware.logger.js";
import { runWithTenantStore } from "@/common/tenant/tenant-context.js";

function capture(json: boolean, run: (logger: ContextAwareLogger) => void): string {
    const lines: string[] = [];
    const write = vi.spyOn(process.stdout, "write").mockImplementation(chunk => {
        lines.push(String(chunk));
        return true;
    });
    try {
        run(new ContextAwareLogger({ json, colors: false }));
    } finally {
        write.mockRestore();
    }
    return lines.join("");
}

describe("ContextAwareLogger", () => {
    it("tags a line with the request, tenant and user it belongs to", () => {
        const out = capture(false, logger =>
            runWithTenantStore({ requestId: "req-1", tenantId: "t-1", userId: "u-1" }, () => logger.log("hello", "Ctx")),
        );
        expect(out).toContain("requestId=req-1");
        expect(out).toContain("tenantId=t-1");
        expect(out).toContain("userId=u-1");
    });

    it("marks cross-tenant work as system scope", () => {
        const out = capture(false, logger => runWithTenantStore({ system: true }, () => logger.log("cron", "Ctx")));
        expect(out).toContain("scope=system");
    });

    it("adds nothing outside a request", () => {
        const out = capture(false, logger => logger.log("startup", "Ctx"));
        expect(out).not.toContain("requestId=");
        expect(out).not.toContain("tenantId=");
    });

    it("puts the same fields on the JSON object", () => {
        const out = capture(true, logger =>
            runWithTenantStore({ requestId: "req-2", tenantId: "t-2", userId: "u-2" }, () => logger.log("hi", "Ctx")),
        );
        expect(JSON.parse(out)).toMatchObject({ requestId: "req-2", tenantId: "t-2", userId: "u-2", message: "hi" });
    });
});
