import axios, { AxiosError } from 'axios';
import { env } from '../config/env.js';
import { logger } from '../config/logger.js';
import { sleep } from '../utils/sleep.js';
import {
    PortalAnnouncementPayload,
    PortalAnnouncementResponse,
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

    async sendAnnouncement(
        payload: PortalAnnouncementPayload
    ): Promise<PortalAnnouncementResponse | null> {
        const validatedPayload = portalAnnouncementPayloadSchema.parse(payload);

        if (this.dryRun) {
            logger.info(
                {
                    messageId: validatedPayload.messageId,
                    channelId: validatedPayload.channelId,
                    idempotencyKey: validatedPayload.idempotencyKey,
                },
                'Dry run enabled: skipping portal API call'
            );
            return null;
        }

        const headers = {
            Authorization: `Bearer ${env.PORTAL_API_SECRET}`,
            'Content-Type': 'application/json',
            'X-Idempotency-Key': validatedPayload.idempotencyKey,
        };

        const maxAttempts = env.PORTAL_MAX_RETRIES + 1;

        for (let attempt = 1; attempt <= maxAttempts; attempt++) {
            try {
                const response = await axios.post<unknown>(
                    env.PORTAL_API_URL,
                    validatedPayload,
                    {
                        headers,
                        timeout: env.PORTAL_API_TIMEOUT_MS,
                    }
                );

                return portalAnnouncementResponseSchema.parse(response.data);
            } catch (error) {
                if (!axios.isAxiosError(error)) {
                    logger.error(
                        {
                            attempt,
                            messageId: validatedPayload.messageId,
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
                            status,
                            messageId: validatedPayload.messageId,
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
                        status,
                        delay,
                        messageId: validatedPayload.messageId,
                    },
                    'Portal API request failed, retrying'
                );

                await sleep(delay);
            }
        }

        return null;
    }
}
