Use Drizzle ORM (v1) with `@nestjs/drizzle` and node-postgres. Inject the database with `@InjectDrizzle() private readonly db: Database` (type from `@/database/database.type.js`); schema lives in `src/database/schema/`.

use absolute path please

the folder architecture should be:
src/
├── config/
├── common/
├── database/
├── integrations/
├── modules/
├── app.module.ts
└── main.ts

do not add index.ts type files where all files export didnt need that.

use zod strictObject when create schema and then nestjs-zod use this to convert class dto and use in the controller and in the service use dto type which is create from the schema

Response convention: Paginated endpoints must return {data, meta:{page,limit,total}} from the service layer.

## Multi-tenancy & microservice-ready rules

Modular monolith: one deployable, hard module boundaries, so a module can be cut out into its own service later without a rewrite. Full plan and rationale: `context/multi-tenant-plan.md`.

- Shared DB, shared schema. Every tenant-owned table has `tenant_id NOT NULL` + the `tenantIsolationPolicy` RLS policy (`src/database/schema/rls.ts`) + `.enableRLS()`. Identity tables (`users`, profiles, social identities, tokens) and `tenants`/`permissions`/`platform_*` are global; access is granted by `tenant_memberships`.
- The app connects as `app_user` (`DATABASE_URL`), never the owner — RLS does not bind owners/superusers. Migrations, `db:roles` and the seed use `DATABASE_ADMIN_URL`.
- Tenant comes only from the access-token `tenantId` claim. `PermissionsGuard` puts it in `TenantContext` (`AsyncLocalStorage`, `src/common/tenant/tenant-context.ts`); `TenantAwarePool` stamps every connection with it (`app.tenant_id`) so RLS enforces it. Never trust a client-sent tenant id on authenticated routes.
- No tenant in scope = no tenant-owned rows visible (fail closed). Code that legitimately crosses tenants uses `tenantContext.runAsSystem(...)` (signin listing memberships, platform work); code that works for a specific tenant outside a request uses `tenantContext.runAs(tenantId, ...)`. Both await the callback *inside* the scope — Drizzle queries are lazy, so a query returned un-awaited from the scope would run under the wrong tenant.
- Each tenant has a subdomain (`<slug>.<APP_ROOT_DOMAIN>`), resolved by `TenantHostMiddleware`. On a tenant host the host's tenant must equal the token's `tenantId`, else 403 `TENANT_MISMATCH`. Apex/reserved hosts (mobile, `api.`) accept any tenant token. The platform host (`<PLATFORM_SUBDOMAIN>.<root>`) accepts only the super admin.
- Signup creates a tenant. `platform_settings.requireTenantApproval` (super admin toggle) decides `ACTIVE` vs `PENDING_APPROVAL` *at that moment*; flipping it later never touches existing tenants.
- Exactly one platform user: the super admin (`platform_admins`, fixed `PLATFORM_PERMISSIONS`, not a role). All roles belong to a tenant; templates live in `role-templates.constant.ts` and are copied into each new tenant.
- Users are global identities. A tenant admin manages *memberships* (roles, suspension, sessions in that tenant) and can never edit, restore or delete the account itself.
- A tenant always keeps at least one `owner`.
- A module owns its tables. Another module must not import its `@/database/schema/*` tables or query them — call its exported service instead. (`tenants` + `authorization` are one "access" context and share tables.)
- Cross-module references are IDs only (`tenantId`, `userId`). Side effects go through domain events (`tenant.created`, `tenant.approved`, ... in `modules/tenants/tenant.events.ts`) via `@nestjs/event-emitter` — the contract that would move to a broker.
- Keep the app stateless; config, cache, queue and email stay behind `integrations/`. Redis keys for tenant data must include the tenant (`perm:{tenantId}:{userId}`).
- Every new tenant-owned table: `tenantId` column (FK to `tenants`, cascade), `tenantIsolationPolicy(...)`, `.enableRLS()`, index on `tenant_id`.

## API contract (the clients mirror this — changing it breaks them)

Authorization is permission-based. Nothing ever checks a role *name*; it checks
a permission key from `src/common/authorization/permissions.constant.ts`. Roles
are runtime rows with editable contents, so "is this role called admin" answers
the wrong question — in the clients too, which gate on
`hasPermission(user.permissions, PERMISSIONS.*)`.

Role ids are lowercase slugs (`owner`, `admin`, `user`, plus tenant-created ones),
**unique per tenant** — the tenant is implicit from the session. Users carry
`roleIds: string[]` *for the current tenant*; there is no `role` field on any
response. Role assignment has its own endpoint (`PATCH /admin/users/:id/roles`).
`super_admin` is not a role any more: the super admin is a platform principal
(`tenantId: null`) with a fixed permission set, never listed in a tenant.

## Multi-tenant API additions

Tokens: the access token carries `tenantId` (`null` = platform session); refresh
sessions are bound to that tenant. `permVersion` is the *membership's*.

Auth responses (`signin`, `verify-email`, `reset-password`, `google`, `2fa/login-verify`,
`refresh`, `select-tenant`, `exchange`) return `{ accessToken, refreshToken, tenant }`,
where `tenant` is `{ id, slug, name, url }` (`null` on the platform host). Signin that
matches several usable organizations returns instead
`{ tenantSelectionRequired: true, selectionToken, tenants: [{ slug, name, status, url }] }`;
finish with `POST /auth/select-tenant`. Clients with no subdomain (mobile, apex site)
send `tenantSlug` in the login body; on a tenant subdomain the host decides.

- `POST /auth/signup` additionally takes `tenantName` + `tenantSlug` and returns `{ user, tenant }`.
- `POST /auth/google` takes `newTenant: { name, slug }` the first time an identity signs up.
- `POST /auth/switch-tenant { tenantSlug }` → `{ tenant, exchangeCode }`; redeem with
  `POST /auth/exchange { code }` on the target host (one-time, 60s, host-bound).
- `POST /tenants { name, slug }` — a signed-in user starts another organization.
  `GET /me/tenants` — every organization of the caller with its state. `GET|PATCH /tenant` — current tenant (slug is immutable).
- Super admin (platform host only): `GET /platform/tenants`, `GET /platform/tenants/:id`,
  `POST /platform/tenants/:id/{approve,reject,suspend,reactivate}`, `GET|PATCH /platform/settings`.
- Removed from tenant admins (identity is global): `PATCH /admin/users/:id`, `POST /admin/users/:id/restore`,
  the `deleted` list filter. `PATCH /admin/users/:id/status` now suspends the *membership* (`ACTIVE|SUSPENDED`); admin
  member responses add `membershipStatus`. Sessions endpoints are scoped to the current tenant.

Error codes the clients act on: `TENANT_NOT_FOUND` (404), `TENANT_MISMATCH`, `PLATFORM_HOST_REQUIRED`,
`TENANT_PENDING_APPROVAL`, `TENANT_REJECTED` (+`reason`), `TENANT_SUSPENDED`, `MEMBERSHIP_SUSPENDED`, `NOT_A_MEMBER`,
`NO_ORGANIZATION` (all 403; the first four state errors also carry `tenants[]`), `TENANT_SLUG_TAKEN` (409),
`TENANT_SLUG_RESERVED` (400), `TENANT_LIMIT_REACHED` (403), `TENANT_DETAILS_REQUIRED` (400), `SOLE_OWNER` /
`LAST_OWNER` / `ALREADY_A_MEMBER` / `INVALID_TENANT_TRANSITION` (409/400).

Personal details live in the `user_profiles` table and are nested under
`profile` both on the way out and on `PATCH /users/me`. Flat `dateOfBirth` or
`gender` is a 400.

`toPublicUser` is the only way a `User` reaches a client, and it drops every
secret. It adds `hasPassword`, so a client can offer set-password to Google-only
accounts instead of change-password.

`/users/me` alone returns `permissions[]` and `maxRank` via `toCurrentUser` —
they describe the *requester*, so never attach them to another user's record.

`GET /auth/sessions` marks the caller's own row with `isCurrent`, derived from
the `sessionId` claim (the refresh-token family id) on their access token. That
claim is absent on tokens issued before it existed, in which case no row is
marked.

Errors are `{statusCode, code, message}`; `AllExceptionsFilter` passes through
any extra field the thrown exception attached, so a `code` can carry context the
client acts on (e.g. `ACCOUNT_PENDING_DELETION` carries `graceEndsAt`). `details`
stays reserved for `VALIDATION_ERROR`'s per-field issues.

Admin surfaces are web-only by design. The Expo app deliberately has no admin
screens — do not "fix" that.
