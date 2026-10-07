import type { Request } from "express";
import type { HostKind } from "@/common/tenant/tenant-host.util.js";
import type { TenantStatus } from "@/database/schema/enums.js";

/** What the request's host says about the tenant, set by the host middleware. */
export interface HostContext {
    kind: HostKind;
    /** Present when `kind` is `tenant`. The tenant may be in any status; the guard decides what that allows. */
    tenant: { id: string; slug: string; name: string; status: TenantStatus } | null;
}

export interface RequestWithHost extends Request {
    hostContext: HostContext;
}
