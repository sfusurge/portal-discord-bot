import axios, { AxiosError, AxiosRequestConfig } from 'axios';
import { env } from '../config/env.js';
import { logger } from '../config/logger.js';
import { sleep } from '../utils/sleep.js';
import {
    PortalAnnouncementDeletePayload,
    PortalAnnouncementDeleteResponse,
    PortalAnnouncementPayload,
    PortalAnnouncementResponse,
    portalAnnouncementDeletePayloadSchema,
    portalAnnouncementDeleteResponseSchema,
    portalAnnouncementPayloadSchema,
    portalAnnouncementResponseSchema,
} from '../types/portal.js';

function isRetryableStatus(statusCode?: number): boolean {
    return typeof statusCode === 'undefined' || statusCode === 429 || statusCode >= 500;
}

function getRetryDelayMs(attempt: number): number {
    const exponentialDelay = env.PORTAL_RETRY_BASE_DELAY_MS * 2 ** (attempt - 1);
    const cappedDelay = Math.min(exponentialDelay, env.PORTAL_RETRY_MAX_DELAY_MS);
    const jitter = Math.floor(Math.random() * Math.max(1, cappedDelay * 0.2));

    return cappedDelay + jitter;
}

export class PortalClient {
    constructor(private readonly dryRun = false) { }

    private async executeWithRetry<T>(options: {
        operation: string;
        messageId: string;
        idempotencyKey: string;
        dryRunLogFields: Record<string, unknown>;
        request: () => Promise<{ data: unknown }>;
        parse: (data: unknown) => T;
    }): Promise<T | null> {
        const {
            operation,
            messageId,
            idempotencyKey,
            dryRunLogFields,
            request,
            parse,
        } = options;

        if (this.dryRun) {
            logger.info(
                {
                    operation,
                    messageId,
                    idempotencyKey,
                    ...dryRunLogFields,
                },
                'Dry run enabled: skipping portal API call'
            );
            return null;
        }

        const maxAttempts = env.PORTAL_MAX_RETRIES + 1;

        for (let attempt = 1; attempt <= maxAttempts; attempt++) {
            try {
                const response = await request();
                return parse(response.data);
            } catch (error) {
                if (!axios.isAxiosError(error)) {
                    logger.error(
                        {
                            attempt,
                            operation,
                            messageId,
                            err: error,
                        },
                        'Portal API request failed with non-HTTP error'
                    );
                    throw error;
                }

                const axiosError = error as AxiosError;
                const status = axiosError.response?.status;
                const retryable = isRetryableStatus(status);

                if (!retryable || attempt === maxAttempts) {
                    logger.error(
                        {
                            attempt,
                            operation,
                            status,
                            messageId,
                            responseData: axiosError.response?.data,
                            err: error,
                        },
                        'Portal API request failed permanently'
                    );
                    throw error;
                }

                const delay = getRetryDelayMs(attempt);

                logger.warn(
                    {
                        attempt,
                        operation,
                        status,
                        delay,
                        messageId,
                    },
                    'Portal API request failed, retrying'
                );

                await sleep(delay);
            }
        }

        return null;
    }

    async sendAnnouncement(
        payload: PortalAnnouncementPayload
    ): Promise<PortalAnnouncementResponse | null> {
        const validatedPayload = portalAnnouncementPayloadSchema.parse(payload);

        const config: AxiosRequestConfig = {
            method: 'POST',
            url: env.PORTAL_API_URL,
            data: validatedPayload,
            headers: {
                Authorization: `Bearer ${env.PORTAL_API_SECRET}`,
                'Content-Type': 'application/json',
                'X-Idempotency-Key': validatedPayload.idempotencyKey,
            },
            timeout: env.PORTAL_API_TIMEOUT_MS,
        };

        return this.executeWithRetry({
            operation: 'announcement_upsert',
            messageId: validatedPayload.messageId,
            idempotencyKey: validatedPayload.idempotencyKey,
            dryRunLogFields: {
                channelId: validatedPayload.channelId,
            },
            request: () => axios.request<unknown>(config),
            parse: (data) => portalAnnouncementResponseSchema.parse(data),
        });
    }

    async deleteAnnouncement(
        payload: PortalAnnouncementDeletePayload
    ): Promise<PortalAnnouncementDeleteResponse | null> {
        const validatedPayload =
            portalAnnouncementDeletePayloadSchema.parse(payload);
        const idempotencyKey = `delete:${validatedPayload.messageId}`;

        const config: AxiosRequestConfig = {
            method: 'DELETE',
            url: env.PORTAL_API_URL,
            data: validatedPayload,
            headers: {
                Authorization: `Bearer ${env.PORTAL_API_SECRET}`,
                'Content-Type': 'application/json',
                'X-Idempotency-Key': idempotencyKey,
            },
            timeout: env.PORTAL_API_TIMEOUT_MS,
        };

        return this.executeWithRetry({
            operation: 'announcement_delete',
            messageId: validatedPayload.messageId,
            idempotencyKey,
            dryRunLogFields: {
                channelId: validatedPayload.channelId,
                guildId: validatedPayload.guildId,
            },
            request: () => axios.request<unknown>(config),
            parse: (data) => portalAnnouncementDeleteResponseSchema.parse(data),
        });
    }
}
