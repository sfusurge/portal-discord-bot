import assert from 'node:assert/strict';
import { mkdtemp } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import type { BoardMessage } from '../src/schedule/board.js';
import { syncBoardPosts } from '../src/schedule/board.js';
import { sortBySchedule } from '../src/schedule/board.js';
import {
    addAnnouncement,
    removeAnnouncement,
    ScheduleStore,
    type ScheduleFile,
} from '../src/schedule/store.js';

const COUNT = 80;

class FakeChannel {
    readonly messages = new Map<string, string[]>();
    sends = 0;
    edits = 0;
    deletes = 0;
    private nextId = 1_000;

    async deleteMessage(id: string): Promise<void> {
        this.deletes += 1;
        if (!this.messages.delete(id)) {
            const error = new Error('Unknown Message') as Error & { code: number };
            error.code = 10008;
            throw error;
        }
    }

    async send(cards: BoardMessage[]): Promise<{ id: string }> {
        this.sends += 1;
        const id = String(this.nextId);
        this.nextId += 1;
        this.messages.set(
            id,
            cards.map((card) => card.embed.title)
        );
        return { id };
    }

    async editMessage(id: string, cards: BoardMessage[]): Promise<void> {
        this.edits += 1;
        if (!this.messages.has(id)) {
            const error = new Error('Unknown Message') as Error & { code: number };
            error.code = 10008;
            throw error;
        }
        this.messages.set(
            id,
            cards.map((card) => card.embed.title)
        );
    }

    orderedIds(): number[] {
        return [...this.messages.entries()]
            .sort((left, right) => (BigInt(left[0]) < BigInt(right[0]) ? -1 : 1))
            .flatMap(([, titles]) => titles.map((title) => Number(title.slice(4))));
    }
}

function assertBoard(data: ScheduleFile, channel: FakeChannel): void {
    const pending = sortBySchedule(
        data.announcements.filter((announcement) => announcement.status === 'pending')
    );
    for (const announcement of pending) {
        assert.equal(typeof announcement.boardMessageId, 'string');
    }
    const seen = new Set<number>();
    for (const announcement of pending) {
        assert.equal(seen.has(announcement.id), false);
        seen.add(announcement.id);
    }
    assert.deepEqual(
        channel.orderedIds(),
        pending.map((announcement) => announcement.id)
    );
}

async function apply(
    data: ScheduleFile,
    channel: FakeChannel,
    change: Parameters<typeof syncBoardPosts>[2]
): Promise<ScheduleFile> {
    return syncBoardPosts(data, channel, change);
}

async function main(): Promise<void> {
    const dir = await mkdtemp(path.join(tmpdir(), 'stress-board-'));
    const store = new ScheduleStore(path.join(dir, 'queue.json'));
    const channel = new FakeChannel();
    const base = Date.parse('2026-10-01T18:00:00.000Z');

    let data = await store.read();
    for (let index = 0; index < COUNT; index += 1) {
        const created = addAnnouncement(data, {
            message: index % 5 === 0 ? 'x'.repeat(1999) : `Announcement ${index + 1}`,
            channelId: '880901619359809590',
            guildId: '880901619359809587',
            scheduledAt: new Date(base + index * 60_000),
            timezone: 'America/Los_Angeles',
            createdById: '1',
        });
        if (!created.ok) {
            throw new Error('queue filled before 80');
        }
        data = created.data;
    }
    data = await store.update(async () =>
        apply(data, channel, { type: 'startup' })
    );
    assertBoard(data, channel);
    const packedMessages = channel.messages.size;
    console.log(`Scheduled ${COUNT}. Board messages: ${packedMessages}. Sends: ${channel.sends}.`);
    assert.ok(packedMessages < COUNT);

    const sendsAfterCreate = channel.sends;
    const latest = sortBySchedule(
        data.announcements.filter((item) => item.status === 'pending')
    ).at(-1);
    if (!latest) {
        throw new Error('missing latest');
    }
    data = await store.update(async (current) => {
        const announcements = current.announcements.map((announcement) =>
            announcement.id === latest.id
                ? {
                      ...announcement,
                      scheduledAt: new Date(base - 60_000).toISOString(),
                  }
                : announcement
        );
        return apply(
            { ...current, announcements },
            channel,
            { type: 'upsert', ids: [latest.id] }
        );
    });
    assertBoard(data, channel);
    assert.equal(channel.sends, sendsAfterCreate);
    console.log(
        `Moved the last announcement to the front. Edits: ${channel.edits}. New sends: ${channel.sends - sendsAfterCreate}.`
    );

    const editsBeforeBurst = channel.edits;
    const pendingIds = data.announcements
        .filter((announcement) => announcement.status === 'pending')
        .map((announcement) => announcement.id);
    await Promise.all(
        pendingIds.slice(0, 30).map((id, index) =>
            store.update(async (current) => {
                const announcements = current.announcements.map((announcement) =>
                    announcement.id === id
                        ? { ...announcement, message: `Updated ${index} ${announcement.message}` }
                        : announcement
                );
                return apply(
                    { ...current, announcements },
                    channel,
                    { type: 'upsert', ids: [id] }
                );
            })
        )
    );
    data = await store.read();
    assertBoard(data, channel);
    console.log(
        `30 rapid text edits. Edits during burst: ${channel.edits - editsBeforeBurst}.`
    );

    const toDelete = sortBySchedule(
        data.announcements.filter((item) => item.status === 'pending')
    )
        .slice(10, 25)
        .map((announcement) => announcement.id);
    await Promise.all(
        toDelete.map((id) =>
            store.update(async (current) => {
                const removed = removeAnnouncement(current, id);
                if (!removed.ok) {
                    return current;
                }
                return apply(removed.data, channel, { type: 'upsert', ids: [] });
            })
        )
    );
    data = await store.read();
    assertBoard(data, channel);
    const remaining = data.announcements.filter(
        (announcement) => announcement.status === 'pending'
    ).length;
    console.log(
        `Deleted ${toDelete.length} from the middle. ${remaining} still scheduled. Board messages: ${channel.messages.size}.`
    );
    console.log(
        `Totals: ${channel.sends} sends, ${channel.edits} edits, ${channel.deletes} deletes.`
    );
}

main().catch((error: unknown) => {
    console.error(error);
    process.exit(1);
});
