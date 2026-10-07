# Multi-Tenant Plan

Goal: convert this **currently single-tenant** NestJS starter (no tenant concept anywhere) into a multi-tenant SaaS backend. Stay a **modular monolith** now; keep boundaries clean so modules can become microservices later without a rewrite.

## 0. Decisions already made by the owner

1. Signup creates a **new tenant**. A platform setting `requireTenantApproval` (toggled by the super admin) decides whether the tenant is active immediately or waits (`PENDING_APPROVAL`) for super admin approval.
2. **Subdomain per tenant is implemented now** (`acme.example.com`), properly (resolution, binding, CORS, dev, TLS).
3. **Exactly one platform staff account: the super admin.** No other platform roles.

## 1. Where the repo is today (what blocks multi-tenancy)

| Area | Today | Problem |
| --- | --- | --- |
| `users` | global, `email` + `username` unique | fine as *identity*; no link to any tenant |
| `roles` / `user_roles` | global; role id = slug (`admin`); `user_roles(userId, roleId)` | not tenant-scoped |
| `user_roles_single_super_admin` | one super admin via a role row | super admin must become a platform concept, outside tenant roles |
| `permissions` | global catalog | no tenant-vs-platform distinction |
| JWT (`TokensService`, `JwtStrategy`) | user id, email, `tokenVersion`, `permVersion`, `sessionId` | no `tenantId` claim |
| `PermissionsGuard` | principal by `userId`; `permVersion` on `users` | principal must be per `(userId, tenantId)`; `permVersion` per membership |
| `PermissionsCacheService` | key `perm:user:{userId}` | key must include tenant |
| `refresh_tokens` | per user | session must remember its tenant |
| `AdminUsersService` | manages all users; reads `roles` table directly | must manage only current tenant's members; breaks module boundary |
| Cleanup tasks | global cron | need a system context allowed across tenants |
| Drizzle `Database` | one pool, tenant-unaware | no place to enforce isolation |
| CORS (`cors.config.ts`) | static origin list | must allow `*.root-domain` safely |

## 2. Design

### D1. Shared database, shared schema, `tenant_id` column ("pool")
- Cheapest to run, one migration for all tenants, fits the current Drizzle/Postgres setup.
- Escape hatch: all DB access for tenant data goes through one seam (`TenantDb`, D5). Add `tenants.isolation` (`pool` | `silo`); only `pool` is implemented now. A large tenant can later get its own schema/DB by changing the connection resolver only.
- Rejected: DB-per-tenant now — costly, migrations x N, overkill.

### D2. Global identity, per-tenant access (membership)
- `users` stays global (one email = one person, may belong to many tenants).
- New `tenant_memberships (tenant_id, user_id, status, perm_version, joined_at)` grants access.
- Why: one login/2FA/Google link for many orgs, invite-by-email just adds a membership. Rejected "user per tenant": duplicates credentials and prevents switching orgs.
- `users.status` = platform-level state. `membership.status` = tenant-level (`ACTIVE | INVITED | SUSPENDED`). `permVersion` moves to the membership; `tokenVersion` stays on the user.

### D3. Tenant resolution: subdomain + signed token (both, and they must agree)
**Host parsing (new `TenantResolverMiddleware`, `src/common/tenant/`):**
- Env: `APP_ROOT_DOMAIN` (e.g. `example.com`), `PLATFORM_SUBDOMAIN` (e.g. `admin` → `admin.example.com` is the super admin console), `TRUST_PROXY` (already needed for `X-Forwarded-Host`).
- Host = `<slug>.<root>` → look up tenant by `slug` (cached in L1 + Redis, invalidated on tenant change). Host = root/`www` → "apex" (marketing/signup/tenant picker). Host = platform subdomain → platform context.
- Slugs: `^[a-z0-9](?:[a-z0-9-]{1,30}[a-z0-9])$`, plus a **reserved list** (`www api admin app static assets mail docs status help support ...`). Slug is unique, **immutable** after creation (rename = new redirect feature later), reserved from the moment of signup even while `PENDING_APPROVAL`.
- Unknown slug → 404 `TENANT_NOT_FOUND` (same response shape for every state, no enumeration of pending/rejected tenants beyond what the owner is told).

**Binding rules:**
- Public routes on a tenant subdomain (signin, forgot password, accept invite) operate on that tenant only. Signin on `acme.example.com` → credentials checked, then membership in `acme` required → token issued for `acme` directly (no tenant-picker step).
- Signin on the apex: credentials → list active memberships → one = token directly (client is told the tenant URL to redirect to); many = `{ tenantSelectionRequired, tenants[{slug,name,url}] }` → client redirects to the chosen subdomain and signs in there via a short-lived one-time exchange code (`POST /auth/exchange`), so no password is retyped and no token crosses origins in a URL.
- **Authenticated routes:** the token's `tenantId` claim is the authority, and the host's tenant **must equal** it, else 403 `TENANT_MISMATCH`. A token from `acme` is useless on `globex.example.com`, and a client-sent `X-Tenant` header is never trusted.
- `POST /auth/switch-tenant` only exists for the apex/platform host (issues a token for the target tenant after membership check); on a tenant subdomain the tenant is fixed by the host.

**Surrounding infra:**
- CORS: replace static list with a function: allow exact configured origins + `https://*.${APP_ROOT_DOMAIN}` only when the slug resolves to an existing non-rejected tenant. Never reflect arbitrary origins.
- Tokens are Bearer (no cookies), so no wildcard-cookie/CSRF scope issues. If cookies are introduced later, scope them per exact host.
- Local dev: `*.localhost` works in browsers with no DNS (`acme.localhost:3000`); `APP_ROOT_DOMAIN=localhost`.
- Production: wildcard DNS `*.example.com` + wildcard TLS cert (or per-tenant certs via the proxy). Custom domains are a later addition using a `tenant_domains(host unique, tenant_id)` table behind the same resolver — not built now.
- Web (`/run/media/rakibul/Dev/work/template/nextjs-starter`) derives the API tenant from its own host; mobile (`/run/media/rakibul/Dev/work/template/expo-starter`) asks for a tenant slug at login (no browser host) and sends it in the signin body.

### D4. Authorization: permission-based, per tenant; one platform super admin
- `roles.tenant_id NOT NULL`: **all roles belong to a tenant.** Template roles (`owner`, `admin`, `user` + permission sets) live in code (`src/common/authorization/role-templates.constant.ts`) and are copied into a tenant when it is created — keeps "roles are runtime rows with editable contents" per tenant. Role rank hierarchy applies within a tenant.
- Template roles per tenant: `owner` (rank 100, all tenant permissions, = "tenant admin", at least one required), `admin` (rank 50, manages members/settings, cannot touch owners), `user` (rank 0, baseline; every membership has it). There is **no global user/admin role**: a role only exists inside a tenant. Whoever signs up and creates a tenant becomes its `owner`; people they invite get `admin` or `user`. The super admin is outside this system (`platform_admins`).
- Role PK becomes surrogate `id` + `UNIQUE(tenant_id, slug)`. The API still returns/accepts `roleIds` as **slugs** (tenant is implicit from token+host), so the client contract in `architecture.md` is unchanged.
- **Super admin is not a role.** New table `platform_admins(user_id PK)` constrained to a single row (unique index on a constant expression). Its permissions are a fixed code constant (`PLATFORM_PERMISSIONS`), not editable rows. This replaces `user_roles_single_super_admin`.
- `permissions` get `level` = `tenant | platform`. Platform permissions are honored only in platform context.
- Platform context = token with `tenantId = null` + `platform: true`, valid only on the platform host. The super admin does not get implicit tenant access; entering a tenant is an explicit audited "impersonate/enter" action (Phase 6).
- Permission cache key → `perm:{tenantId}:{userId}` (platform: `perm:platform:{userId}`); invalidation carries the same key. The existing fail-closed `permVersion` design is unchanged, just read from the membership.
- Guard also checks `tenant.status` (cached with the principal): anything other than `ACTIVE` blocks all requests with a specific `code`.

### D5. Isolation enforced twice: app layer + Postgres RLS
- `TenantContext` (AsyncLocalStorage via `nestjs-cls`) holds `{ tenantId, userId, platform }` per request. (AsyncLocalStorage is Node's built-in per-request store, not Redis.)
- `TenantDb.run(fn)` opens a transaction, runs `select set_config('app.tenant_id', $1, true)`, passes `tx` to `fn`. Repositories use it and also filter/set `tenant_id` explicitly.
- RLS policy on every tenant-owned table: `USING/WITH CHECK (tenant_id = current_setting('app.tenant_id', true))`. A forgotten `WHERE` returns nothing instead of leaking.
- Connections: `app_user` (no BYPASSRLS, not table owner) for requests; `app_system` (BYPASSRLS) for cron, seed, platform endpoints and migrations owner separate.
- Global tables (no RLS): `users`, `user_profiles`, `notification_preferences`, `social_identities`, `email_tokens`, `permissions`, `tenants`, `platform_admins`, `platform_settings`. RLS tables: `tenant_memberships`, `roles`, `role_permissions`, `membership_roles`, and every future business table.

### D6. Signup, approval and tenant lifecycle
Tenant status: `PENDING_APPROVAL → ACTIVE | REJECTED`; `ACTIVE ↔ SUSPENDED`.

**Platform setting** (new `platform_settings` single-row table, super-admin editable, cached): `requireTenantApproval: boolean` (default `true`).

**Signup** (`POST /auth/signup` on the apex; body adds `tenantName`, `tenantSlug`):
1. Validate slug (format, reserved, unique).
2. One transaction: create user (or reuse if the email already exists and the caller proves the password later — existing-email signup is rejected as today), create tenant, copy template roles, create `OWNER` membership.
3. Tenant status = `ACTIVE` if `requireTenantApproval = false`, else `PENDING_APPROVAL`. The setting value is **snapshotted at signup time**; flipping it later does not retroactively approve or block existing pending tenants.
4. Email verification as today. After verification, signin returns:
   - `ACTIVE` → normal session.
   - `PENDING_APPROVAL` → 403 `TENANT_PENDING_APPROVAL` (client shows "waiting for approval"; no session issued for the tenant).
   - `REJECTED` → 403 `TENANT_REJECTED` (+ `reason`).
5. Event `tenant.created`; if pending, notify the super admin by email.

**Super admin endpoints** (platform host only, `platform:*` permissions):
- `GET /platform/tenants?status=&q=&page=&limit=` (paginated `{data, meta}`)
- `POST /platform/tenants/:id/approve` → ACTIVE, event `tenant.approved` → email owner with `https://<slug>.<root>`.
- `POST /platform/tenants/:id/reject` `{reason}`; `/suspend`; `/reactivate`.
- `GET|PATCH /platform/settings` (`requireTenantApproval`, `maxTenantsPerUser`).
- Every status change bumps a tenant version/cache invalidation so the guard reflects it immediately.

### D6b. One user, many tenants
A user is one global row; every tenant they own or join is one `tenant_memberships` row. Nothing on `users` is per-tenant.

- **First tenant:** `POST /auth/signup` (new email) creates user + tenant + `owner` membership.
- **Additional tenants:** an already-signed-in user calls `POST /tenants` `{ name, slug }` on the apex/platform-free host. It creates a new tenant + template roles + `owner` membership for the same `userId`. No new account, password, or email verification. Signup with an email that already exists stays a 409 — the client shows "sign in, then create an organization".
- The same approval rule applies to each new tenant (pending or active per the setting at that moment).
- **Abuse guard:** `platform_settings.max_tenants_per_user` (default 5, super-admin editable) counts tenants where the user has the `owner` role.
- **Joining others' tenants:** invites add a membership with that tenant's roles; the same user can be `owner` in one tenant and `user` in another.
- **Sessions:** a token is always for one tenant (`tenantId` claim). Each subdomain is a separate origin with its own stored token, so going from `acme` to `globex` uses the apex picker + one-time `exchange` code (no password retype). A user's tenant list (with status per tenant: active / pending approval / rejected / suspended) comes from `GET /me/tenants`; only `ACTIVE` ones are selectable.
- **Global vs per-tenant:** email, password, 2FA, Google link, profile = global (change once, applies everywhere). Roles, permissions, membership status, suspension by a tenant admin = per tenant. Suspending a membership never touches the user's other tenants; only the platform can suspend the user globally.
- **Last-owner rule:** a tenant must always keep at least one `owner`; the last owner cannot leave, be removed, or delete their account until ownership is transferred (account deletion is blocked while the user is sole owner of any tenant).

### D7. Modular monolith with hard boundaries (microservice-ready)
- Each module owns its tables and exposes only a service/port. No cross-module imports of `@/database/schema/*` tables.
  - Existing violation to fix: `AdminUsersService` reads `roles` directly → go through `AuthorizationModule`.
- Cross-module refs are IDs only (`tenantId`, `userId`); no cross-module FKs into business tables.
- Sync calls via injected interfaces (DI tokens) so they can become HTTP/gRPC clients; async effects via domain events (`@nestjs/event-emitter` now → Redis/NATS/Kafka later): `tenant.created`, `tenant.approved`, `tenant.rejected`, `tenant.suspended`, `membership.added`, `membership.removed`.
- New modules: `tenants` (lifecycle, settings, resolver data), `platform` (super admin controllers), `memberships` (invites/members). Existing: `auth` (identity/sessions), `authorization`, `users`.
- Extraction order when needed: notification/email → billing → tenants+authorization → rest; identity last.

### D8. Tenant-aware infrastructure
- Redis keys for tenant data prefixed `t:{tenantId}:`. Throttler key = `tenantId + user/ip`.
- Job payloads carry `tenantId`; workers re-enter `TenantContext`.
- Logs always include `tenantId` + `userId` (CLS).
- Audit log (`audit_logs`) before platform "enter tenant" ships.

## 3. Target schema (summary)

```
tenants              id, slug UNIQUE (immutable), name, status, rejection_reason, isolation, created_by, approved_by/at, timestamps
platform_settings    id (single row), require_tenant_approval, max_tenants_per_user, updated_by, updated_at
platform_admins      user_id PK   -- single-row constraint
tenant_memberships   tenant_id, user_id, status, perm_version, joined_at     PK(tenant_id,user_id)
roles                id (uuid), tenant_id NOT NULL, slug, name, rank, is_system, ...   UNIQUE(tenant_id, slug)
role_permissions     role_id (uuid), permission_key
membership_roles     tenant_id, user_id, role_id, assigned_at, assigned_by           (replaces user_roles)
permissions          + level (tenant|platform)
refresh_tokens       + tenant_id (null = platform session)
users                - perm_version (moved), keeps token_version
```

## 4. Fresh database (no backfill, no data migration)

This is a new start: **no existing data is migrated.** The repo has no committed Drizzle migrations yet, so the schema is written directly in its final multi-tenant shape and a single fresh baseline migration is generated (`pnpm db:generate`).

- New database name: `nest_tenant_starter` (underscores, because a hyphenated name like `nest-tenant-starter` must be quoted in every SQL statement and tool). Change in `docker-compose.yml` (`POSTGRES_DB`), `.env.example` (`DATABASE_URL`) and `.claude/hooks/session-start.sh`.
- Remove outright (not deprecate): `user_roles`, `users.perm_version`, the `user_roles_single_super_admin` index, slug-as-primary-key on `roles`.
- Seed (`src/database/seed.ts`, rewritten) creates: permission catalog, the single `platform_admins` row (super admin user from env), the `platform_settings` row (`require_tenant_approval = true`). A demo tenant (owner + template roles) is optional behind a flag for local dev.
- RLS roles/policies (`app_user`, `app_system`) are part of the baseline migration from the start (Phase 6 wires `TenantDb`), so no later retrofit is needed.

## 5. Implementation phases

Each phase ends green (`pnpm lint`, `pnpm test`, `pnpm test:e2e`) and is its own commit.

- **Phase 0 — Docs/deps:** `architecture.md` rules (done); add `nestjs-cls`, `@nestjs/event-emitter`; env vars `APP_ROOT_DOMAIN`, `PLATFORM_SUBDOMAIN`, `TRUST_PROXY`, `SUPER_ADMIN_EMAIL`, `SUPER_ADMIN_PASSWORD` (seed only) in `env.schema.ts` + `.env.example`.
- **Phase 1 — Tenant core + fresh DB:** rename DB to `nest_tenant_starter`, write final schema, baseline migration, `tenants` module, `TenantContext`, role templates constant, seed rewrite.
- **Phase 2 — Subdomain resolver:** middleware, reserved slugs, tenant cache, dynamic CORS, `TENANT_NOT_FOUND`/`TENANT_MISMATCH`, dev setup docs.
- **Phase 3 — Per-tenant authorization:** `PermissionsService.resolve(userId, tenantId)`, cache key, guard (`tenantId` claim, host match, tenant/membership status), platform context + `platform_admins`, fix `AdminUsersService` boundary.
- **Phase 4 — Auth flows:** `tenantId` claim, `refresh_tokens.tenant_id`, signup-creates-tenant with approval snapshot, `POST /tenants` (extra tenants for a signed-in user) + `GET /me/tenants`, last-owner rule, signin on subdomain/apex, tenant picker + `exchange` code, `switch-tenant` (apex only), invites create memberships, tenant-scoped admin users/roles. Update `architecture.md` API contract (new endpoints, error codes: `TENANT_NOT_FOUND`, `TENANT_MISMATCH`, `TENANT_PENDING_APPROVAL`, `TENANT_REJECTED`, `TENANT_SUSPENDED`). **Web and mobile repos must change in lockstep.**
- **Phase 5 — Platform console API:** `/platform/tenants` (list/approve/reject/suspend/reactivate), `/platform/settings`, approval emails/events.
- **Phase 6 — RLS hardening:** `app_user`/`app_system`, `TenantDb`, policies on all tenant tables, cron/seed on system connection, per-tenant throttling/log context, audit log + "enter tenant".
- **Phase 7 — Microservice-readiness checks:** import-boundary lint rule (no cross-module schema imports), events/ports review, extraction runbook.

## 6. Testing (required)
- Two tenants A/B e2e: every tenant-scoped endpoint returns 404/empty for B's data with A's token; token of A on B's subdomain → 403 `TENANT_MISMATCH`.
- RLS test via raw `app_user` connection with `app.tenant_id = A` returns zero B rows **without** app-level `WHERE`.
- Approval flow: setting ON → signup pending → signin 403 → approve → signin OK; setting OFF → immediately ACTIVE; flipping the setting does not change existing pending tenants; reject path; suspend blocks live tokens immediately.
- Guard: no membership → 401; suspended tenant/membership → 401.
- Permission cache: same user in two tenants never shares a principal.
- One user, many tenants: owner in A and member in B have independent roles/permissions; `maxTenantsPerUser` enforced; last owner cannot leave; suspending a membership in A does not affect B.
- Subdomain: reserved/invalid slug rejected, unknown host 404, CORS allows only resolved tenants.

## 7. Implementation status (all phases delivered)

Phases 0–7 are implemented on the fresh database `nest_tenant_starter`; verified by 53 unit tests and 49 e2e tests (`pnpm test`, `pnpm test:e2e`). Where the code differs from the plan above, **the code and `architecture.md` win**:

| Plan said | What was built |
| --- | --- |
| `nestjs-cls` for the request store | Plain `AsyncLocalStorage` in `src/common/tenant/tenant-context.ts` (no dependency). |
| `TenantDb.run(fn)` helper that opens a transaction and sets `app.tenant_id` | `TenantAwarePool` (`src/database/tenant-aware-pool.ts`) stamps **every** connection checkout from the request's tenant, so no query can skip it. `TenantContext.runAs / runAsSystem` for explicit scopes. |
| Env `SUPER_ADMIN_EMAIL/PASSWORD` | Existing `ADMIN_EMAIL/ADMIN_PASSWORD` kept (also the address that receives "pending approval" notices). |
| Membership statuses `ACTIVE\|INVITED\|SUSPENDED` | `ACTIVE\|SUSPENDED` only — an invite adds an ACTIVE membership (new address gets an account + reset-code email; existing account is simply added). |
| Platform "enter tenant" with audit log | Deferred: nothing in the API lets the super admin act inside a tenant yet, so there is nothing to audit. Add `audit_logs` together with that feature. |
| Per-tenant throttling, tenant-prefixed log context | Not done (throttling is still per IP). Redis permission keys are tenant-scoped. |
| Import-boundary lint rule | Rules are documented in `architecture.md` and followed; no automated lint rule yet. |
| `permissions.level` | Done, plus `PLATFORM_PERMISSIONS` constant and platform keys. |
| Role contract unchanged | `roleIds` stay slugs. `PATCH /admin/users/:id` and `POST /admin/users/:id/restore` were **removed** for tenant admins (identity is global); membership status replaces account status in admin routes. See `architecture.md` → "Multi-tenant API additions". |

Beyond the plan: exchange/refresh codes are host-checked **before** being spent (a misrouted request cannot burn a session); tenant-state errors carry the user's full `tenants[]` list; seed keeps every tenant's `owner` role in sync with the permission catalog; `pnpm db:setup` = migrate + create `app_user` + seed.

### Operating notes
- First run: `createdb nest_tenant_starter && pnpm db:setup` (and `pnpm db:seed -- --demo` for a local tenant). Run the app with `pnpm start`/`start:dev` or `pnpm build && node dist/main` — `tsx src/main.ts` does not emit decorator metadata and fails DI.
- `DATABASE_URL` must be the restricted `app_user`; if it is the owner/superuser, RLS silently stops applying (the app layer still filters by tenant, but the safety net is gone).
- Tenant lookups are cached per instance (`TENANT_CACHE_TTL_MS`, default 15s) and invalidated cluster-wide over Redis; tests set it to 0.
- Web and mobile clients must adopt the contract in `architecture.md` before this backend replaces the single-tenant one.
