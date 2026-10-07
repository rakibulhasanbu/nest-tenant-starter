import { z } from "zod";
import { tenantSlugSchema } from "@/common/tenant/slug.util.js";

/**
 * Optional on every login-shaped body: clients with no subdomain (mobile, or the
 * apex site) name the organization they are signing in to. When the request
 * arrives on a tenant subdomain the host decides and this is ignored.
 */
export const tenantSlugField = tenantSlugSchema.optional();

export const deviceFields = {
    deviceType: z.string().min(1).max(50).optional(),
    deviceName: z.string().min(1).max(100).optional(),
};
