import { z } from "zod";

const baseEnvSchema = z.object({
    NODE_ENV: z.enum(["development", "test", "production"]).default("development"),
    PORT: z.coerce.number().default(3000),
    APP_URL: z.url().default("http://localhost:3000"),

    DATABASE_URL: z.url(),
    REDIS_URL: z.url().default("redis://localhost:6379"),

    /**
     * Express's `trust proxy`. Leave unset when the app is exposed directly: the
     * rate limiter keys on `req.ip`, and trusting a forwarding header nobody
     * strips would let a client spoof its own address. Behind a load balancer the
     * opposite holds — without this every request carries the proxy's address, so
     * the whole deployment shares one rate-limit bucket and session IPs are noise.
     * Accepts `true`/`false`, a hop count ("1"), or an Express subnet expression
     * ("loopback", "10.0.0.0/8").
     */
    TRUST_PROXY: z
        .string()
        .optional()
        .transform(value => {
            const trimmed = value?.trim();

            if (!trimmed) {
                return undefined;
            }
            if (trimmed === "true" || trimmed === "false") {
                return trimmed === "true";
            }

            return /^\d+$/.test(trimmed) ? Number(trimmed) : trimmed;
        }),

    CORS_ORIGINS: z
        .string()
        .optional()
        .transform(value =>
            value
                ? value
                      .split(",")
                      .map(origin => origin.trim())
                      .filter(Boolean)
                : undefined,
        )
        .pipe(z.array(z.url()).optional()),

    JWT_ACCESS_SECRET: z.string().min(32),
    JWT_ACCESS_TTL: z.string().default("15m"),
    JWT_REFRESH_TTL: z.string().default("30d"),

    EMAIL_VERIFICATION_TTL_MINUTES: z.coerce.number().default(5),
    PASSWORD_RESET_TTL_MINUTES: z.coerce.number().default(5),
    DELETE_ACCOUNT_OTP_TTL_MINUTES: z.coerce.number().default(5),
    REACTIVATE_ACCOUNT_OTP_TTL_MINUTES: z.coerce.number().default(5),

    LOGIN_MAX_ATTEMPTS: z.coerce.number().default(5),
    LOGIN_LOCKOUT_MINUTES: z.coerce.number().default(15),

    DELETED_USER_GRACE_DAYS: z.coerce.number().default(15),

    GOOGLE_CLIENT_ID: z.string().min(1),

    TWO_FACTOR_APP_NAME: z.string().min(1).default("Nest Starter"),
    /**
     * Length alone was not enough: `Buffer.from(key, "hex")` silently yields zero
     * bytes for a 64-character string that is not hex, so a typo passed validation
     * at boot and only surfaced as a crash when the first user enabled 2FA.
     */
    TWO_FACTOR_ENCRYPTION_KEY: z
        .string()
        .regex(/^[0-9a-fA-F]{64}$/, "TWO_FACTOR_ENCRYPTION_KEY must be 64 hex characters (a 32-byte key)"),
    TWO_FACTOR_LOGIN_TTL: z.string().default("5m"),

    /** How long a resolved permission set may live in this process's memory before it is re-read. */
    PERM_CACHE_L1_TTL_MS: z.coerce.number().default(30_000),
    /** How long a resolved permission set may live in Redis. Acts as a self-healing ceiling on stale data. */
    PERM_CACHE_L2_TTL_SECONDS: z.coerce.number().default(300),
    /** Upper bound on L1 entries, so the in-memory cache cannot grow without limit. */
    PERM_CACHE_L1_MAX_ENTRIES: z.coerce.number().default(10_000),

    ADMIN_EMAIL: z.email(),
    ADMIN_PASSWORD: z.string().min(8),
});

export const envSchema = baseEnvSchema.superRefine((data, ctx) => {
    if (data.NODE_ENV === "production" && (!data.CORS_ORIGINS || data.CORS_ORIGINS.length === 0)) {
        ctx.addIssue({
            code: "custom",
            path: ["CORS_ORIGINS"],
            message: "CORS_ORIGINS is required in production",
        });
    }
});

export type Env = z.infer<typeof envSchema>;

export function validateEnv(config: Record<string, unknown>): Env {
    return envSchema.parse(config);
}
