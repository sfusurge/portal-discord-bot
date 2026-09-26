import {
    formatMessageId,
    sortBySchedule,
    type BoardChange,
    type BoardMessage,
} from './board.js';
import { ScheduleStore, type Announcement, type ScheduleFile } from './store.js';
import { nextDelayMs } from './time.js';

export const RETRY_DELAY_MS = 60_000;

export interface DeliveryPorts {
    send(announcement: Announcement): Promise<{ messageId: string }>;
    log(entry: string | BoardMessage): Promise<void>;
}

function scheduledTimeMs(announcement: Announcement): number | null {
    const time = Date.parse(announcement.scheduledAt);
    return Number.isFinite(time) ? time : null;
}

export function dueAnnouncements(
    data: ScheduleFile,
    now: Date
): Announcement[] {
    return sortBySchedule(
        data.announcements.filter((item) => {
            const time = scheduledTimeMs(item);
            return (
                item.status === 'pending' &&
                time !== null &&
                time <= now.getTime()
            );
        })
    );
}

export function delayUntilNext(data: ScheduleFile, now: Date): number | null {
    const pending = sortBySchedule(
        data.announcements.filter(
            (item) =>
                item.status === 'pending' && scheduledTimeMs(item) !== null
        )
    );
    const next = pending[0];
    if (!next) {
        return null;
    }
    const when = scheduledTimeMs(next);
    if (when === null) {
        return null;
    }
    if (when <= now.getTime()) {
        return next.sendFailureStreak > 0 ? RETRY_DELAY_MS : 0;
    }
    return nextDelayMs(new Date(when), now);
}

export function failedLog(announcement: Announcement, reason: string): string {
    return `# Failed\n**${formatMessageId(announcement.id)}** → <#${announcement.channelId}>\n-# ${reason} · retrying`;
}

export async function deliverAnnouncement(args: {
    data: ScheduleFile;
    announcementId: number;
    late: boolean;
    sentAt: Date;
    ports: DeliveryPorts;
}): Promise<{ ok: boolean; data: ScheduleFile }> {
    const announcement = args.data.announcements.find(
        (item) => item.id === args.announcementId
    );
    if (!announcement || announcement.status !== 'pending') {
        return { ok: false, data: args.data };
    }

    let sent: { messageId: string };
    try {
        sent = await args.ports.send(announcement);
    } catch (error) {
        const streak = announcement.sendFailureStreak + 1;
        const data = replace(args.data, {
            ...announcement,
            sendFailureStreak: streak,
        });
        if (streak === 1) {
        const reason = (
            error instanceof Error ? error.message : 'Unknown error'
        ).slice(0, 500);
            await args.ports.log(failedLog(announcement, reason)).catch(() => undefined);
        }
        return { ok: false, data };
    }

    const data = replace(args.data, {
        ...announcement,
        status: 'sent',
        sentMessageId: sent.messageId,
        sentAt: args.sentAt.toISOString(),
        sendFailureStreak: 0,
    });
    return { ok: true, data };
}

export interface SchedulerPorts extends DeliveryPorts {
    rebuild(data: ScheduleFile, change: BoardChange): Promise<ScheduleFile>;
}

export class AnnouncementScheduler {
    private timer: ReturnType<typeof setTimeout> | null = null;
    private generation = 0;
    private delivering = false;
    private stopped = false;
    private drain: Promise<void> = Promise.resolve();
    private finishDrain: (() => void) | null = null;

    constructor(
        private readonly store: ScheduleStore,
        private readonly ports: SchedulerPorts,
        private readonly now: () => Date = () => new Date(),
        private readonly onError: (error: unknown) => void = () => undefined
    ) {}

    async stop(): Promise<void> {
        this.stopped = true;
        this.generation += 1;
        if (this.timer) {
            clearTimeout(this.timer);
            this.timer = null;
        }
        await this.drain;
    }

    private holdDrain(): void {
        if (this.finishDrain) {
            return;
        }
        this.drain = new Promise((resolve) => {
            this.finishDrain = resolve;
        });
    }

    private releaseDrain(): void {
        const finish = this.finishDrain;
        this.finishDrain = null;
        this.drain = Promise.resolve();
        finish?.();
    }

    arm(): void {
        this.generation += 1;
        const generation = this.generation;
        if (this.timer) {
            clearTimeout(this.timer);
            this.timer = null;
        }
        if (this.stopped) {
            return;
        }
        void this.store
            .read()
            .then((data) => {
                if (this.stopped || generation !== this.generation) {
                    return;
                }
                const delay = delayUntilNext(data, this.now());
                if (delay === null || !Number.isFinite(delay)) {
                    return;
                }
                this.timer = setTimeout(() => {
                    if (this.stopped || generation !== this.generation) {
                        return;
                    }
                    void this.onTimer();
                }, delay);
            })
            .catch((error: unknown) => this.onError(error));
    }

    async start(): Promise<void> {
        this.holdDrain();
        try {
            const snapshot = await this.store.read();
            const due = dueAnnouncements(snapshot, this.now());
            for (const item of due) {
                if (this.stopped) {
                    break;
                }
                try {
                    await this.deliverOne(item.id, true);
                } catch (error) {
                    this.onError(error);
                }
            }
            if (!this.stopped) {
                await this.rebuild({ type: 'startup' });
            }
        } finally {
            this.releaseDrain();
            if (!this.stopped) {
                this.arm();
            }
        }
    }

    private async onTimer(): Promise<void> {
        if (this.delivering || this.stopped) {
            return;
        }
        this.holdDrain();
        this.delivering = true;
        try {
            const snapshot = await this.store.read();
            const due = dueAnnouncements(snapshot, this.now());
            for (const item of due) {
                if (this.stopped) {
                    break;
                }
                try {
                    await this.deliverOne(item.id, false);
                } catch (error) {
                    this.onError(error);
                }
            }
        } catch (error) {
            this.onError(error);
        } finally {
            this.delivering = false;
            this.releaseDrain();
            if (!this.stopped) {
                this.arm();
            }
        }
    }

    private async deliverOne(id: number, startup: boolean): Promise<void> {
        let boardMessageId: string | null = null;
        await this.store.update(async (data) => {
            const current = data.announcements.find((entry) => entry.id === id);
            if (!current || current.status !== 'pending') {
                return data;
            }
            boardMessageId = current.boardMessageId;
            const result = await deliverAnnouncement({
                data,
                announcementId: id,
                late: startup || current.sendFailureStreak > 0,
                sentAt: this.now(),
                ports: this.ports,
            });
            return result.data;
        });
        if (!boardMessageId) {
            return;
        }
        const messageId = boardMessageId;
        try {
            await this.store.update((data) =>
                this.ports.rebuild(data, { type: 'refresh', messageId })
            );
        } catch (error) {
            this.onError(error);
        }
    }

    private async rebuild(change: BoardChange): Promise<void> {
        try {
            await this.store.update((data) => this.ports.rebuild(data, change));
        } catch (error) {
            this.onError(error);
        }
    }
}

function replace(data: ScheduleFile, announcement: Announcement): ScheduleFile {
    return {
        ...data,
        announcements: data.announcements.map((item) =>
            item.id === announcement.id ? announcement : item
        ),
    };
}
