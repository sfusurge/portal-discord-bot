import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import {
    MAX_TIMEOUT_MS,
    formatClock,
    nextDelayMs,
    parseAnnouncementId,
    parseDateTime,
} from './time.js';

const ZONE = 'America/Los_Angeles';

describe('parseAnnouncementId', () => {
    it('accepts a bare number', () => {
        assert.equal(parseAnnouncementId('1'), 1);
    });

    it('accepts msg with a space', () => {
        assert.equal(parseAnnouncementId('msg 1'), 1);
    });

    it('accepts msg without a space, any case', () => {
        assert.equal(parseAnnouncementId('MSG1'), 1);
    });

    it('rejects anything else', () => {
        assert.equal(parseAnnouncementId('msg'), null);
        assert.equal(parseAnnouncementId('message 1'), null);
        assert.equal(parseAnnouncementId('0'), null);
        assert.equal(parseAnnouncementId('1.5'), null);
    });
});

describe('parseDateTime', () => {
    const now = new Date('2026-09-01T00:00:00.000Z');

    it('reads a Pacific wall time as UTC', () => {
        const result = parseDateTime({
            date: '2026-09-26',
            time: '18:00',
            timeZone: ZONE,
            now,
        });
        assert.equal(result.ok, true);
        if (!result.ok) {
            return;
        }
        assert.equal(result.scheduledAt.toISOString(), '2026-09-27T01:00:00.000Z');
    });

    it('rejects strings that are not YYYY-MM-DD and HH:mm', () => {
        const result = parseDateTime({
            date: '09/26/2026',
            time: '6pm',
            timeZone: ZONE,
            now,
        });
        assert.deepEqual(result, { ok: false, reason: 'invalid' });
    });

    it('rejects a time that is already past', () => {
        const result = parseDateTime({
            date: '2026-09-26',
            time: '18:00',
            timeZone: ZONE,
            now: new Date('2026-09-27T01:00:00.000Z'),
        });
        assert.deepEqual(result, { ok: false, reason: 'past' });
    });

    it('rejects a spring-forward gap', () => {
        const result = parseDateTime({
            date: '2026-03-08',
            time: '02:30',
            timeZone: ZONE,
            now: new Date('2026-03-01T00:00:00.000Z'),
        });
        assert.deepEqual(result, { ok: false, reason: 'nonexistent' });
    });

    it('uses the earlier offset for a fall-back overlap', () => {
        const result = parseDateTime({
            date: '2026-11-01',
            time: '01:30',
            timeZone: ZONE,
            now: new Date('2026-10-01T00:00:00.000Z'),
        });
        assert.equal(result.ok, true);
        if (!result.ok) {
            return;
        }
        assert.equal(result.scheduledAt.toISOString(), '2026-11-01T08:30:00.000Z');
    });
});

describe('formatClock', () => {
    it('formats the instant in the given zone', () => {
        const clock = formatClock(
            new Date('2026-09-27T01:00:00.000Z'),
            ZONE
        );
        assert.equal(clock, 'Sat, Sep 26, 2026, 6:00 PM PDT');
    });
});

describe('nextDelayMs', () => {
    it('returns 0 when the instant is due', () => {
        const now = new Date('2026-09-27T01:00:00.000Z');
        assert.equal(nextDelayMs(now, now), 0);
    });

    it('caps a long wait at the setTimeout maximum', () => {
        const now = new Date('2026-01-01T00:00:00.000Z');
        const later = new Date(now.getTime() + 30 * 24 * 60 * 60 * 1000);
        assert.equal(nextDelayMs(later, now), MAX_TIMEOUT_MS);
    });
});
