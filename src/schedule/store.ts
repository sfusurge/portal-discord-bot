import { mkdir, readFile, rename, writeFile } from 'node:fs/promises';
import path from 'node:path';

export const PENDING_CAP = 100;

export interface Announcement {
    id: number;
    message: string;
    channelId: string;
    guildId: string;
    scheduledAt: string;
    timezone: string;
    status: 'pending' | 'sent';
    createdById: string;
    sentMessageId: string | null;
    sentAt: string | null;
    sendFailureStreak: number;
    boardMessageId: string | null;
}

export interface ScheduleFile {
    nextId: number;
    boardMessageIds: string[];
    announcements: Announcement[];
}

export interface NewAnnouncement {
    message: string;
    channelId: string;
    guildId: string;
    scheduledAt: Date;
    timezone: string;
    createdById: string;
}

export function emptySchedule(): ScheduleFile {
    return {
        nextId: 1,
        boardMessageIds: [],
        announcements: [],
    };
}

export function pendingCount(data: ScheduleFile): number {
    return data.announcements.filter((item) => item.status === 'pending').length;
}

export function addAnnouncement(
    data: ScheduleFile,
    input: NewAnnouncement
):
    | { ok: true; data: ScheduleFile; announcement: Announcement }
    | { ok: false; reason: 'full' } {
    if (pendingCount(data) >= PENDING_CAP) {
        return { ok: false, reason: 'full' };
    }

    const announcement: Announcement = {
        id: data.nextId,
        message: input.message,
        channelId: input.channelId,
        guildId: input.guildId,
        scheduledAt: input.scheduledAt.toISOString(),
        timezone: input.timezone,
        status: 'pending',
        createdById: input.createdById,
        sentMessageId: null,
        sentAt: null,
        sendFailureStreak: 0,
        boardMessageId: null,
    };

    return {
        ok: true,
        announcement,
        data: {
            ...data,
            nextId: data.nextId + 1,
            announcements: [...data.announcements, announcement],
        },
    };
}

export function removeAnnouncement(
    data: ScheduleFile,
    id: number
):
    | { ok: true; data: ScheduleFile; announcement: Announcement }
    | { ok: false; reason: 'missing' | 'sent' } {
    const announcement = data.announcements.find((item) => item.id === id);
    if (!announcement) {
        return { ok: false, reason: 'missing' };
    }
    if (announcement.status !== 'pending') {
        return { ok: false, reason: 'sent' };
    }
    return {
        ok: true,
        announcement,
        data: {
            ...data,
            announcements: data.announcements.filter((item) => item.id !== id),
        },
    };
}

export function replaceAnnouncement(
    data: ScheduleFile,
    announcement: Announcement
): ScheduleFile {
    return {
        ...data,
        announcements: data.announcements.map((item) =>
            item.id === announcement.id ? announcement : item
        ),
    };
}

function isScheduleFile(value: unknown): value is ScheduleFile {
    if (!value || typeof value !== 'object') {
        return false;
    }
    const record = value as Partial<ScheduleFile>;
    return (
        typeof record.nextId === 'number' &&
        Array.isArray(record.boardMessageIds) &&
        Array.isArray(record.announcements)
    );
}

export async function loadSchedule(filePath: string): Promise<ScheduleFile> {
    try {
        const raw = await readFile(filePath, 'utf8');
        if (raw.trim() === '') {
            return emptySchedule();
        }
        const parsed: unknown = JSON.parse(raw);
        if (!isScheduleFile(parsed)) {
            throw new Error(`Schedule file ${filePath} is not a schedule document`);
        }
        return {
            ...parsed,
            announcements: parsed.announcements.map((announcement) => ({
                ...announcement,
                boardMessageId:
                    typeof announcement.boardMessageId === 'string'
                        ? announcement.boardMessageId
                        : null,
            })),
        };
    } catch (error) {
        if (
            error &&
            typeof error === 'object' &&
            'code' in error &&
            error.code === 'ENOENT'
        ) {
            return emptySchedule();
        }
        throw error;
    }
}

export async function saveSchedule(
    filePath: string,
    data: ScheduleFile
): Promise<void> {
    await mkdir(path.dirname(filePath), { recursive: true });
    const tempPath = `${filePath}.${process.pid}.tmp`;
    const body = `${JSON.stringify(data, null, 2)}\n`;
    let lastError: unknown;
    for (let attempt = 0; attempt < 3; attempt += 1) {
        try {
            await writeFile(tempPath, body, 'utf8');
            await rename(tempPath, filePath);
            return;
        } catch (error) {
            lastError = error;
            await new Promise((resolve) => {
                setTimeout(resolve, 25 * (attempt + 1));
            });
        }
    }
    throw lastError;
}

export class ScheduleStore {
    private queue: Promise<void> = Promise.resolve();
    private data: ScheduleFile | null = null;

    constructor(private readonly filePath: string) {}

    async read(): Promise<ScheduleFile> {
        return this.enqueue(async () => structuredClone(await this.loaded()));
    }

    async update(
        mutator: (data: ScheduleFile) => Promise<ScheduleFile> | ScheduleFile
    ): Promise<ScheduleFile> {
        return this.enqueue(async () => {
            const current = await this.loaded();
            const next = await mutator(structuredClone(current));
            this.data = next;
            try {
                await saveSchedule(this.filePath, next);
            } catch (error) {
                // Keep the sent record in memory so a failed disk write
                // cannot cause the same Discord message to be posted again.
                throw error;
            }
            return structuredClone(next);
        });
    }

    private enqueue<T>(task: () => Promise<T>): Promise<T> {
        const run = this.queue.then(task, task);
        this.queue = run.then(
            () => undefined,
            () => undefined
        );
        return run;
    }

    private async loaded(): Promise<ScheduleFile> {
        if (!this.data) {
            this.data = await loadSchedule(this.filePath);
        }
        return this.data;
    }
}
