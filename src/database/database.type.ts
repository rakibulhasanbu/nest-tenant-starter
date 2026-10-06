import type { NodePgDatabase } from "drizzle-orm/node-postgres";
import type { Relations } from "@/database/schema/relations.js";

/** What `@InjectDrizzle()` hands to a service. */
export type Database = NodePgDatabase<Relations>;

/** The `tx` a `db.transaction()` callback receives. */
export type Transaction = Parameters<Parameters<Database["transaction"]>[0]>[0];

/** Anything that can run a query, so a helper works both inside and outside a transaction. */
export type DbClient = Database | Transaction;
