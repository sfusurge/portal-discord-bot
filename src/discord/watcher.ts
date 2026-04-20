import {
    ChannelType,
    Client,
    Events,
    GatewayIntentBits,
    Message,
    PartialMessage,
    Partials,
} from 'discord.js';
import { env } from '../config/env.js';
import { logger } from '../config/logger.js';
import { PortalClient } from '../portal/client.js';
import {
    PortalAnnouncementAttachment,
    PortalAnnouncementPayload,
    portalAnnouncementPayloadSchema,
} from '../types/portal.js';

const SUPPORTED_CHANNEL_TYPES = new Set<ChannelType>([
    ChannelType.GuildText,
    ChannelType.GuildAnnouncement,
]);

type EligibleGuildMessage = Message<true>;

function isEligibleMessage(message: Message): message is EligibleGuildMessage {
    const isIgnoredAuthor =
        message.author.bot || message.system || Boolean(message.webhookId);
    const isUnwatchedChannel = !env.DISCORD_WATCH_CHANNEL_SET.has(
        message.channelId
    );
    const isUnsupportedChannelType = !SUPPORTED_CHANNEL_TYPES.has(
        message.channel.type
    );

    return !(
        isIgnoredAuthor ||
        !message.inGuild() ||
        isUnwatchedChannel ||
        isUnsupportedChannelType
    );
}

function extractAttachments(
    message: Message
): PortalAnnouncementAttachment[] {
    return [...message.attachments.values()].map((attachment) => ({
        url: attachment.url,
        filename: attachment.name ?? null,
        contentType: attachment.contentType ?? null,
        sizeBytes: typeof attachment.size === 'number' ? attachment.size : null,
        width: attachment.width ?? null,
        height: attachment.height ?? null,
    }));
}

function buildPayload(
    message: EligibleGuildMessage,
    options: { isEdit: boolean }
): PortalAnnouncementPayload {
    const content = message.content?.trim() ?? '';
    const attachments = extractAttachments(message);

    const editedTimestamp =
        options.isEdit && message.editedAt
            ? message.editedAt.toISOString()
            : null;

    const rawPayload = message.toJSON() as Record<string, unknown>;

    return {
        channelId: message.channelId,
        guildId: message.guildId,
        messageId: message.id,
        authorId: message.author.id,
        content,
        attachments,
        timestamp: message.createdAt.toISOString(),
        editedTimestamp,
        rawPayload,
        idempotencyKey: message.id,
    };
}

async function processMessage(
    portalClient: PortalClient,
    message: EligibleGuildMessage,
    options: { isEdit: boolean }
): Promise<void> {
    const payload = buildPayload(message, options);

    if (payload.content.length === 0 && payload.attachments.length === 0) {
        logger.info(
            {
                messageId: message.id,
                channelId: message.channelId,
                isEdit: options.isEdit,
            },
            'Skipping message with no content or attachments'
        );
        return;
    }

    const validatedPayload = portalAnnouncementPayloadSchema.parse(payload);
    const result = await portalClient.sendAnnouncement(validatedPayload);

    logger.info(
        {
            messageId: message.id,
            channelId: message.channelId,
            isEdit: options.isEdit,
            attachmentCount: payload.attachments.length,
            resultStatus: result?.status ?? 'dry-run',
        },
        options.isEdit
            ? 'Processed watched Discord message edit'
            : 'Processed watched Discord message'
    );
}

async function hydratePartial(
    message: Message | PartialMessage
): Promise<Message | null> {
    if (!message.partial) {
        return message;
    }
    try {
        return await message.fetch();
    } catch (error) {
        logger.warn(
            {
                err: error,
                messageId: message.id,
                channelId: message.channelId,
            },
            'Failed to hydrate partial Discord message'
        );
        return null;
    }
}

export async function startWatcher(dryRun = false): Promise<Client> {
    const portalClient = new PortalClient(dryRun);

    const client = new Client({
        intents: [
            GatewayIntentBits.Guilds,
            GatewayIntentBits.GuildMessages,
            GatewayIntentBits.MessageContent,
        ],
        // Without Partials.Message, discord.js drops messageUpdate events for
        // any message not currently in the in-memory cache (e.g. edits to
        // messages sent before the bot started). Channel partial is needed
        // to hydrate the partial message via fetch().
        partials: [Partials.Message, Partials.Channel],
    });

    client.once(Events.ClientReady, (readyClient) => {
        logger.info(
            {
                botUserId: readyClient.user.id,
                watchedChannels: env.DISCORD_WATCH_CHANNEL_IDS,
                dryRun,
            },
            'Discord watcher is ready'
        );
    });

    client.on(Events.Error, (error) => {
        logger.error({ err: error }, 'Discord client error');
    });

    client.on(Events.Warn, (warning) => {
        logger.warn({ warning }, 'Discord client warning');
    });

    client.on(Events.MessageCreate, async (message) => {
        try {
            if (!isEligibleMessage(message)) {
                return;
            }
            await processMessage(portalClient, message, { isEdit: false });
        } catch (error) {
            logger.error(
                {
                    err: error,
                    messageId: message.id,
                    channelId: message.channelId,
                },
                'Failed to process watched Discord message'
            );
        }
    });

    client.on(Events.MessageUpdate, async (_oldMessage, newMessage) => {
        try {
            const hydrated = await hydratePartial(newMessage);
            if (!hydrated || !isEligibleMessage(hydrated) || !hydrated.editedAt) {
                return;
            }
            await processMessage(portalClient, hydrated, { isEdit: true });
        } catch (error) {
            logger.error(
                {
                    err: error,
                    messageId: newMessage.id,
                    channelId: newMessage.channelId,
                },
                'Failed to process watched Discord message edit'
            );
        }
    });

    await client.login(env.DISCORD_BOT_TOKEN);

    return client;
}
