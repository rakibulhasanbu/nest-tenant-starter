# Template init prompt

Paste this whole file into Claude Code after cloning the template. Fill the **Values** block first.
Delete this file when done (last step).

## Values (fill these)

```
PROJECT_NAME=          # human name, e.g. "Acme Billing"
PROJECT_SLUG=          # kebab-case, e.g. acme-billing  -> package.json name, docker container prefix
DB_NAME=               # snake_case, e.g. acme_billing   (never hyphens)
APP_ROOT_DOMAIN=       # e.g. acmebilling.com  (dev stays "localhost")
PLATFORM_SUBDOMAIN=    # default admin
ADMIN_EMAIL=           # super admin seed email
MAIL_FROM / 2FA app name=  # defaults to PROJECT_NAME
WEB_REPO_PATH=         # absolute path of the web (Next.js) repo for this project
MOBILE_REPO_PATH=      # absolute path, or "none"
PROJECT_DESCRIPTION=   # 1-2 lines: what the product is, who the tenants are
KEEP_MODULES=          # modules to keep/remove, or "all"
```

## Task

Convert this template into the project described by **Values**. Do the steps in order. Be extremely concise in reports.

1. **Read first:** `AGENTS.md`, `context/architecture.md`, `.env.example`, `docker-compose.yml`, `package.json`, `.claude/hooks/session-start.sh`. Do not change architecture rules.
2. **Find template values** (exclude `node_modules`, `dist`, `.git`, `pnpm-lock.yaml`):
   `grep -rIn -iE "nest[-_]starter|nest[-_]tenant[-_]starter|Nest Tenant Starter|nextjs-(tenant-)?starter|expo-starter|admin@example.com|example\.com"`
   Show the hit list before editing.
3. **Mechanical replacements**
   - `package.json` `name` -> PROJECT_SLUG; fill `description`.
   - DB name `nest_tenant_starter` -> DB_NAME in: `docker-compose.yml` (`POSTGRES_DB`), `.env.example`, `.env`, `.claude/hooks/session-start.sh`, `README.md`, `context/*`.
   - Containers `nest_starter_postgres` / `nest_starter_redis` -> `<DB_NAME>_postgres` / `<DB_NAME>_redis`.
   - `.env.example` + `.env`: `TWO_FACTOR_APP_NAME`, `ADMIN_EMAIL`, `APP_ROOT_DOMAIN`, `PLATFORM_SUBDOMAIN`, `TENANT_URL_TEMPLATE` example, mail-from values.
   - Do NOT touch `acme`/`globex`/`example.com` inside `*.spec.ts` and `test/` fixtures (generic test data).
   - Generate fresh random values for every secret in `.env` (`JWT_*`, cookie/encryption keys, `app_user` password). Never commit `.env`.
4. **AGENTS.md**: rewrite the web repo line to WEB_REPO_PATH (add MOBILE_REPO_PATH if any). Keep `follow context/architecture.md` and the concise-reporting rule. Add a short "Project" section from PROJECT_DESCRIPTION. Keep it minimal.
5. **context/**
   - `architecture.md`: update only project-specific facts (name, domain, web/mobile paths, removed modules). Keep conventions.
   - `multi-tenant-plan.md`: it is a historical plan. Either delete it or trim to a short "decisions" note, and update the stale web/mobile paths. Ask me which.
6. **README.md**: replace the stock Nest README header/badges with a short project README: name, description, setup (`pnpm install`, `docker compose up -d`, `pnpm db:setup`, `pnpm start:dev`), env notes.
7. **Modules**: if KEEP_MODULES is not "all", remove the unused modules, their imports in `app.module.ts`, schema/migrations, tests and docs. Ask before deleting anything with data or migrations.
8. **Fresh DB**: if DB_NAME changed, drop stale migration state only if I confirm; run `pnpm db:setup`.
9. **Verify**: `pnpm build && pnpm lint && pnpm test` (and `pnpm test:e2e` if DB is up). Re-run the step 2 grep: expect zero template leftovers outside spec fixtures.
10. **Git**: re-init remote (`git remote -v` -> ask me for the new URL). Do not push. Delete `TEMPLATE_INIT.md`. Show a summary of changed files; do not commit unless I say so.

## Rules

- Ask only when a value is missing or a step is destructive.
- Never print secrets in output.
- Report: changed files list + verify result. Nothing else.
