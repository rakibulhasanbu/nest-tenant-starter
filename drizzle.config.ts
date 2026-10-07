import "dotenv/config";
import { defineConfig } from "drizzle-kit";

export default defineConfig({
    dialect: "postgresql",
    schema: "./src/database/schema",
    out: "./src/database/migrations",
    dbCredentials: {
        // Migrations need the table-owner role; the app itself runs as the restricted app_user.
        url: (process.env.DATABASE_ADMIN_URL ?? process.env.DATABASE_URL)!,
    },
});
