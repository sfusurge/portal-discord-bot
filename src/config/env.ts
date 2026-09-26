import dotenv from 'dotenv';
import { z } from 'zod';
import { isValidTimeZone } from '../schedule/time.js';

dotenv.config();

const commaSeparatedIdsSchema = z
    .string()
    .optional()
    .transform((value) =>
        (value ?? '')
            .split(',')
            .map((id) => id.trim())
            .filter(Boolean)
    );

const EnvSchema = z.object({
    DISCORD_BOT_TOKEN: z.string().trim().min(1),
    DISCORD_WATCH_CHANNEL_IDS: commaSeparatedIdsSchema.default([]),
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
    DISCORD_GUILD_ID: z.string().optional(),
    SCHEDULE_EXEC_CHANNEL_ID: z.string().optional(),
    SCHEDULE_TIMEZONE: z
        .string()
        .trim()
        .min(1)
        .default('America/Los_Angeles')
        .refine((zone) => isValidTimeZone(zone), {
            message: 'must be a valid IANA time zone',
        }),
    SCHEDULE_STORE_PATH: z
        .string()
        .trim()
        .min(1)
        .default('data/scheduled-announcements.json'),
});

const parsed = EnvSchema.safeParse(process.env);

if (!parsed.success) {
    const issues = parsed.error.issues
        .map((issue) => `${issue.path.join('.')}: ${issue.message}`)
        .join('; ');
    throw new Error(`Invalid environment variables: ${issues}`);
}

const envData = parsed.data;

function snowflakeOrNull(value: string | undefined): string | null {
    const trimmed = value?.trim() ?? '';
    if (!/^\d{17,20}$/.test(trimmed)) {
        return null;
    }
    return trimmed;
}

export const env = Object.freeze({
    ...envData,
    DISCORD_GUILD_ID: snowflakeOrNull(envData.DISCORD_GUILD_ID),
    SCHEDULE_EXEC_CHANNEL_ID: snowflakeOrNull(envData.SCHEDULE_EXEC_CHANNEL_ID),
    DISCORD_WATCH_CHANNEL_SET: new Set(envData.DISCORD_WATCH_CHANNEL_IDS),
});
