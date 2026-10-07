import "dotenv/config";
import { Client } from "pg";
import { envSchema } from "@/config/env.schema.js";

/**
 * Creates the restricted role the application runs as. Row-level security only
 * binds roles that are neither superusers nor the table owner, so the app must
 * NOT connect as the migration owner — this is what makes RLS real rather than
 * decorative. Credentials come from DATABASE_URL; the owner connection from
 * DATABASE_ADMIN_URL. Safe to re-run: grants are idempotent and the password is
 * re-synced to whatever DATABASE_URL says.
 */
async function main() {
    const env = envSchema.parse(process.env);
    const app = new URL(env.DATABASE_URL);
    const role = decodeURIComponent(app.username);
    const password = decodeURIComponent(app.password);

    if (!env.DATABASE_ADMIN_URL) {
        throw new Error("DATABASE_ADMIN_URL is required to create the application role");
    }
    if (!/^[a-z_][a-z0-9_]*$/.test(role)) {
        throw new Error(`Unsafe database role name "${role}"`);
    }

    const admin = new Client({ connectionString: env.DATABASE_ADMIN_URL });
    await admin.connect();

    try {
        const database = (await admin.query<{ db: string }>("select current_database() as db")).rows[0]!.db;
        const quotedRole = `"${role}"`;
        const quotedDb = `"${database.replace(/"/g, '""')}"`;
        const literalPassword = `'${password.replace(/'/g, "''")}'`;

        const exists = await admin.query("select 1 from pg_roles where rolname = $1", [role]);
        const attributes = "LOGIN NOSUPERUSER NOCREATEDB NOCREATEROLE NOBYPASSRLS";

        await admin.query(
            exists.rowCount
                ? `ALTER ROLE ${quotedRole} WITH ${attributes} PASSWORD ${literalPassword}`
                : `CREATE ROLE ${quotedRole} WITH ${attributes} PASSWORD ${literalPassword}`,
        );
        await admin.query(`GRANT CONNECT ON DATABASE ${quotedDb} TO ${quotedRole}`);
        await admin.query(`GRANT USAGE ON SCHEMA public TO ${quotedRole}`);
        await admin.query(`GRANT SELECT, INSERT, UPDATE, DELETE ON ALL TABLES IN SCHEMA public TO ${quotedRole}`);
        await admin.query(`GRANT USAGE, SELECT ON ALL SEQUENCES IN SCHEMA public TO ${quotedRole}`);
        await admin.query(
            `ALTER DEFAULT PRIVILEGES IN SCHEMA public GRANT SELECT, INSERT, UPDATE, DELETE ON TABLES TO ${quotedRole}`,
        );
        await admin.query(
            `ALTER DEFAULT PRIVILEGES IN SCHEMA public GRANT USAGE, SELECT ON SEQUENCES TO ${quotedRole}`,
        );

        console.log(`Application role ready: ${role} (no superuser, no BYPASSRLS) on ${database}`);
    } finally {
        await admin.end();
    }
}

main().catch(error => {
    console.error(error);
    process.exit(1);
});
