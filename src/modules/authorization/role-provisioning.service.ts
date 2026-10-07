import { Injectable } from "@nestjs/common";
import { ROLE_TEMPLATES, type RoleSlug } from "@/common/authorization/role-templates.constant.js";
import type { DbClient } from "@/database/database.type.js";
import { rolePermissions, roles } from "@/database/schema/authorization.js";

/**
 * Gives a new tenant its own editable copy of every role template. Called from
 * the transaction that creates the tenant, so a tenant can never exist without
 * its roles. The caller must already be scoped to `tenantId` (RLS).
 */
@Injectable()
export class RoleProvisioningService {
    /** Returns the new role row ids keyed by slug. */
    async provision(tenantId: string, client: DbClient): Promise<Record<RoleSlug, string>> {
        const ids = {} as Record<RoleSlug, string>;

        for (const template of ROLE_TEMPLATES) {
            const [role] = await client
                .insert(roles)
                .values({
                    tenantId,
                    slug: template.slug,
                    name: template.name,
                    description: template.description,
                    rank: template.rank,
                    isSystem: true,
                })
                .returning({ id: roles.id });

            ids[template.slug] = role!.id;

            if (template.permissions.length > 0) {
                await client
                    .insert(rolePermissions)
                    .values(template.permissions.map(permissionKey => ({ tenantId, roleId: role!.id, permissionKey })));
            }
        }

        return ids;
    }
}
