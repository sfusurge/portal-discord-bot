import { DateTime } from 'luxon';

export const MAX_TIMEOUT_MS = 2_147_483_647;

const DATE_PATTERN = /^(\d{4})-(\d{2})-(\d{2})$/;
const TIME_PATTERN = /^([01]\d|2[0-3]):([0-5]\d)$/;

export type ParseDateTimeResult =
    | { ok: true; scheduledAt: Date }
    | { ok: false; reason: 'invalid' | 'nonexistent' | 'past' };

export function parseAnnouncementId(input: string): number | null {
    const match = /^(?:msg\s*)?(\d+)$/i.exec(input.trim());
    if (!match) {
        return null;
    }
    const id = Number(match[1]);
    if (!Number.isSafeInteger(id) || id < 1) {
        return null;
    }
    return id;
}

export function isValidTimeZone(timeZone: string): boolean {
    return DateTime.now().setZone(timeZone).isValid;
}

export function parseDateTime(args: {
    date: string;
    time: string;
    timeZone: string;
    now: Date;
}): ParseDateTimeResult {
    const dateMatch = DATE_PATTERN.exec(args.date.trim());
    const timeMatch = TIME_PATTERN.exec(args.time.trim());
    if (!dateMatch || !timeMatch || !isValidTimeZone(args.timeZone)) {
        return { ok: false, reason: 'invalid' };
    }

    const year = Number(dateMatch[1]);
    const month = Number(dateMatch[2]);
    const day = Number(dateMatch[3]);
    const hour = Number(timeMatch[1]);
    const minute = Number(timeMatch[2]);

    const dateOnly = DateTime.fromObject(
        { year, month, day },
        { zone: args.timeZone }
    );
    if (
        !dateOnly.isValid ||
        dateOnly.year !== year ||
        dateOnly.month !== month ||
        dateOnly.day !== day
    ) {
        return { ok: false, reason: 'invalid' };
    }

    const local = DateTime.fromObject(
        {
            year,
            month,
            day,
            hour,
            minute,
            second: 0,
            millisecond: 0,
        },
        { zone: args.timeZone }
    );
    if (
        !local.isValid ||
        local.year !== year ||
        local.month !== month ||
        local.day !== day ||
        local.hour !== hour ||
        local.minute !== minute
    ) {
        return { ok: false, reason: 'nonexistent' };
    }

    const scheduledAt = local.toUTC().toJSDate();
    if (scheduledAt.getTime() <= args.now.getTime()) {
        return { ok: false, reason: 'past' };
    }
    return { ok: true, scheduledAt };
}

export function formatClock(instant: Date, timeZone: string): string {
    return DateTime.fromJSDate(instant, { zone: 'utc' })
        .setZone(timeZone)
        .toFormat('ccc, LLL d, yyyy, h:mm a ZZZZ');
}

export function localDateAndTime(
    instant: Date,
    timeZone: string
): { date: string; time: string } {
    const local = DateTime.fromJSDate(instant, { zone: 'utc' }).setZone(timeZone);
    return {
        date: local.toFormat('yyyy-MM-dd'),
        time: local.toFormat('HH:mm'),
    };
}

export function nextDelayMs(scheduledAt: Date, now: Date): number {
    const delta = scheduledAt.getTime() - now.getTime();
    if (!Number.isFinite(delta) || delta <= 0) {
        return 0;
    }
    return Math.min(delta, MAX_TIMEOUT_MS);
}

export function announcementMessageError(message: string): string | null {
    if (message.trim().length === 0) {
        return 'Announcement text is empty.';
    }
    if (message.length > 2000) {
        return 'Announcement text is longer than 2000 characters.';
    }
    return null;
}
