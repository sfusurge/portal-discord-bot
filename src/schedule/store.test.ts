import assert from 'node:assert/strict';
import { mkdtemp, readdir, readFile, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { describe, it } from 'node:test';
import {
    PENDING_CAP,
    ScheduleStore,
    addAnnouncement,
    emptySchedule,
    loadSchedule,
    removeAnnouncement,
    saveSchedule,
} from './store.js';

const input = {
    message: 'Hello',
    channelId: '123456789012345678',
    guildId: '223456789012345678',
    scheduledAt: new Date('2026-09-27T01:00:00.000Z'),
    timezone: 'America/Los_Angeles',
    createdById: '323456789012345678',
};

describe('schedule file', () => {
    it('round-trips through a temp file and leaves no temp file behind', async () => {
        const dir = await mkdtemp(path.join(tmpdir(), 'schedule-'));
        const filePath = path.join(dir, 'scheduled-announcements.json');
        const created = addAnnouncement(emptySchedule(), input);
        assert.equal(created.ok, true);
        if (!created.ok) {
            return;
        }

        await saveSchedule(filePath, created.data);
        const loaded = await loadSchedule(filePath);
        assert.deepEqual(loaded, created.data);

        const names = await readdir(dir);
        assert.equal(
            names.some((name) => name.endsWith('.tmp')),
            false
        );
        const raw = await readFile(filePath, 'utf8');
        assert.equal(raw.endsWith('\n'), true);
    });

    it('starts at id 1 when the file is missing', async () => {
        const dir = await mkdtemp(path.join(tmpdir(), 'schedule-'));
        const loaded = await loadSchedule(path.join(dir, 'missing.json'));
        assert.deepEqual(loaded, emptySchedule());
    });

    it('starts at id 1 when the file is blank', async () => {
        const dir = await mkdtemp(path.join(tmpdir(), 'schedule-'));
        const filePath = path.join(dir, 'blank.json');
        await writeFile(filePath, '');
        const loaded = await loadSchedule(filePath);
        assert.deepEqual(loaded, emptySchedule());
    });

    it('does not reuse an id after delete', () => {
        const first = addAnnouncement(emptySchedule(), input);
        assert.equal(first.ok, true);
        if (!first.ok) {
            return;
        }
        const second = addAnnouncement(first.data, {
            ...input,
            message: 'Second',
        });
        assert.equal(second.ok, true);
        if (!second.ok) {
            return;
        }
        const removed = removeAnnouncement(second.data, 2);
        assert.equal(removed.ok, true);
        if (!removed.ok) {
            return;
        }
        const third = addAnnouncement(removed.data, {
            ...input,
            message: 'Third',
        });
        assert.equal(third.ok, true);
        if (!third.ok) {
            return;
        }
        assert.equal(third.announcement.id, 3);
        assert.equal(third.data.nextId, 4);
    });

    it('rejects the 101st pending announcement', () => {
        let data = emptySchedule();
        for (let i = 0; i < PENDING_CAP; i += 1) {
            const created = addAnnouncement(data, {
                ...input,
                message: `m${i}`,
            });
            assert.equal(created.ok, true);
            if (!created.ok) {
                return;
            }
            data = created.data;
        }
        const overflow = addAnnouncement(data, input);
        assert.deepEqual(overflow, { ok: false, reason: 'full' });
        assert.equal(data.nextId, PENDING_CAP + 1);
    });

    it('keeps both creates when two updates run together', async () => {
        const dir = await mkdtemp(path.join(tmpdir(), 'schedule-'));
        const store = new ScheduleStore(path.join(dir, 'scheduled-announcements.json'));
        await Promise.all([
            store.update((data) => {
                const created = addAnnouncement(data, { ...input, message: 'a' });
                if (!created.ok) {
                    throw new Error('full');
                }
                return created.data;
            }),
            store.update((data) => {
                const created = addAnnouncement(data, { ...input, message: 'b' });
                if (!created.ok) {
                    throw new Error('full');
                }
                return created.data;
            }),
        ]);
        const data = await store.read();
        assert.deepEqual(
            data.announcements.map((announcement) => announcement.id),
            [1, 2]
        );
    });
});
