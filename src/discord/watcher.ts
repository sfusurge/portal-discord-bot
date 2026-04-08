import {
    ChannelType,
    Client,
    Events,
    GatewayIntentBits,
    Message,
} from 'discord.js';
import { env } from '../config/env.js';
import { logger } from '../config/logger.js';
import { PortalClient } from '../portal/client.js';
import {
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
    const isUnwatchedChannel = !env.DISCORD_WATCH_CHANNEL_SET.has(message.channelId);
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

function normalizeMessageContent(message: Message): string {
    const base = message.content?.trim() ?? '';

    const attachmentUrls = [...message.attachments.values()]
        .map((attachment) => attachment.url)
        .filter(Boolean);

    if (attachmentUrls.length === 0) {
        return base;
    }

    return [base, ...attachmentUrls].filter(Boolean).join('\n');
}

export async function startWatcher(dryRun = false): Promise<Client> {
    const portalClient = new PortalClient(dryRun);

    const client = new Client({
        intents: [
            GatewayIntentBits.Guilds,
            GatewayIntentBits.GuildMessages,
            GatewayIntentBits.MessageContent,
        ],
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

            const content = normalizeMessageContent(message);

            if (!content) {
                logger.info(
                    {
                        messageId: message.id,
                        channelId: message.channelId,
                    },
                    'Skipping empty message'
                );
                return;
            }

            const payload: PortalAnnouncementPayload = {
                channelId: message.channelId,
                guildId: message.guildId,
                messageId: message.id,
                authorId: message.author.id,
                content,
                timestamp: message.createdAt.toISOString(),
                idempotencyKey: message.id,
            };

            const validatedPayload = portalAnnouncementPayloadSchema.parse(payload);
            const result = await portalClient.sendAnnouncement(validatedPayload);

            logger.info(
                {
                    messageId: message.id,
                    channelId: message.channelId,
                    resultStatus: result?.status ?? 'dry-run',
                },
                'Processed watched Discord message'
            );
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

    await client.login(env.DISCORD_BOT_TOKEN);

    return client;
}
