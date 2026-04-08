import { z } from 'zod';

const nonEmptyString = z.string().trim().min(1);

export const portalAnnouncementPayloadSchema = z.object({
    channelId: nonEmptyString,
    guildId: nonEmptyString,
    messageId: nonEmptyString,
    authorId: nonEmptyString,
    content: nonEmptyString,
    timestamp: z.iso.datetime({ offset: true }),
    idempotencyKey: nonEmptyString,
});

export const portalAnnouncementResponseSchema = z.object({
    id: z.number().int().positive(),
    status: z.enum(['created', 'duplicate']),
    hackathonId: z.number().int().positive(),
});

export type PortalAnnouncementPayload = z.infer<
    typeof portalAnnouncementPayloadSchema
>;

export type PortalAnnouncementResponse = z.infer<
    typeof portalAnnouncementResponseSchema
>;
