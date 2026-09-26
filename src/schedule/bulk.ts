import { parseDateTime } from './time.js';

export interface BulkChannel {
    id: string;
    name: string;
}

export interface BulkRole {
    id: string;
    name: string;
}

export interface BulkBlock {
    date: string;
    time: string;
    channelId: string;
    message: string;
    scheduledAt: Date;
}

export interface BulkIssue {
    block: number;
    message: string;
}

const HEADER_KEYS = new Set(['date', 'time', 'channel']);
const BOUNDARY_AFTER = /[\s.,!?:;]/;

export function parseBulkDocument(args: {
    text: string;
    channels: BulkChannel[];
    roles: BulkRole[];
    timeZone: string;
    now: Date;
}): { ok: true; blocks: BulkBlock[] } | { ok: false; errors: BulkIssue[] } {
    const blocks = splitBlocks(args.text);
    if (blocks.length === 0) {
        return {
            ok: false,
            errors: [{ block: 1, message: 'Document has no announcements.' }],
        };
    }

    const errors: BulkIssue[] = [];
    const parsed: BulkBlock[] = [];
    blocks.forEach((block, index) => {
        const result = parseBlock(block, index + 1, args);
        if ('message' in result && !('channelId' in result)) {
            errors.push(result);
            return;
        }
        parsed.push(result as BulkBlock);
    });

    if (errors.length > 0) {
        return { ok: false, errors };
    }
    return { ok: true, blocks: parsed };
}

function splitBlocks(text: string): string[] {
    const lines = text.replace(/\r\n/g, '\n').replace(/\r/g, '\n').split('\n');
    const groups: string[][] = [[]];
    for (const line of lines) {
        if (/^---\s*$/.test(line)) {
            groups.push([]);
            continue;
        }
        groups[groups.length - 1].push(line);
    }
    return groups
        .map((group) => group.join('\n'))
        .filter((group) => group.trim().length > 0);
}

function parseBlock(
    block: string,
    blockNumber: number,
    args: {
        channels: BulkChannel[];
        roles: BulkRole[];
        timeZone: string;
        now: Date;
    }
): BulkBlock | BulkIssue {
    const lines = block.split('\n');
    const header: Record<string, string> = {};
    const seen = new Set<string>();
    let index = 0;
    let sawBlank = false;
    let headerError: string | null = null;

    for (; index < lines.length; index += 1) {
        const line = lines[index];
        if (line.length === 0) {
            sawBlank = true;
            index += 1;
            break;
        }
        const match = /^([a-z]+): (.*)$/.exec(line);
        if (!match) {
            headerError = 'Missing blank line between the header and the body.';
            break;
        }
        const key = match[1];
        if (!headerError && seen.has(key)) {
            headerError = `Duplicate key ${key}.`;
        }
        seen.add(key);
        if (!headerError && !HEADER_KEYS.has(key)) {
            headerError = `Unknown key ${key}.`;
        }
        header[key] = match[2];
    }

    if (headerError) {
        return { block: blockNumber, message: headerError };
    }
    if (!sawBlank) {
        return {
            block: blockNumber,
            message: 'Missing blank line between the header and the body.',
        };
    }

    for (const key of ['date', 'time', 'channel']) {
        if (!(key in header)) {
            return { block: blockNumber, message: `Missing ${key}.` };
        }
    }

    const bodyLines = lines.slice(index);
    if (bodyLines.length > 0 && bodyLines[bodyLines.length - 1] === '') {
        bodyLines.pop();
    }
    const message = bodyLines.join('\n');
    if (message.trim().length === 0) {
        return { block: blockNumber, message: 'Announcement text is empty.' };
    }
    if (message.length > 2000) {
        return {
            block: blockNumber,
            message: 'Announcement text is longer than 2000 characters.',
        };
    }

    const channel = resolveChannel(header.channel.trim(), args.channels);
    if (!channel.ok) {
        return { block: blockNumber, message: channel.message };
    }

    const when = parseDateTime({
        date: header.date.trim(),
        time: header.time.trim(),
        timeZone: args.timeZone,
        now: args.now,
    });
    if (!when.ok) {
        return {
            block: blockNumber,
            message: dateTimeMessage(when.reason, args.timeZone),
        };
    }

    const resolved = resolveRoles(message, args.roles);
    if (!resolved.ok) {
        return { block: blockNumber, message: resolved.message };
    }

    return {
        date: header.date.trim(),
        time: header.time.trim(),
        channelId: channel.id,
        message: resolved.message,
        scheduledAt: when.scheduledAt,
    };
}

function dateTimeMessage(
    reason: 'invalid' | 'nonexistent' | 'past',
    timeZone: string
): string {
    if (reason === 'past') {
        return 'That time is already past.';
    }
    if (reason === 'nonexistent') {
        return `That local time does not exist in ${timeZone}.`;
    }
    return 'Use a date like 2026-09-26 and a time like 18:00.';
}

function resolveChannel(
    value: string,
    channels: BulkChannel[]
): { ok: true; id: string } | { ok: false; message: string } {
    if (/^\d{17,20}$/.test(value)) {
        return { ok: true, id: value };
    }
    const name = value.replace(/^#/, '');
    const matches = channels.filter(
        (channel) => channel.name.toLowerCase() === name.toLowerCase()
    );
    if (matches.length === 1) {
        return { ok: true, id: matches[0].id };
    }
    if (matches.length === 0) {
        return {
            ok: false,
            message: `No channel named ${name}. Use the channel id.`,
        };
    }
    return {
        ok: false,
        message: `More than one channel is named ${name}. Use the channel id.`,
    };
}

function resolveRoles(
    body: string,
    roles: BulkRole[]
): { ok: true; message: string } | { ok: false; message: string } {
    const byName = new Map<string, BulkRole[]>();
    for (const role of roles) {
        const existing = byName.get(role.name) ?? [];
        existing.push(role);
        byName.set(role.name, existing);
    }

    for (const [name, matches] of byName) {
        if (name === 'everyone' || name === 'here' || matches.length < 2) {
            continue;
        }
        if (mentionAt(body, name) !== null) {
            return {
                ok: false,
                message: `Role @${name} is not unique. Use <@&id>.`,
            };
        }
    }

    const unique = [...byName.entries()]
        .filter(
            ([name, matches]) =>
                matches.length === 1 && name !== 'everyone' && name !== 'here'
        )
        .sort((left, right) => right[0].length - left[0].length);

    let message = body;
    for (const [name, matches] of unique) {
        message = replaceMentions(message, name, `<@&${matches[0].id}>`);
    }
    return { ok: true, message };
}

function replaceMentions(body: string, name: string, token: string): string {
    let result = '';
    let index = 0;
    while (index < body.length) {
        const found = mentionAt(body, name, index);
        if (found === null) {
            result += body.slice(index);
            break;
        }
        result += body.slice(index, found);
        result += token;
        index = found + 1 + name.length;
    }
    return result;
}

function mentionAt(body: string, name: string, from = 0): number | null {
    const needle = `@${name}`;
    let index = from;
    while (index < body.length) {
        const found = body.indexOf(needle, index);
        if (found === -1) {
            return null;
        }
        const beforeOk = found === 0 || /\s/.test(body[found - 1] ?? '');
        const after = body[found + needle.length];
        const afterOk = after === undefined || BOUNDARY_AFTER.test(after);
        if (beforeOk && afterOk) {
            return found;
        }
        index = found + 1;
    }
    return null;
}
