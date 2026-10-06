import { timestamp } from "drizzle-orm/pg-core";

/** Every timestamp is `timestamptz`, so values round-trip as the same instant regardless of server timezone. */
export const timestamptz = (name: string) => timestamp(name, { withTimezone: true, mode: "date" });

export const createdAtColumn = () => timestamptz("created_at").notNull().defaultNow();

export const updatedAtColumn = () =>
    timestamptz("updated_at")
        .notNull()
        .defaultNow()
        .$onUpdate(() => new Date());
