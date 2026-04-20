import { z } from 'zod';

const nonEmptyString = z.string().trim().min(1);

export const portalAnnouncementAttachmentSchema = z.object({
    url: z.string().url(),
    filename: z.string().nullable().optional(),
    contentType: z.string().nullable().optional(),
    sizeBytes: z.number().int().nonnegative().nullable().optional(),
    width: z.number().int().nonnegative().nullable().optional(),
    height: z.number().int().nonnegative().nullable().optional(),
});

export const portalAnnouncementPayloadSchema = z
    .object({
        channelId: nonEmptyString,
        guildId: nonEmptyString,
        messageId: nonEmptyString,
        authorId: nonEmptyString,
        content: z.string(),
        timestamp: z.iso.datetime({ offset: true }),
        editedTimestamp: z.iso.datetime({ offset: true }).nullable().optional(),
        attachments: z
            .array(portalAnnouncementAttachmentSchema)
            .optional()
            .default([]),
        rawPayload: z.record(z.string(), z.unknown()).optional(),
        idempotencyKey: nonEmptyString,
    })
    .refine(
        (value) =>
            value.content.trim().length > 0 || value.attachments.length > 0,
        {
            message: 'Either content or at least one attachment is required',
            path: ['content'],
        }
    );

export const portalAnnouncementResponseSchema = z.object({
    id: z.number().int().positive(),
    status: z.enum(['created', 'duplicate', 'updated']),
    hackathonId: z.number().int().positive(),
});

export type PortalAnnouncementAttachment = z.infer<
    typeof portalAnnouncementAttachmentSchema
>;

export type PortalAnnouncementPayload = z.infer<
    typeof portalAnnouncementPayloadSchema
>;

export type PortalAnnouncementResponse = z.infer<
    typeof portalAnnouncementResponseSchema
>;
