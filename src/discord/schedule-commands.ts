import { randomBytes } from 'node:crypto';
import {
    ActionRowBuilder,
    ButtonBuilder,
    ButtonInteraction,
    ButtonStyle,
    ChannelType,
    ChatInputCommandInteraction,
    Client,
    EmbedBuilder,
    Events,
    Guild,
    Interaction,
    NewsChannel,
    PermissionFlagsBits,
    REST,
    Routes,
    SlashCommandBuilder,
    TextChannel,
} from 'discord.js';
import { acquireProcessLock } from '../schedule/lock.js';
import { env } from '../config/env.js';
import { logger } from '../config/logger.js';
import {
    BoardRebuildError,
    syncBoardPosts,
    type BoardChange,
    deletedBoardMessage,
    formatMessageId,
    recordEmbed,
    type AnnouncementEmbed,
} from '../schedule/board.js';
import { parseBulkDocument, type BulkBlock, type BulkChannel, type BulkRole } from '../schedule/bulk.js';
import {
    AnnouncementScheduler,
    type SchedulerPorts,
} from '../schedule/scheduler.js';
import {
    PENDING_CAP,
    ScheduleStore,
    addAnnouncement,
    pendingCount,
    removeAnnouncement,
    replaceAnnouncement,
    type Announcement,
    type ScheduleFile,
} from '../schedule/store.js';
import {
    announcementMessageError,
    formatClock,
    localDateAndTime,
    parseAnnouncementId,
    parseDateTime,
} from '../schedule/time.js';

const CONFIRM_MS = 120_000;
const BULK_BLOCK_CAP = 50;
const SUMMARY_LINE_CAP = 20;
const FILE_BYTE_CAP = 256 * 1024;
const silentMentions = { parse: [] as [] };
const liveMentions = { parse: ['users', 'roles', 'everyone'] as ('users' | 'roles' | 'everyone')[] };

const commandBuilders = [
    new SlashCommandBuilder()
        .setName('sm')
        .setDescription('Schedule an announcement')
        .setDefaultMemberPermissions(PermissionFlagsBits.Administrator)
        .setDMPermission(false)
        .addStringOption((option) =>
            option
                .setName('date')
                .setDescription('YYYY-MM-DD in the configured timezone')
                .setRequired(true)
                .setMaxLength(10)
        )
        .addStringOption((option) =>
            option
                .setName('time')
                .setDescription('HH:mm in 24-hour time')
                .setRequired(true)
                .setMaxLength(5)
        )
        .addChannelOption((option) =>
            option
                .setName('channel')
                .setDescription('Channel that receives the announcement')
                .setRequired(true)
                .addChannelTypes(ChannelType.GuildText, ChannelType.GuildAnnouncement)
        )
        .addStringOption((option) =>
            option
                .setName('message')
                .setDescription('Announcement text, up to 2000 characters')
                .setRequired(true)
                .setMaxLength(2000)
        ),
    new SlashCommandBuilder()
        .setName('em')
        .setDescription('Edit a pending announcement')
        .setDefaultMemberPermissions(PermissionFlagsBits.Administrator)
        .setDMPermission(false)
        .addStringOption((option) =>
            option.setName('id').setDescription('1 or msg 1').setRequired(true)
        )
        .addStringOption((option) =>
            option.setName('date').setDescription('New YYYY-MM-DD').setMaxLength(10)
        )
        .addStringOption((option) =>
            option.setName('time').setDescription('New HH:mm').setMaxLength(5)
        )
        .addChannelOption((option) =>
            option
                .setName('channel')
                .setDescription('New channel')
                .addChannelTypes(ChannelType.GuildText, ChannelType.GuildAnnouncement)
        )
        .addStringOption((option) =>
            option
                .setName('message')
                .setDescription('New announcement text')
                .setMaxLength(2000)
        ),
    new SlashCommandBuilder()
        .setName('dm')
        .setDescription('Delete a pending announcement')
        .setDefaultMemberPermissions(PermissionFlagsBits.Administrator)
        .setDMPermission(false)
        .addStringOption((option) =>
            option.setName('id').setDescription('1 or msg 1').setRequired(true)
        ),
    new SlashCommandBuilder()
        .setName('bulk')
        .setDescription('Schedule many announcements from a text file or paste')
        .setDefaultMemberPermissions(PermissionFlagsBits.Administrator)
        .setDMPermission(false)
        .addAttachmentOption((option) =>
            option.setName('file').setDescription('UTF-8 .txt or .md document')
        )
        .addStringOption((option) =>
            option
                .setName('text')
                .setDescription('The same document pasted inline')
                .setMaxLength(6000)
        ),
];

interface EditPatch {
    message?: string;
    channelId?: string;
    scheduledAt?: string;
    timezone?: string;
}

interface PendingEdit {
    kind: 'edit';
    userId: string;
    expiresAt: number;
    announcementId: number;
    patch: EditPatch;
}

interface PendingDelete {
    kind: 'delete';
    userId: string;
    expiresAt: number;
    announcementId: number;
}

interface PendingBulk {
    kind: 'bulk';
    userId: string;
    expiresAt: number;
    blocks: BulkBlock[];
}

type PendingConfirmation = PendingEdit | PendingDelete | PendingBulk;

interface ActiveScheduling {
    client: Client;
    store: ScheduleStore;
    scheduler: AnnouncementScheduler;
    ports: SchedulerPorts;
}

const confirmations = new Map<string, PendingConfirmation>();
let active: ActiveScheduling | null = null;
let releaseLock: (() => Promise<void>) | null = null;

export async function stopScheduling(): Promise<void> {
    const scheduler = active?.scheduler;
    if (scheduler) {
        await scheduler.stop();
    }
    active = null;
    const release = releaseLock;
    releaseLock = null;
    await release?.();
}

export async function startScheduling(client: Client): Promise<void> {
    client.on(Events.InteractionCreate, (interaction) => {
        void handleInteraction(interaction).catch((error: unknown) => {
            logger.error({ err: error }, 'Schedule command failed');
            const content = 'Something went wrong running that command.';
            const notify = async () => {
                if (!interaction.isRepliable()) {
                    return;
                }
                if (interaction.deferred && !interaction.replied) {
                    await interaction.editReply({ content });
                    return;
                }
                if (interaction.replied || interaction.deferred) {
                    await interaction.followUp({ content, ephemeral: true });
                    return;
                }
                await interaction.reply({ content, ephemeral: true });
            };
            void notify().catch(() => undefined);
        });
    });

    if (!env.DISCORD_GUILD_ID || !env.SCHEDULE_EXEC_CHANNEL_ID) {
        logger.warn(
            'Scheduling commands are off until DISCORD_GUILD_ID and SCHEDULE_EXEC_CHANNEL_ID are set'
        );
        return;
    }

    try {
        releaseLock = await acquireProcessLock(`${env.SCHEDULE_STORE_PATH}.lock`);
    } catch (error) {
        logger.error({ err: error }, 'Scheduling did not start');
        return;
    }

    const store = new ScheduleStore(env.SCHEDULE_STORE_PATH);
    const ports = discordPorts(client);
    const scheduler = new AnnouncementScheduler(
        store,
        ports,
        () => new Date(),
        (error) => {
            logger.error({ err: error }, 'Schedule runner failed');
        }
    );
    active = { client, store, scheduler, ports };

    try {
        await registerCommands(client);
    } catch (error) {
        logger.error({ err: error }, 'Failed to register schedule commands');
    }

    await scheduler.start();
    logger.info(
        { guildId: env.DISCORD_GUILD_ID, execChannelId: env.SCHEDULE_EXEC_CHANNEL_ID },
        'Announcement scheduler is running'
    );
}

function discordPorts(client: Client): SchedulerPorts {
    return {
        async send(announcement) {
            const channel = await postableChannel(client, announcement.channelId);
            const message = await channel.send({
                content: announcement.message,
                allowedMentions: liveMentions,
            });
            return { messageId: message.id };
        },
        async log(entry) {
            const channel = await execChannel(client);
            if (typeof entry === 'string') {
                await channel.send({
                    content: entry,
                    allowedMentions: silentMentions,
                });
                return;
            }
            await channel.send({
                content: entry.content || undefined,
                embeds: [discordEmbed(entry.embed)],
                allowedMentions: silentMentions,
            });
        },
        async rebuild(data, change) {
            const channel = await execChannel(client);
            return syncBoardPosts(
                data,
                {
                    async deleteMessage(id) {
                        await channel.messages.delete(id);
                    },
                    async send(cards) {
                        const message = await channel.send({
                            embeds: cards.map((card) => discordEmbed(card.embed)),
                            allowedMentions: silentMentions,
                        });
                        return { id: message.id };
                    },
                    async editMessage(id, cards) {
                        await channel.messages.edit(id, {
                            embeds: cards.map((card) => discordEmbed(card.embed)),
                            allowedMentions: silentMentions,
                        });
                    },
                },
                change
            );
        },
    };
}

async function registerCommands(client: Client): Promise<void> {
    if (!client.user || !env.DISCORD_GUILD_ID) {
        return;
    }
    const rest = new REST({ version: '10' }).setToken(env.DISCORD_BOT_TOKEN);
    await rest.put(
        Routes.applicationGuildCommands(client.user.id, env.DISCORD_GUILD_ID),
        { body: commandBuilders.map((command) => command.toJSON()) }
    );
    logger.info({ guildId: env.DISCORD_GUILD_ID }, 'Registered schedule commands');
}

async function handleInteraction(interaction: Interaction): Promise<void> {
    if (interaction.isChatInputCommand()) {
        await handleCommand(interaction);
        return;
    }
    if (interaction.isButton()) {
        await handleButton(interaction);
    }
}

async function handleCommand(interaction: ChatInputCommandInteraction): Promise<void> {
    if (!['sm', 'em', 'dm', 'bulk'].includes(interaction.commandName)) {
        return;
    }
    await interaction.deferReply({ ephemeral: true });
    if (!active || !interaction.guild || interaction.guildId !== env.DISCORD_GUILD_ID) {
        await reply(interaction, 'Scheduling is not configured on this bot.');
        return;
    }
    if (!interaction.memberPermissions?.has(PermissionFlagsBits.Administrator)) {
        await reply(interaction, 'You need the Administrator permission to schedule announcements.');
        return;
    }

    switch (interaction.commandName) {
        case 'sm':
            await scheduleOne(interaction, active);
            return;
        case 'em':
            await beginEdit(interaction, active);
            return;
        case 'dm':
            await beginDelete(interaction, active);
            return;
        case 'bulk':
            await beginBulk(interaction, active);
            return;
        default:
            return;
    }
}

async function scheduleOne(
    interaction: ChatInputCommandInteraction,
    scheduling: ActiveScheduling
): Promise<void> {
    const guild = interaction.guild;
    if (!guild) {
        return;
    }
    const message = interaction.options.getString('message', true);
    const messageError = announcementMessageError(message);
    if (messageError) {
        await reply(interaction, messageError);
        return;
    }
    const when = parseDateTime({
        date: interaction.options.getString('date', true),
        time: interaction.options.getString('time', true),
        timeZone: env.SCHEDULE_TIMEZONE,
        now: new Date(),
    });
    if (!when.ok) {
        await reply(interaction, dateTimeMessage(when.reason));
        return;
    }
    const channel = interaction.options.getChannel('channel', true);
    const channelError = await channelPostError(guild, channel.id);
    if (channelError) {
        await reply(interaction, channelError);
        return;
    }

    let boardError = false;
    let announcement: Announcement | null = null;
    await scheduling.store.update(async (data) => {
        const created = addAnnouncement(data, {
            message,
            channelId: channel.id,
            guildId: guild.id,
            scheduledAt: when.scheduledAt,
            timezone: env.SCHEDULE_TIMEZONE,
            createdById: interaction.user.id,
        });
        if (!created.ok) {
            return data;
        }
        announcement = created.announcement;
        return saveBoard(
            scheduling.ports,
            created.data,
            { type: 'upsert', ids: [created.announcement.id] },
            (failed) => {
                boardError = failed;
            }
        );
    });

    if (!announcement) {
        await reply(interaction, 'There are already 100 scheduled announcements.');
        return;
    }
    scheduling.scheduler.arm();
    await reply(
        interaction,
        boardError
            ? '# Scheduled\nThe exec board could not be refreshed.'
            : '# Scheduled',
        { embed: recordEmbed(announcement) }
    );
}

async function beginEdit(
    interaction: ChatInputCommandInteraction,
    scheduling: ActiveScheduling
): Promise<void> {
    const guild = interaction.guild;
    if (!guild) {
        return;
    }
    const data = await scheduling.store.read();
    const found = pendingById(data, interaction.options.getString('id', true));
    if (typeof found === 'string') {
        await reply(interaction, found);
        return;
    }

    const dateOption = interaction.options.getString('date');
    const timeOption = interaction.options.getString('time');
    const messageOption = interaction.options.getString('message');
    const channelOption = interaction.options.getChannel('channel');
    if (!dateOption && !timeOption && !messageOption && !channelOption) {
        await reply(interaction, 'Include a date, time, channel, or message to change.');
        return;
    }

    const patch: EditPatch = {};
    if (messageOption !== null) {
        const messageError = announcementMessageError(messageOption);
        if (messageError) {
            await reply(interaction, messageError);
            return;
        }
        patch.message = messageOption;
    }
    if (channelOption) {
        const channelError = await channelPostError(guild, channelOption.id);
        if (channelError) {
            await reply(interaction, channelError);
            return;
        }
        patch.channelId = channelOption.id;
    }
    if (dateOption || timeOption) {
        const current = localDateAndTime(
            new Date(found.scheduledAt),
            env.SCHEDULE_TIMEZONE
        );
        const when = parseDateTime({
            date: dateOption ?? current.date,
            time: timeOption ?? current.time,
            timeZone: env.SCHEDULE_TIMEZONE,
            now: new Date(),
        });
        if (!when.ok) {
            await reply(interaction, dateTimeMessage(when.reason));
            return;
        }
        patch.scheduledAt = when.scheduledAt.toISOString();
        patch.timezone = env.SCHEDULE_TIMEZONE;
    }
    if (!patchChanges(found, patch)) {
        await reply(interaction, 'That edit does not change anything.');
        return;
    }

    const preview = applyPatch(found, patch);
    const token = remember({
        kind: 'edit',
        userId: interaction.user.id,
        expiresAt: Date.now() + CONFIRM_MS,
        announcementId: found.id,
        patch,
    });
    await reply(interaction, '', {
        components: confirmRow(token),
        embed: recordEmbed(preview),
    });
}

async function beginDelete(
    interaction: ChatInputCommandInteraction,
    scheduling: ActiveScheduling
): Promise<void> {
    const data = await scheduling.store.read();
    const found = pendingById(data, interaction.options.getString('id', true));
    if (typeof found === 'string') {
        await reply(interaction, found);
        return;
    }
    const token = remember({
        kind: 'delete',
        userId: interaction.user.id,
        expiresAt: Date.now() + CONFIRM_MS,
        announcementId: found.id,
    });
    await reply(interaction, '', {
        components: confirmRow(token),
        embed: deletedBoardMessage(found).embed,
    });
}

async function beginBulk(
    interaction: ChatInputCommandInteraction,
    scheduling: ActiveScheduling
): Promise<void> {
    const guild = interaction.guild;
    if (!guild) {
        return;
    }
    const file = interaction.options.getAttachment('file');
    const text = interaction.options.getString('text');
    if (Boolean(file) === Boolean(text)) {
        await reply(interaction, 'Provide a text file or pasted text, and only one of them.');
        return;
    }

    let document = text ?? '';
    if (file) {
        const fileError = fileErrorMessage(file.name, file.contentType, file.size);
        if (fileError) {
            await reply(interaction, fileError);
            return;
        }
        try {
            document = await readAttachment(file.url, file.size);
        } catch (error) {
            await reply(
                interaction,
                error instanceof Error ? error.message : 'Could not read that file.'
            );
            return;
        }
    }

    const parsed = parseBulkDocument({
        text: document,
        channels: await channelLookups(guild),
        roles: await roleLookups(guild),
        timeZone: env.SCHEDULE_TIMEZONE,
        now: new Date(),
    });
    if (!parsed.ok) {
        await reply(
            interaction,
            [
                '# Not scheduled',
                ...parsed.errors.map((issue) => `Block ${issue.block}: ${issue.message}`),
            ].join('\n')
        );
        return;
    }
    if (parsed.blocks.length > BULK_BLOCK_CAP) {
        await reply(interaction, `A document can schedule at most ${BULK_BLOCK_CAP} announcements.`);
        return;
    }
    const data = await scheduling.store.read();
    if (pendingCount(data) + parsed.blocks.length > PENDING_CAP) {
        await reply(interaction, 'This batch would go past 100 scheduled announcements.');
        return;
    }
    for (const block of parsed.blocks) {
        const channelError = await channelPostError(guild, block.channelId);
        if (channelError) {
            await reply(interaction, channelError);
            return;
        }
    }

    const lines = parsed.blocks.slice(0, SUMMARY_LINE_CAP).map((block, index) => {
        const clock = formatClock(block.scheduledAt, env.SCHEDULE_TIMEZONE);
        return `**${index + 1}.** ${clock} · <#${block.channelId}>\n-# ${snippet(block.message)}`;
    });
    if (parsed.blocks.length > SUMMARY_LINE_CAP) {
        lines.push(`and ${parsed.blocks.length - SUMMARY_LINE_CAP} more`);
    }
    const token = remember({
        kind: 'bulk',
        userId: interaction.user.id,
        expiresAt: Date.now() + CONFIRM_MS,
        blocks: parsed.blocks,
    });
    await reply(
        interaction,
        ['# Confirm schedule', ...lines].join('\n'),
        { components: confirmRow(token) }
    );
}

async function handleButton(interaction: ButtonInteraction): Promise<void> {
    const match = /^sched:(ok|no):([0-9a-f]+)$/.exec(interaction.customId);
    if (!match) {
        return;
    }
    await interaction.deferUpdate();
    if (!active) {
        await reply(interaction, 'Scheduling is not configured on this bot.');
        return;
    }
    const pending = confirmations.get(match[2]);
    if (!pending || pending.expiresAt <= Date.now()) {
        confirmations.delete(match[2]);
        await updateButton(interaction, 'That confirmation expired. Run the command again.');
        return;
    }
    if (interaction.user.id !== pending.userId) {
        await reply(interaction, 'Only the admin who started this can confirm or cancel it.');
        return;
    }
    confirmations.delete(match[2]);
    if (match[1] === 'no') {
        await updateButton(interaction, 'Cancelled.');
        return;
    }

    if (pending.kind === 'edit') {
        await confirmEdit(interaction, active, pending);
        return;
    }
    if (pending.kind === 'delete') {
        await confirmDelete(interaction, active, pending);
        return;
    }
    await confirmBulk(interaction, active, pending);
}

async function confirmEdit(
    interaction: ButtonInteraction,
    scheduling: ActiveScheduling,
    pending: PendingEdit
): Promise<void> {
    const guild = interaction.guild;
    if (!guild) {
        return;
    }
    if (pending.patch.scheduledAt && Date.parse(pending.patch.scheduledAt) <= Date.now()) {
        await updateButton(interaction, 'That time is already past. Run /em again.');
        return;
    }
    if (pending.patch.channelId) {
        const channelError = await channelPostError(guild, pending.patch.channelId);
        if (channelError) {
            await updateButton(interaction, channelError);
            return;
        }
    }

    let missing = false;
    let boardError = false;
    await scheduling.store.update(async (data) => {
        const current = data.announcements.find((item) => item.id === pending.announcementId);
        if (!current || current.status !== 'pending') {
            missing = true;
            return data;
        }
        return saveBoard(
            scheduling.ports,
            replaceAnnouncement(data, applyPatch(current, pending.patch)),
            { type: 'upsert', ids: [pending.announcementId] },
            (failed) => {
                boardError = failed;
            }
        );
    });
    if (missing) {
        await updateButton(
            interaction,
            `**${formatMessageId(pending.announcementId)}** is no longer scheduled.`
        );
        return;
    }
    scheduling.scheduler.arm();
    await updateButton(
        interaction,
        `# Updated\n**${formatMessageId(pending.announcementId)}**${boardError ? '\nThe exec board could not be refreshed.' : ''}`
    );
}

async function confirmDelete(
    interaction: ButtonInteraction,
    scheduling: ActiveScheduling,
    pending: PendingDelete
): Promise<void> {
    let removed: Announcement | null = null;
    let boardError = false;
    await scheduling.store.update(async (data) => {
        const result = removeAnnouncement(data, pending.announcementId);
        if (!result.ok) {
            return data;
        }
        removed = result.announcement;
        await scheduling.ports.log(deletedBoardMessage(result.announcement)).catch(() => undefined);
        return saveBoard(
            scheduling.ports,
            result.data,
            { type: 'upsert', ids: [] },
            (failed) => {
                boardError = failed;
            }
        );
    });
    if (!removed) {
        await updateButton(
            interaction,
            `**${formatMessageId(pending.announcementId)}** is no longer scheduled.`
        );
        return;
    }
    scheduling.scheduler.arm();
    await updateButton(
        interaction,
        `# Deleted\n**${formatMessageId(pending.announcementId)}**${boardError ? '\nThe exec board could not be refreshed.' : ''}`
    );
}

async function confirmBulk(
    interaction: ButtonInteraction,
    scheduling: ActiveScheduling,
    pending: PendingBulk
): Promise<void> {
    const guild = interaction.guild;
    if (!guild) {
        return;
    }
    if (pending.blocks.some((block) => block.scheduledAt.getTime() <= Date.now())) {
        await updateButton(interaction, 'A time in that batch is already past. Run /bulk again.');
        return;
    }
    for (const block of pending.blocks) {
        const channelError = await channelPostError(guild, block.channelId);
        if (channelError) {
            await updateButton(interaction, channelError);
            return;
        }
    }

    const ids: number[] = [];
    let full = false;
    let boardError = false;
    await scheduling.store.update(async (data) => {
        if (pendingCount(data) + pending.blocks.length > PENDING_CAP) {
            full = true;
            return data;
        }
        let current = data;
        for (const block of pending.blocks) {
            const created = addAnnouncement(current, {
                message: block.message,
                channelId: block.channelId,
                guildId: guild.id,
                scheduledAt: block.scheduledAt,
                timezone: env.SCHEDULE_TIMEZONE,
                createdById: interaction.user.id,
            });
            if (!created.ok) {
                full = true;
                return data;
            }
            ids.push(created.announcement.id);
            current = created.data;
        }
        return saveBoard(
            scheduling.ports,
            current,
            { type: 'upsert', ids },
            (failed) => {
                boardError = failed;
            }
        );
    });
    if (full) {
        await updateButton(interaction, 'This batch would go past 100 scheduled announcements.');
        return;
    }
    scheduling.scheduler.arm();
    const listed = ids.map((id) => `**${formatMessageId(id)}**`).join(' · ');
    await updateButton(
        interaction,
        `# Scheduled\n${listed}${boardError ? '\nThe exec board could not be refreshed.' : ''}`
    );
}

async function saveBoard(
    ports: SchedulerPorts,
    data: ScheduleFile,
    change: BoardChange,
    mark: (failed: boolean) => void
): Promise<ScheduleFile> {
    try {
        const rebuilt = await ports.rebuild(data, change);
        mark(false);
        return rebuilt;
    } catch (error) {
        mark(true);
        logger.error({ err: error }, 'Failed to update the exec board');
        if (error instanceof BoardRebuildError && error.partial) {
            return error.partial;
        }
        return data;
    }
}

function applyPatch(announcement: Announcement, patch: EditPatch): Announcement {
    return {
        ...announcement,
        message: patch.message ?? announcement.message,
        channelId: patch.channelId ?? announcement.channelId,
        scheduledAt: patch.scheduledAt ?? announcement.scheduledAt,
        timezone: patch.timezone ?? announcement.timezone,
        sendFailureStreak: 0,
    };
}

function patchChanges(announcement: Announcement, patch: EditPatch): boolean {
    if (patch.message !== undefined && patch.message !== announcement.message) {
        return true;
    }
    if (patch.channelId !== undefined && patch.channelId !== announcement.channelId) {
        return true;
    }
    if (patch.scheduledAt !== undefined && patch.scheduledAt !== announcement.scheduledAt) {
        return true;
    }
    return false;
}

function pendingById(data: ScheduleFile, rawId: string): Announcement | string {
    const id = parseAnnouncementId(rawId);
    if (id === null) {
        return 'Use an id like 1 or msg 1.';
    }
    const found = data.announcements.find((item) => item.id === id);
    if (!found) {
        return `No announcement **${formatMessageId(id)}**.`;
    }
    if (found.status !== 'pending') {
        return `**${formatMessageId(id)}** was already sent.`;
    }
    return found;
}

function remember(pending: PendingConfirmation): string {
    const now = Date.now();
    for (const [token, confirmation] of confirmations) {
        if (confirmation.expiresAt <= now) {
            confirmations.delete(token);
        }
    }
    const token = randomBytes(8).toString('hex');
    confirmations.set(token, pending);
    return token;
}

function confirmRow(token: string): ActionRowBuilder<ButtonBuilder> {
    return new ActionRowBuilder<ButtonBuilder>().addComponents(
        new ButtonBuilder()
            .setCustomId(`sched:ok:${token}`)
            .setStyle(ButtonStyle.Success)
            .setEmoji('✅')
            .setLabel('Confirm'),
        new ButtonBuilder()
            .setCustomId(`sched:no:${token}`)
            .setStyle(ButtonStyle.Danger)
            .setEmoji('❌')
            .setLabel('Cancel')
    );
}

function dateTimeMessage(reason: 'invalid' | 'nonexistent' | 'past'): string {
    if (reason === 'past') {
        return 'That time is already past.';
    }
    if (reason === 'nonexistent') {
        return `That local time does not exist in ${env.SCHEDULE_TIMEZONE}.`;
    }
    return 'Use a date like 2026-09-26 and a time like 18:00.';
}

function snippet(message: string): string {
    const oneLine = message.replace(/\s+/g, ' ').trim();
    if (oneLine.length <= 80) {
        return oneLine;
    }
    return `${oneLine.slice(0, 79)}…`;
}

function fileErrorMessage(
    name: string,
    contentType: string | null,
    size: number
): string | null {
    const lower = name.toLowerCase();
    const type = contentType ?? '';
    const accepted =
        lower.endsWith('.txt') ||
        lower.endsWith('.md') ||
        type.startsWith('text/plain') ||
        type.startsWith('text/markdown');
    if (!accepted) {
        return 'Upload a .txt or .md file.';
    }
    if (size > FILE_BYTE_CAP) {
        return 'That file is larger than 256 KB.';
    }
    return null;
}

async function readAttachment(url: string, size: number): Promise<string> {
    const response = await fetch(url, { signal: AbortSignal.timeout(15_000) });
    if (!response.ok) {
        throw new Error('Could not download that file.');
    }
    const bytes = new Uint8Array(await response.arrayBuffer());
    if (bytes.byteLength > FILE_BYTE_CAP || size > FILE_BYTE_CAP) {
        throw new Error('That file is larger than 256 KB.');
    }
    try {
        return new TextDecoder('utf-8', { fatal: true }).decode(bytes);
    } catch {
        throw new Error('That file is not valid UTF-8.');
    }
}

async function channelLookups(guild: Guild): Promise<BulkChannel[]> {
    const fetched = await guild.channels.fetch();
    const channels: BulkChannel[] = [];
    for (const channel of fetched.values()) {
        if (
            !channel ||
            (channel.type !== ChannelType.GuildText &&
                channel.type !== ChannelType.GuildAnnouncement) ||
            !('name' in channel) ||
            typeof channel.name !== 'string'
        ) {
            continue;
        }
        channels.push({ id: channel.id, name: channel.name });
    }
    return channels;
}

async function roleLookups(guild: Guild): Promise<BulkRole[]> {
    const roles = await guild.roles.fetch();
    return [...roles.values()].map((role) => ({ id: role.id, name: role.name }));
}

async function channelPostError(guild: Guild, channelId: string): Promise<string | null> {
    const channel = await guild.channels.fetch(channelId).catch(() => null);
    if (
        !channel ||
        (channel.type !== ChannelType.GuildText &&
            channel.type !== ChannelType.GuildAnnouncement)
    ) {
        return 'That channel is not a text or announcement channel.';
    }
    const me = guild.members.me ?? (await guild.members.fetchMe());
    const permissions = channel.permissionsFor(me);
    if (
        !permissions?.has(PermissionFlagsBits.ViewChannel) ||
        !permissions.has(PermissionFlagsBits.SendMessages)
    ) {
        return `I can't view or send messages in <#${channelId}>.`;
    }
    return null;
}

async function execChannel(client: Client): Promise<TextChannel | NewsChannel> {
    if (!env.SCHEDULE_EXEC_CHANNEL_ID) {
        throw new Error('Exec channel is not configured');
    }
    const channel = await client.channels.fetch(env.SCHEDULE_EXEC_CHANNEL_ID);
    if (
        !channel ||
        (channel.type !== ChannelType.GuildText &&
            channel.type !== ChannelType.GuildAnnouncement)
    ) {
        throw new Error('Exec channel is not available');
    }
    return channel;
}

async function postableChannel(
    client: Client,
    channelId: string
): Promise<TextChannel | NewsChannel> {
    const channel = await client.channels.fetch(channelId);
    if (
        !channel ||
        (channel.type !== ChannelType.GuildText &&
            channel.type !== ChannelType.GuildAnnouncement)
    ) {
        throw new Error('Target channel is not available');
    }
    return channel;
}

function discordEmbed(embed: AnnouncementEmbed): EmbedBuilder {
    const builder = new EmbedBuilder()
        .setColor(embed.color)
        .setTitle(embed.title)
        .setDescription(embed.description);
    if (embed.authorName) {
        builder.setAuthor({ name: embed.authorName });
    }
    if (embed.footer) {
        builder.setFooter({ text: embed.footer });
    }
    if (embed.fields.length > 0) {
        builder.addFields(embed.fields);
    }
    return builder;
}

async function reply(
    interaction: ChatInputCommandInteraction | ButtonInteraction,
    content: string,
    options?: {
        components?: ActionRowBuilder<ButtonBuilder>;
        embed?: AnnouncementEmbed;
    }
): Promise<void> {
    const pages = content.length === 0 ? [] : packLines(content);
    const [first, ...rest] = pages;
    const payload = {
        content: first ?? null,
        ephemeral: true,
        allowedMentions: silentMentions,
        components: options?.components ? [options.components] : [],
        embeds: options?.embed ? [discordEmbed(options.embed)] : [],
    };
    if (interaction.deferred && !interaction.replied) {
        await interaction.editReply({
            content: payload.content,
            allowedMentions: payload.allowedMentions,
            components: payload.components,
            embeds: payload.embeds,
        });
    } else if (interaction.replied || interaction.deferred) {
        await interaction.followUp(payload);
    } else {
        await interaction.reply(payload);
    }
    for (const page of rest) {
        await interaction.followUp({
            content: page,
            ephemeral: true,
            allowedMentions: silentMentions,
        });
    }
}

async function updateButton(interaction: ButtonInteraction, content: string): Promise<void> {
    const pages = packLines(content);
    const payload = {
        content: pages[0],
        components: [],
        embeds: [],
        allowedMentions: silentMentions,
    };
    if (interaction.deferred) {
        await interaction.editReply(payload);
    } else {
        await interaction.update(payload);
    }
    for (const page of pages.slice(1)) {
        await interaction.followUp({
            content: page,
            ephemeral: true,
            allowedMentions: silentMentions,
        });
    }
}

function packLines(content: string, limit = 2000): string[] {
    const lines = content.split('\n');
    const pages: string[] = [];
    let current = '';
    for (const line of lines) {
        const pieces = line.length <= limit ? [line] : chunk(line, limit);
        for (const piece of pieces) {
            const next = current.length === 0 ? piece : `${current}\n${piece}`;
            if (next.length > limit && current.length > 0) {
                pages.push(current);
                current = piece;
            } else {
                current = next;
            }
        }
    }
    if (current.length > 0) {
        pages.push(current);
    }
    return pages.length > 0 ? pages : ['Done.'];
}

function chunk(text: string, limit: number): string[] {
    const parts: string[] = [];
    for (let index = 0; index < text.length; index += limit) {
        parts.push(text.slice(index, index + limit));
    }
    return parts;
}
