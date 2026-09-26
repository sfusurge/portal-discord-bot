import assert from 'node:assert/strict';
import { mkdtemp } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { describe, it } from 'node:test';
import type { BoardMessage } from './board.js';
import {
    AnnouncementScheduler,
    delayUntilNext,
    deliverAnnouncement,
    dueAnnouncements,
} from './scheduler.js';
import {
    addAnnouncement,
    emptySchedule,
    ScheduleStore,
    type Announcement,
    type ScheduleFile,
} from './store.js';

function withPending(message: string, scheduledAt: string, idOverride?: Partial<Announcement>): ScheduleFile {
    const created = addAnnouncement(emptySchedule(), {
        message,
        channelId: '123456789012345678',
        guildId: '223456789012345678',
        scheduledAt: new Date(scheduledAt),
        timezone: 'America/Los_Angeles',
        createdById: '323456789012345678',
    });
    if (!created.ok) {
        throw new Error('expected create to succeed');
    }
    if (idOverride) {
        Object.assign(created.announcement, idOverride);
    }
    return created.data;
}

describe('dueAnnouncements', () => {
    it('returns pending items that are due and skips future and sent items', () => {
        const due = withPending('due', '2026-09-27T01:00:00.000Z');
        const future = addAnnouncement(due, {
            message: 'future',
            channelId: '123456789012345678',
            guildId: '223456789012345678',
            scheduledAt: new Date('2026-10-01T01:00:00.000Z'),
            timezone: 'America/Los_Angeles',
            createdById: '323456789012345678',
        });
        assert.equal(future.ok, true);
        if (!future.ok) {
            return;
        }
        const sent = addAnnouncement(future.data, {
            message: 'already sent',
            channelId: '123456789012345678',
            guildId: '223456789012345678',
            scheduledAt: new Date('2026-09-27T01:00:00.000Z'),
            timezone: 'America/Los_Angeles',
            createdById: '323456789012345678',
        });
        assert.equal(sent.ok, true);
        if (!sent.ok) {
            return;
        }
        sent.announcement.status = 'sent';
        const now = new Date('2026-09-27T01:00:00.000Z');
        assert.deepEqual(
            dueAnnouncements(sent.data, now).map((item) => item.message),
            ['due']
        );
    });
});

describe('delayUntilNext', () => {
    it('waits until the next future item, capped for long delays', () => {
        const data = withPending('later', '2026-03-01T00:00:00.000Z');
        const now = new Date('2026-01-01T00:00:00.000Z');
        assert.equal(delayUntilNext(data, now), 2_147_483_647);
    });

    it('retries a failed due item after 60 seconds', () => {
        const data = withPending('due', '2026-09-27T01:00:00.000Z');
        data.announcements[0].sendFailureStreak = 1;
        const now = new Date('2026-09-27T02:00:00.000Z');
        assert.equal(delayUntilNext(data, now), 60_000);
    });
});

describe('deliverAnnouncement', () => {
    it('marks a successful post sent and logs it', async () => {
        const data = withPending('Hello', '2026-09-27T01:00:00.000Z');
        const logs: Array<string | BoardMessage> = [];
        const result = await deliverAnnouncement({
            data,
            announcementId: 1,
            late: false,
            sentAt: new Date('2026-09-27T01:00:01.000Z'),
            ports: {
                async send() {
                    return { messageId: '555' };
                },
                async log(line) {
                    logs.push(line);
                },
            },
        });
        assert.equal(result.ok, true);
        if (!result.ok) {
            return;
        }
        assert.equal(result.data.announcements[0].status, 'sent');
        assert.equal(result.data.announcements[0].sentMessageId, '555');
        assert.equal(result.data.announcements[0].sendFailureStreak, 0);
        assert.deepEqual(logs, []);
    });

    it('logs a late startup send differently', async () => {
        const data = withPending('Hello', '2026-09-27T01:00:00.000Z');
        const logs: Array<string | BoardMessage> = [];
        await deliverAnnouncement({
            data,
            announcementId: 1,
            late: true,
            sentAt: new Date('2026-09-27T03:00:00.000Z'),
            ports: {
                async send() {
                    return { messageId: '555' };
                },
                async log(line) {
                    logs.push(line);
                },
            },
        });
        assert.deepEqual(logs, []);
    });

    it('logs the first failure only', async () => {
        const data = withPending('Hello', '2026-09-27T01:00:00.000Z');
        const logs: string[] = [];
        const ports = {
            async send(): Promise<{ messageId: string }> {
                throw new Error('Missing Permissions');
            },
            async log(line: string | BoardMessage) {
                logs.push(line);
            },
        };
        const first = await deliverAnnouncement({
            data,
            announcementId: 1,
            late: false,
            sentAt: new Date(),
            ports,
        });
        assert.equal(first.ok, false);
        if (first.ok) {
            return;
        }
        assert.equal(first.data.announcements[0].status, 'pending');
        assert.equal(first.data.announcements[0].sendFailureStreak, 1);
        const second = await deliverAnnouncement({
            data: first.data,
            announcementId: 1,
            late: true,
            sentAt: new Date(),
            ports,
        });
        assert.equal(second.ok, false);
        if (second.ok) {
            return;
        }
        assert.equal(second.data.announcements[0].sendFailureStreak, 2);
        assert.deepEqual(logs, [
            '# Failed\n**ID 1** → <#123456789012345678>\n-# Missing Permissions · retrying',
        ]);
    });
});

describe('schedule timing guards', () => {
    it('ignores a pending item whose time cannot be read', () => {
        const data = withPending('bad', '2026-09-27T01:00:00.000Z');
        data.announcements[0].scheduledAt = 'not-a-date';
        const now = new Date('2026-09-27T02:00:00.000Z');
        assert.deepEqual(dueAnnouncements(data, now), []);
        assert.equal(delayUntilNext(data, now), null);
    });
});

describe('AnnouncementScheduler', () => {
    it('saves a successful send when the board rebuild fails', async () => {
        const dir = await mkdtemp(path.join(tmpdir(), 'schedule-'));
        const store = new ScheduleStore(path.join(dir, 'queue.json'));
        const created = addAnnouncement(emptySchedule(), {
            message: 'Hello',
            channelId: '123456789012345678',
            guildId: '223456789012345678',
            scheduledAt: new Date('2026-09-27T01:00:00.000Z'),
            timezone: 'America/Los_Angeles',
            createdById: '323456789012345678',
        });
        if (!created.ok) {
            throw new Error('expected create to succeed');
        }
        await store.update(() => created.data);

        const scheduler = new AnnouncementScheduler(
            store,
            {
                async send() {
                    return { messageId: '999' };
                },
                async log() {
                    return undefined;
                },
                async rebuild() {
                    throw new Error('board down');
                },
            },
            () => new Date('2026-09-27T02:00:00.000Z')
        );
        await scheduler.start();
        scheduler.stop();

        const saved = await store.read();
        assert.equal(saved.announcements[0]?.status, 'sent');
        assert.equal(saved.announcements[0]?.sentMessageId, '999');
    });

    it('finish saving a send that is already in flight when stop is called', async () => {
        const dir = await mkdtemp(path.join(tmpdir(), 'schedule-'));
        const store = new ScheduleStore(path.join(dir, 'queue.json'));
        const created = addAnnouncement(emptySchedule(), {
            message: 'Hello',
            channelId: '123456789012345678',
            guildId: '223456789012345678',
            scheduledAt: new Date('2026-09-27T01:00:00.000Z'),
            timezone: 'America/Los_Angeles',
            createdById: '323456789012345678',
        });
        if (!created.ok) {
            throw new Error('expected create to succeed');
        }
        await store.update(() => created.data);

        let releaseSend: () => void = () => undefined;
        let markSendStarted: () => void = () => undefined;
        const sendGate = new Promise<void>((resolve) => {
            releaseSend = resolve;
        });
        const sendStarted = new Promise<void>((resolve) => {
            markSendStarted = resolve;
        });
        const scheduler = new AnnouncementScheduler(
            store,
            {
                async send() {
                    markSendStarted();
                    await sendGate;
                    return { messageId: '999' };
                },
                async log() {
                    return undefined;
                },
                async rebuild(current) {
                    return current;
                },
            },
            () => new Date('2026-09-27T02:00:00.000Z')
        );

        const started = scheduler.start();
        await sendStarted;
        let stopped = false;
        const stopping = scheduler.stop().then(() => {
            stopped = true;
        });
        await new Promise((resolve) => setTimeout(resolve, 20));
        assert.equal(stopped, false);
        releaseSend();
        await stopping;
        await started;
        const saved = await store.read();
        assert.equal(saved.announcements[0]?.status, 'sent');
        assert.equal(saved.announcements[0]?.sentMessageId, '999');
    });
});
