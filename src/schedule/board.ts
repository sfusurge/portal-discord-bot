import type { Announcement, ScheduleFile } from './store.js';
import { formatClock } from './time.js';

export interface AnnouncementEmbed {
    title: string;
    authorName: string;
    description: string;
    fields: { name: string; value: string; inline: boolean }[];
    footer: string;
    color: number;
}

export interface BoardMessage {
    content: string;
    embed: AnnouncementEmbed;
}

export interface BoardChannel {
    deleteMessage(id: string): Promise<void>;
    send(cards: BoardMessage[]): Promise<{ id: string }>;
    editMessage(id: string, cards: BoardMessage[]): Promise<void>;
}

export type BoardChange =
    | { type: 'startup' }
    | { type: 'upsert'; ids: number[] }
    | { type: 'remove'; messageIds: string[] }
    | { type: 'refresh'; messageId: string };

export class BoardRebuildError extends Error {
    readonly boardMessageIds: string[];
    readonly partial: ScheduleFile | null;

    constructor(
        message: string,
        boardMessageIds: string[],
        partial: ScheduleFile | null = null
    ) {
        super(message);
        this.name = 'BoardRebuildError';
        this.boardMessageIds = boardMessageIds;
        this.partial = partial;
    }
}

export function sortBySchedule<T extends { scheduledAt: string; id: number }>(
    items: T[]
): T[] {
    return [...items].sort((left, right) => {
        const byTime = left.scheduledAt.localeCompare(right.scheduledAt);
        if (byTime !== 0) {
            return byTime;
        }
        return left.id - right.id;
    });
}

const SCHEDULED_COLOR = 0x5865f2;
const POSTED_COLOR = 0x57f287;
const POSTED_LATE_COLOR = 0xf0b429;
const DELETED_COLOR = 0xed4245;

export function formatMessageId(id: number): string {
    return `ID ${id}`;
}

export function messageLink(
    announcement: Pick<Announcement, 'guildId' | 'channelId'>,
    messageId: string
): string {
    return `https://discord.com/channels/${announcement.guildId}/${announcement.channelId}/${messageId}`;
}

export function recordEmbed(
    announcement: Announcement,
    late = false,
    deleted = false
): AnnouncementEmbed {
    const scheduled = announcement.status === 'pending' && !deleted;
    const clock = formatClock(
        new Date(announcement.scheduledAt),
        announcement.timezone
    );
    const fields: AnnouncementEmbed['fields'] = [
        {
            name: 'Status',
            value: deleted
                ? '**Deleted**'
                : scheduled
                  ? '**Scheduled**'
                  : late
                    ? '**Posted late**'
                    : '**Posted**',
            inline: true,
        },
        { name: 'Sends', value: clock, inline: true },
        {
            name: 'Channel',
            value: `<#${announcement.channelId}>`,
            inline: true,
        },
    ];
    if (!scheduled && !deleted && announcement.sentMessageId) {
        fields.push({
            name: 'Link',
            value: `[jump to message](${messageLink(announcement, announcement.sentMessageId)})`,
            inline: false,
        });
    }
    return {
        title: `ID: ${announcement.id}`,
        authorName: '',
        description:
            announcement.message.length > 0 ? announcement.message : '\u200b',
        fields,
        footer: '',
        color: deleted
            ? DELETED_COLOR
            : scheduled
              ? SCHEDULED_COLOR
              : late
                ? POSTED_LATE_COLOR
                : POSTED_COLOR,
    };
}

export function deletedBoardMessage(announcement: Announcement): BoardMessage {
    return {
        content: '',
        embed: recordEmbed(announcement, false, true),
    };
}

export function postedBoardMessage(
    announcement: Announcement,
    messageId: string,
    late: boolean
): BoardMessage {
    return {
        content: '',
        embed: recordEmbed(
            { ...announcement, status: 'sent', sentMessageId: messageId },
            late
        ),
    };
}

const MAX_EMBEDS_PER_MESSAGE = 10;
const MAX_EMBED_CHARS_PER_MESSAGE = 6000;

export function embedCharCount(announcement: Announcement): number {
    const card = boardCard(announcement).embed;
    const fields = card.fields.reduce(
        (sum, field) => sum + field.name.length + field.value.length,
        0
    );
    return (
        card.title.length +
        card.description.length +
        card.authorName.length +
        card.footer.length +
        fields
    );
}

export function packBoardGroups(announcements: Announcement[]): Announcement[][] {
    const groups: Announcement[][] = [];
    let current: Announcement[] = [];
    let chars = 0;
    for (const announcement of announcements) {
        const size = embedCharCount(announcement);
        const full =
            current.length >= MAX_EMBEDS_PER_MESSAGE ||
            (current.length > 0 && chars + size > MAX_EMBED_CHARS_PER_MESSAGE);
        if (full) {
            groups.push(current);
            current = [];
            chars = 0;
        }
        current.push(announcement);
        chars += size;
    }
    if (current.length > 0) {
        groups.push(current);
    }
    return groups;
}

function postedLate(announcement: Announcement): boolean {
    if (!announcement.sentAt) {
        return false;
    }
    return (
        Date.parse(announcement.sentAt) - Date.parse(announcement.scheduledAt) >
        60_000
    );
}

function boardCard(announcement: Announcement): BoardMessage {
    if (announcement.status === 'sent' && announcement.sentMessageId) {
        return postedBoardMessage(
            announcement,
            announcement.sentMessageId,
            postedLate(announcement)
        );
    }
    return waitingBoardMessage(announcement);
}

export function waitingBoardMessage(announcement: Announcement): BoardMessage {
    return {
        content: '',
        embed: recordEmbed(announcement),
    };
}

export function isUnknownMessageError(error: unknown): boolean {
    return (
        typeof error === 'object' &&
        error !== null &&
        'code' in error &&
        (error as { code: unknown }).code === 10008
    );
}

function withBoardMessage(
    data: ScheduleFile,
    announcementId: number,
    boardMessageId: string | null
): ScheduleFile {
    return {
        ...data,
        announcements: data.announcements.map((announcement) =>
            announcement.id === announcementId
                ? { ...announcement, boardMessageId }
                : announcement
        ),
    };
}

async function deleteQuiet(channel: BoardChannel, id: string): Promise<void> {
    try {
        await channel.deleteMessage(id);
    } catch (error) {
        if (!isUnknownMessageError(error)) {
            throw error;
        }
    }
}

export async function syncBoardPosts(
    data: ScheduleFile,
    channel: BoardChannel,
    change: BoardChange
): Promise<ScheduleFile> {
    if (change.type === 'refresh') {
        const members = sortBySchedule(
            data.announcements.filter(
                (announcement) => announcement.boardMessageId === change.messageId
            )
        );
        if (members.length === 0) {
            await deleteQuiet(channel, change.messageId);
            return data;
        }
        if (packBoardGroups(members).length > 1) {
            return placeBoardInOrder(
                data,
                channel,
                new Set(members.map((announcement) => announcement.id))
            );
        }
        await channel.editMessage(change.messageId, members.map(boardCard));
        return data;
    }

    if (change.type === 'remove') {
        for (const id of change.messageIds) {
            await deleteQuiet(channel, id);
        }
        return {
            ...data,
            announcements: data.announcements.map((announcement) =>
                announcement.boardMessageId &&
                change.messageIds.includes(announcement.boardMessageId)
                    ? { ...announcement, boardMessageId: null }
                    : announcement
            ),
        };
    }

    let next = data;
    if (change.type === 'startup') {
        const owned = new Set(
            data.announcements
                .map((announcement) => announcement.boardMessageId)
                .filter((id): id is string => Boolean(id))
        );
        for (const id of data.boardMessageIds) {
            if (!owned.has(id)) {
                await deleteQuiet(channel, id);
            }
        }
        next = { ...next, boardMessageIds: [] };
    }

    return placeBoardInOrder(
        next,
        channel,
        change.type === 'upsert' ? new Set(change.ids) : new Set()
    );
}

function groupKey(announcements: Announcement[]): string {
    return announcements
        .map(
            (announcement) =>
                `${announcement.id}|${announcement.status}|${announcement.sentMessageId ?? ''}|${announcement.scheduledAt}|${announcement.channelId}|${announcement.timezone}|${announcement.message}`
        )
        .join('\n');
}

async function placeBoardInOrder(
    data: ScheduleFile,
    channel: BoardChannel,
    dirtyIds: Set<number>
): Promise<ScheduleFile> {
    const sorted = sortBySchedule(
        data.announcements.filter(
            (announcement) =>
                announcement.status === 'pending' ||
                (announcement.status === 'sent' &&
                    Boolean(announcement.boardMessageId) &&
                    Boolean(announcement.sentMessageId))
        )
    );
    const groups = packBoardGroups(sorted);
    const slots = [
        ...new Set(
            sorted
                .map((announcement) => announcement.boardMessageId)
                .filter((id): id is string => Boolean(id))
        ),
    ].sort((left, right) =>
        BigInt(left) < BigInt(right) ? -1 : left === right ? 0 : 1
    );
    const before = new Map<string, Announcement[]>();
    for (const slot of slots) {
        before.set(
            slot,
            sortBySchedule(
                sorted.filter((announcement) => announcement.boardMessageId === slot)
            )
        );
    }

    let next = data;
    const fresh = new Set<string>();
    while (slots.length < groups.length) {
        const group = groups[slots.length];
        const sent = await channel.send(group.map(boardCard));
        slots.push(sent.id);
        fresh.add(sent.id);
        before.set(sent.id, group);
        for (const announcement of group) {
            next = withBoardMessage(next, announcement.id, sent.id);
        }
    }

    for (let index = 0; index < groups.length; index += 1) {
        const group = groups[index];
        const slot = slots[index];
        if (fresh.has(slot)) {
            continue;
        }
        const current = before.get(slot) ?? [];
        const changed =
            groupKey(current) !== groupKey(group) ||
            group.some((announcement) => dirtyIds.has(announcement.id));
        if (!changed) {
            continue;
        }
        const cards = group.map(boardCard);
        try {
            await channel.editMessage(slot, cards);
        } catch (error) {
            if (!isUnknownMessageError(error)) {
                throw new BoardRebuildError(
                    error instanceof Error
                        ? error.message
                        : 'Could not edit a board message',
                    next.boardMessageIds,
                    next
                );
            }
            const sent = await channel.send(cards);
            slots[index] = sent.id;
        }
        for (const announcement of group) {
            next = withBoardMessage(next, announcement.id, slots[index]);
        }
    }

    while (slots.length > groups.length) {
        const extra = slots.pop();
        if (extra) {
            await deleteQuiet(channel, extra);
        }
    }

    const used = new Set(slots);
    return {
        ...next,
        announcements: next.announcements.map((announcement) =>
            announcement.status === 'pending' ||
            (announcement.boardMessageId && used.has(announcement.boardMessageId))
                ? announcement
                : { ...announcement, boardMessageId: null }
        ),
    };
}
