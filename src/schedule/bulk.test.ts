import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { parseBulkDocument } from './bulk.js';

const now = new Date('2026-09-01T00:00:00.000Z');
const channels = [
    { id: '111111111111111111', name: 'announcements' },
    { id: '123456789012345678', name: 'general' },
];
const roles = [{ id: '999999999999999999', name: 'Organizers' }];

function parse(text: string, extras?: Partial<Parameters<typeof parseBulkDocument>[0]>) {
    return parseBulkDocument({
        text,
        channels,
        roles,
        timeZone: 'America/Los_Angeles',
        now,
        ...extras,
    });
}

describe('parseBulkDocument', () => {
    it('parses two blocks and resolves a channel name and a unique role', () => {
        const result = parse(`---
date: 2026-09-26
time: 18:00
channel: #announcements

Hello @Organizers
---
date: 2026-09-27
time: 09:00
channel: 123456789012345678

Second
`);
        assert.equal(result.ok, true);
        if (!result.ok) {
            return;
        }
        assert.equal(result.blocks.length, 2);
        assert.equal(result.blocks[0].channelId, '111111111111111111');
        assert.equal(result.blocks[0].message, 'Hello <@&999999999999999999>');
        assert.equal(
            result.blocks[0].scheduledAt.toISOString(),
            '2026-09-27T01:00:00.000Z'
        );
        assert.equal(result.blocks[1].channelId, '123456789012345678');
        assert.equal(result.blocks[1].message, 'Second');
    });

    it('reports a missing key with the block number', () => {
        const result = parse(`date: 2026-09-26
channel: #announcements

Hello
`);
        assert.equal(result.ok, false);
        if (result.ok) {
            return;
        }
        assert.equal(result.errors[0].block, 1);
        assert.match(result.errors[0].message, /time/);
    });

    it('reports a missing blank line', () => {
        const result = parse(`date: 2026-09-26
time: 18:00
channel: #announcements
Hello
`);
        assert.equal(result.ok, false);
        if (result.ok) {
            return;
        }
        assert.match(result.errors[0].message, /blank line/i);
    });

    it('rejects a body over 2000 characters', () => {
        const result = parse(`date: 2026-09-26
time: 18:00
channel: #announcements

${'a'.repeat(2001)}
`);
        assert.equal(result.ok, false);
        if (result.ok) {
            return;
        }
        assert.match(result.errors[0].message, /2000/);
    });

    it('rejects an unknown channel name', () => {
        const result = parse(`date: 2026-09-26
time: 18:00
channel: #missing

Hello
`);
        assert.equal(result.ok, false);
        if (result.ok) {
            return;
        }
        assert.match(result.errors[0].message, /channel id/i);
    });

    it('rejects an ambiguous channel name', () => {
        const result = parse(
            `date: 2026-09-26
time: 18:00
channel: #announcements

Hello
`,
            {
                channels: [
                    { id: '111111111111111111', name: 'announcements' },
                    { id: '222222222222222222', name: 'Announcements' },
                ],
            }
        );
        assert.equal(result.ok, false);
        if (result.ok) {
            return;
        }
        assert.match(result.errors[0].message, /channel id/i);
    });

    it('replaces the longer unique role name first', () => {
        const result = parse(
            `date: 2026-09-26
time: 18:00
channel: #announcements

@Org Lead and @nobody
`,
            {
                roles: [
                    { id: '888888888888888888', name: 'Org' },
                    { id: '777777777777777777', name: 'Org Lead' },
                ],
            }
        );
        assert.equal(result.ok, true);
        if (!result.ok) {
            return;
        }
        assert.equal(
            result.blocks[0].message,
            '<@&777777777777777777> and @nobody'
        );
    });

    it('rejects an ambiguous role mention', () => {
        const result = parse(
            `date: 2026-09-26
time: 18:00
channel: #announcements

@Organizers
`,
            {
                roles: [
                    { id: '999999999999999991', name: 'Organizers' },
                    { id: '999999999999999992', name: 'Organizers' },
                ],
            }
        );
        assert.equal(result.ok, false);
        if (result.ok) {
            return;
        }
        assert.match(result.errors[0].message, /<@&id>/);
    });

    it('rejects a document with no blocks', () => {
        const result = parse('---\n---\n');
        assert.equal(result.ok, false);
        if (result.ok) {
            return;
        }
        assert.match(result.errors[0].message, /no announcements/i);
    });
});
