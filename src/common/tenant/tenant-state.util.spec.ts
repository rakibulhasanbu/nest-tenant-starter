import { ForbiddenException } from "@nestjs/common";
import { assertTenantUsable } from "@/common/tenant/tenant-state.util.js";
import { TenantStatus } from "@/database/schema/enums.js";

function thrownBody(status: TenantStatus, reason: string | null = null): Record<string, unknown> | undefined {
    try {
        assertTenantUsable(status, reason);
    } catch (error) {
        expect(error).toBeInstanceOf(ForbiddenException);
        return (error as ForbiddenException).getResponse() as Record<string, unknown>;
    }
    return undefined;
}

describe("assertTenantUsable", () => {
    it("lets an ACTIVE tenant through", () => {
        expect(thrownBody(TenantStatus.ACTIVE)).toBeUndefined();
    });

    it("gives each unusable state its own code", () => {
        expect(thrownBody(TenantStatus.PENDING_APPROVAL)).toMatchObject({ code: "TENANT_PENDING_APPROVAL" });
        expect(thrownBody(TenantStatus.REJECTED)).toMatchObject({ code: "TENANT_REJECTED" });
        expect(thrownBody(TenantStatus.SUSPENDED)).toMatchObject({ code: "TENANT_SUSPENDED" });
    });

    it("carries the rejection reason for the client to show", () => {
        expect(thrownBody(TenantStatus.REJECTED, "Not a real business")).toMatchObject({
            reason: "Not a real business",
        });
    });
});
