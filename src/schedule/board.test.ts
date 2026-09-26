import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import {
    deletedBoardMessage,
    embedCharCount,
    packBoardGroups,
    sortBySchedule,
    syncBoardPosts,
    waitingBoardMessage,
    type BoardMessage,
} from './board.js';
import { addAnnouncement, emptySchedule, type Announcement } from './store.js';

function announcement(overrides: Partial<Announcement> = {}): Announcement {
    return {
        id: 4,
        message: 'Hello',
        channelId: '123456789012345678',
        guildId: '223456789012345678',
        scheduledAt: '2026-09-27T01:00:00.000Z',
        timezone: 'America/Los_Angeles',
        status: 'pending',
        createdById: '323456789012345678',
        sentMessageId: null,
        sentAt: null,
        sendFailureStreak: 0,
        boardMessageId: null,
        ...overrides,
    };
}

describe('waitingBoardMessage', () => {
    it('labels the card, the send time, the channel, and the announcement text separately', () => {
        const message = waitingBoardMessage(announcement());
        assert.equal(message.content, '');
        assert.equal(message.embed.title, 'ID: 4');
        assert.equal(message.embed.authorName, '');
        assert.equal(message.embed.description, 'Hello');
        assert.deepEqual(
            message.embed.fields.map((field) => field.name),
            ['Status', 'Sends', 'Channel']
        );
        assert.equal(
            message.embed.fields.find((field) => field.name === 'Sends')?.value,
            'Sat, Sep 26, 2026, 6:00 PM PDT'
        );
        assert.equal(
            message.embed.fields.find((field) => field.name === 'Status')?.value,
            '**Scheduled**'
        );
        assert.equal(message.embed.color, 0x5865f2);
        assert.equal(
            message.embed.fields.find((field) => field.name === 'Channel')?.value,
            '<#123456789012345678>'
        );
        assert.equal(message.embed.footer, '');
    });

    it('keeps a 2000-character announcement inside the one card', () => {
        const message = waitingBoardMessage(
            announcement({ message: 'a'.repeat(2000) })
        );
        assert.equal(message.embed.description, 'a'.repeat(2000));
    });
});

describe('deletedBoardMessage', () => {
    it('uses a deleted card with its own color', () => {
        const message = deletedBoardMessage(announcement());
        assert.equal(
            message.embed.fields.find((field) => field.name === 'Status')?.value,
            '**Deleted**'
        );
        assert.equal(message.embed.color, 0xed4245);
        assert.equal(message.embed.description, 'Hello');
        assert.equal(
            message.embed.fields.some((field) => field.name === 'Link'),
            false
        );
    });
});

describe('sortBySchedule', () => {
    it('orders by time and then id', () => {
        const items = [
            announcement({ id: 2, scheduledAt: '2026-09-28T01:00:00.000Z' }),
            announcement({ id: 3, scheduledAt: '2026-09-27T01:00:00.000Z' }),
            announcement({ id: 1, scheduledAt: '2026-09-27T01:00:00.000Z' }),
        ];
        assert.deepEqual(
            sortBySchedule(items).map((item) => item.id),
            [1, 3, 2]
        );
    });
});

describe('syncBoardPosts', () => {
    it('posts only cards that do not already exist', async () => {
        const later = addAnnouncement(emptySchedule(), {
            message: 'Later',
            channelId: '123456789012345678',
            guildId: '223456789012345678',
            scheduledAt: new Date('2026-09-28T01:00:00.000Z'),
            timezone: 'America/Los_Angeles',
            createdById: '323456789012345678',
        });
        assert.equal(later.ok, true);
        if (!later.ok) {
            return;
        }
        const sooner = addAnnouncement(later.data, {
            message: 'Sooner',
            channelId: '123456789012345678',
            guildId: '223456789012345678',
            scheduledAt: new Date('2026-09-27T01:00:00.000Z'),
            timezone: 'America/Los_Angeles',
            createdById: '323456789012345678',
        });
        assert.equal(sooner.ok, true);
        if (!sooner.ok) {
            return;
        }
        sooner.data.announcements[0].status = 'sent';
        sooner.data.boardMessageIds = ['gone', 'old'];

        const deleted: string[] = [];
        const sent: string[] = [];
        let nextId = 10;
        const updated = await syncBoardPosts(
            sooner.data,
            {
                async deleteMessage(id) {
                    deleted.push(id);
                    if (id === 'gone') {
                        const error = new Error('Unknown Message') as Error & {
                            code: number;
                        };
                        error.code = 10008;
                        throw error;
                    }
                },
                async send(cards) {
                    sent.push(cards.map((card) => card.embed.description).join('|'));
                    nextId += 1;
                    return { id: String(nextId) };
                },
                async editMessage() {
                    throw new Error('should not edit on startup');
                },
            },
            { type: 'startup' }
        );

        assert.deepEqual(deleted, ['gone', 'old']);
        assert.deepEqual(sent, ['Sooner']);
        assert.equal(
            updated.announcements.find((item) => item.message === 'Sooner')
                ?.boardMessageId,
            '11'
        );
        assert.deepEqual(updated.boardMessageIds, []);
    });

    it('edits the existing board message when an announcement is posted', async () => {
        const pending = announcement({
            id: 1,
            boardMessageId: '100',
            message: 'Stay',
            scheduledAt: '2026-09-27T02:00:00.000Z',
        });
        const posted = announcement({
            id: 2,
            boardMessageId: '100',
            message: 'Go',
            status: 'sent',
            scheduledAt: '2026-09-27T01:00:00.000Z',
            sentMessageId: '555',
            sentAt: '2026-09-27T01:00:01.000Z',
        });
        const edited: string[][] = [];
        const sent: string[] = [];
        await syncBoardPosts(
            { nextId: 3, boardMessageIds: [], announcements: [pending, posted] },
            {
                async deleteMessage() {
                    throw new Error('should not delete');
                },
                async send() {
                    sent.push('sent');
                    return { id: 'new' };
                },
                async editMessage(_id, cards) {
                    edited.push(
                        cards.map(
                            (card) =>
                                `${card.embed.description}:${card.embed.fields.find((field) => field.name === 'Status')?.value}`
                        )
                    );
                },
            },
            { type: 'refresh', messageId: '100' }
        );
        assert.deepEqual(edited, [['Go:**Posted**', 'Stay:**Scheduled**']]);
        assert.deepEqual(sent, []);
    });

    it('puts short announcements in one message and splits when the character budget is full', () => {
        const together = packBoardGroups([
            announcement({ id: 1, message: 'A' }),
            announcement({ id: 2, message: 'B' }),
        ]);
        assert.equal(together.length, 1);
        const apart = packBoardGroups([
            announcement({ id: 1, message: 'a'.repeat(2000) }),
            announcement({ id: 2, message: 'b'.repeat(2000) }),
            announcement({ id: 3, message: 'c'.repeat(2000) }),
        ]);
        assert.equal(apart.length, 2);
        assert.equal(apart[0].length, 2);
        const many = packBoardGroups(
            Array.from({ length: 11 }, (_, index) =>
                announcement({ id: index + 1, message: 'Hi' })
            )
        );
        assert.equal(many.length, 2);
        assert.equal(many[0].length, 10);
    });

    it('rewrites one packed message when the latest announcement becomes the next one', async () => {
        const announcements = [1, 2, 3].map((id) =>
            announcement({
                id,
                boardMessageId: '100',
                message: `Item ${id}`,
                scheduledAt: new Date(Date.UTC(2026, 8, 27, id, 0, 0)).toISOString(),
            })
        );
        announcements[2].scheduledAt = '2026-09-27T00:00:00.000Z';
        const edited: string[][] = [];
        const sent: string[] = [];
        await syncBoardPosts(
            { nextId: 4, boardMessageIds: [], announcements },
            {
                async deleteMessage() {
                    throw new Error('should not delete');
                },
                async send() {
                    sent.push('sent');
                    return { id: 'new' };
                },
                async editMessage(_id, cards) {
                    edited.push(cards.map((card) => card.embed.description));
                },
            },
            { type: 'upsert', ids: [3] }
        );
        assert.deepEqual(edited, [['Item 3', 'Item 1', 'Item 2']]);
        assert.deepEqual(sent, []);
    });

    it('splits a packed message when one card grows past the character budget', async () => {
        const fit = fullestBody(3);
        const slack = 6000 - embedCharCount(sized(1, fit)) * 3;
        const grown = fit + slack + 1;
        assert.ok(grown <= 2000);
        const announcements = [
            sized(1, fit, { boardMessageId: '100' }),
            sized(2, fit, { boardMessageId: '100' }),
            sized(3, grown, { boardMessageId: '100' }),
        ];
        assert.equal(packBoardGroups(announcements).length, 2);

        const board = trackBoard();
        await syncBoardPosts(
            { nextId: 4, boardMessageIds: [], announcements },
            board.channel,
            { type: 'upsert', ids: [3] }
        );

        assert.deepEqual(
            board.texts(),
            packBoardGroups(announcements).map((group) =>
                group.map((item) => item.message)
            )
        );
    });

    it('splits a packed message when a posted link no longer fits', async () => {
        const length = postedOverflowBody();
        const pending = [
            sized(1, length, { boardMessageId: '100' }),
            sized(2, length, { boardMessageId: '100' }),
        ];
        const posted = sized(3, length, {
            boardMessageId: '100',
            status: 'sent',
            sentMessageId: '555',
            sentAt: '2026-09-27T01:02:00.000Z',
        });
        const announcements = [...pending, posted];
        assert.equal(
            packBoardGroups([
                sized(1, length),
                sized(2, length),
                sized(3, length),
            ]).length,
            1
        );
        assert.equal(packBoardGroups(announcements).length, 2);

        const board = trackBoard();
        await syncBoardPosts(
            { nextId: 4, boardMessageIds: [], announcements },
            board.channel,
            { type: 'refresh', messageId: '100' }
        );

        const texts = board.texts();
        assert.deepEqual(
            texts,
            packBoardGroups(announcements).map((group) =>
                group.map((item) => item.message)
            )
        );
        const postedCard = [...board.messages.values()].flat().find(
            (card) =>
                card.embed.title === 'ID: 3' &&
                card.embed.description.length === length
        );
        assert.equal(
            postedCard?.embed.fields.find((field) => field.name === 'Status')?.value,
            '**Posted**'
        );
        assert.equal(texts[0]?.length, 2);
        assert.equal(texts[1]?.length, 1);
    });

    it('reflows the next full message when a card grows', async () => {
        const fit = fullestBody(3);
        const slack = 6000 - embedCharCount(sized(1, fit)) * 3;
        const announcements = [1, 2, 3, 4, 5, 6].map((id) =>
            sized(id, id === 1 ? fit + slack + 1 : fit, {
                boardMessageId: id <= 3 ? '100' : '200',
            })
        );
        assert.equal(packBoardGroups(announcements).length, 3);

        const board = trackBoard();
        await syncBoardPosts(
            { nextId: 7, boardMessageIds: [], announcements },
            board.channel,
            { type: 'upsert', ids: [1] }
        );

        assert.deepEqual(board.edits, ['100', '200']);
        assert.deepEqual(
            board.texts(),
            packBoardGroups(announcements).map((group) =>
                group.map((item) => item.message)
            )
        );
    });

    it('leaves an earlier full message untouched when a later card grows', async () => {
        const fit = fullestBody(3);
        const slack = 6000 - embedCharCount(sized(1, fit)) * 3;
        const announcements = [1, 2, 3, 4, 5, 6].map((id) =>
            sized(id, id === 6 ? fit + slack + 1 : fit, {
                boardMessageId: id <= 3 ? '100' : '200',
            })
        );

        const board = trackBoard();
        await syncBoardPosts(
            { nextId: 7, boardMessageIds: [], announcements },
            board.channel,
            { type: 'upsert', ids: [6] }
        );

        assert.deepEqual(board.edits, ['200']);
        assert.equal(board.messages.has('100'), false);
        assert.deepEqual(
            board.texts(),
            packBoardGroups(announcements)
                .slice(1)
                .map((group) => group.map((item) => item.message))
        );
    });

    it('pulls a later card up when a card shrinks and deletes the empty message', async () => {
        const fit = fullestBody(3);
        const announcements = [
            sized(1, fit, { boardMessageId: '100' }),
            sized(2, fit, { boardMessageId: '100' }),
            sized(3, fit, { boardMessageId: '200' }),
        ];
        assert.equal(packBoardGroups(announcements).length, 1);

        const deleted: string[] = [];
        const board = trackBoard({
            async deleteMessage(id) {
                deleted.push(id);
            },
        });
        await syncBoardPosts(
            { nextId: 4, boardMessageIds: [], announcements },
            board.channel,
            { type: 'upsert', ids: [3] }
        );

        assert.deepEqual(deleted, ['200']);
        assert.deepEqual(board.texts(), [
            announcements.map((item) => item.message),
        ]);
    });
});

function sized(
    id: number,
    length: number,
    overrides: Partial<Announcement> = {}
): Announcement {
    return announcement({
        id,
        message: 'x'.repeat(length),
        scheduledAt: new Date(Date.UTC(2026, 8, 27, 1, id, 0)).toISOString(),
        ...overrides,
    });
}

function fullestBody(count: number): number {
    let fit = 0;
    for (let length = 1; length <= 2000; length += 1) {
        if (embedCharCount(sized(1, length)) * count <= 6000) {
            fit = length;
        }
    }
    assert.ok(fit > 0 && fit < 2000);
    return fit;
}

function postedOverflowBody(): number {
    for (let length = 1; length <= 2000; length += 1) {
        const plain = embedCharCount(sized(1, length));
        const posted = embedCharCount(
            sized(1, length, {
                status: 'sent',
                sentMessageId: '555',
                sentAt: '2026-09-27T01:00:00.000Z',
            })
        );
        if (plain * 3 <= 6000 && plain * 2 + posted > 6000) {
            return length;
        }
    }
    assert.fail('expected a length where a posted link overflows three cards');
}

function payloadChars(cards: BoardMessage[]): number {
    return cards.reduce((sum, card) => {
        const fields = card.embed.fields.reduce(
            (fieldSum, field) => fieldSum + field.name.length + field.value.length,
            0
        );
        return (
            sum +
            card.embed.title.length +
            card.embed.description.length +
            card.embed.authorName.length +
            card.embed.footer.length +
            fields
        );
    }, 0);
}

function trackBoard(hooks: {
    deleteMessage?: (id: string) => Promise<void>;
} = {}) {
    const messages = new Map<string, BoardMessage[]>();
    const edits: string[] = [];
    let nextId = 300;
    const channel = {
        async deleteMessage(id: string) {
            messages.delete(id);
            await hooks.deleteMessage?.(id);
        },
        async send(cards: BoardMessage[]) {
            const chars = payloadChars(cards);
            assert.ok(
                cards.length <= 10 && chars <= 6000,
                `${cards.length} cards, ${chars} characters`
            );
            nextId += 1;
            const id = String(nextId);
            messages.set(id, cards);
            return { id };
        },
        async editMessage(id: string, cards: BoardMessage[]) {
            const chars = payloadChars(cards);
            assert.ok(
                cards.length <= 10 && chars <= 6000,
                `${cards.length} cards, ${chars} characters`
            );
            edits.push(id);
            messages.set(id, cards);
        },
    };
    return {
        channel,
        messages,
        edits,
        texts() {
            return [...messages.entries()]
                .sort((left, right) => Number(left[0]) - Number(right[0]))
                .map(([, cards]) => cards.map((card) => card.embed.description));
        },
    };
}
