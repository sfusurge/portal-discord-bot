import dotenv from 'dotenv';
import { z } from 'zod';

dotenv.config();

const commaSeparatedIdsSchema = z
    .string()
    .min(1, 'DISCORD_WATCH_CHANNEL_IDS is required')
    .transform((value) =>
        value
            .split(',')
            .map((id) => id.trim())
            .filter(Boolean)
    )
    .refine((ids) => ids.length > 0, {
        message: 'Provide at least one channel ID in DISCORD_WATCH_CHANNEL_IDS',
    });

const EnvSchema = z.object({
    DISCORD_BOT_TOKEN: z.string().trim().min(1),
    DISCORD_WATCH_CHANNEL_IDS: commaSeparatedIdsSchema,
    PORTAL_API_URL: z.url(),
    PORTAL_API_SECRET: z.string().trim().min(1),
    PORTAL_API_TIMEOUT_MS: z.coerce
        .number()
        .int()
        .min(500)
        .max(60_000)
        .default(10_000),
    PORTAL_MAX_RETRIES: z.coerce.number().int().min(0).max(10).default(5),
    PORTAL_RETRY_BASE_DELAY_MS: z.coerce
        .number()
        .int()
        .positive()
        .max(30_000)
        .default(500),
    PORTAL_RETRY_MAX_DELAY_MS: z.coerce
        .number()
        .int()
        .positive()
        .max(60_000)
        .default(10_000),
    LOG_LEVEL: z
        .enum(['trace', 'debug', 'info', 'warn', 'error', 'fatal'])
        .default('info'),
});

const parsed = EnvSchema.safeParse(process.env);

if (!parsed.success) {
    const issues = parsed.error.issues
        .map((issue) => `${issue.path.join('.')}: ${issue.message}`)
        .join('; ');
    throw new Error(`Invalid environment variables: ${issues}`);
}

const envData = parsed.data;

export const env = Object.freeze({
    ...envData,
    DISCORD_WATCH_CHANNEL_SET: new Set(envData.DISCORD_WATCH_CHANNEL_IDS),
});
