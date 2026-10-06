#!/bin/bash
# Prepares a Claude Code on the web session: local Postgres + Redis, .env,
# dependencies, migrations and seed data. Local machines use docker-compose.
set -euo pipefail

if [ "${CLAUDE_CODE_REMOTE:-}" != "true" ]; then
  exit 0
fi

cd "$CLAUDE_PROJECT_DIR"

# .env — copy the example once; never overwrite a developer's file.
if [ ! -f .env ]; then
  cp .env.example .env
  # Throwaway key so 2FA encryption works in tests; the example value is all zeros.
  sed -i "s/^TWO_FACTOR_ENCRYPTION_KEY=.*/TWO_FACTOR_ENCRYPTION_KEY=$(openssl rand -hex 32)/" .env
  sed -i "s/^JWT_ACCESS_SECRET=.*/JWT_ACCESS_SECRET=$(openssl rand -hex 32)/" .env
fi

# Postgres — match the credentials in .env.example / docker-compose.yml.
service postgresql start >/dev/null
until pg_isready -q -h localhost -p 5432; do sleep 1; done
su postgres -c "psql -q -c \"ALTER USER postgres PASSWORD 'postgres';\""
if ! su postgres -c "psql -tAc \"SELECT 1 FROM pg_database WHERE datname='nest_starter'\"" | grep -q 1; then
  su postgres -c "createdb nest_starter"
fi

# Redis
if ! redis-cli ping >/dev/null 2>&1; then
  redis-server --daemonize yes >/dev/null
  until redis-cli ping >/dev/null 2>&1; do sleep 1; done
fi

# Dependencies
pnpm install

# Schema + seed data (seed is upsert-based, safe to re-run)
pnpm db:push --force
pnpm db:seed
