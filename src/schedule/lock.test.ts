import assert from 'node:assert/strict';
import { mkdtemp, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { describe, it } from 'node:test';
import { acquireProcessLock } from './lock.js';

describe('acquireProcessLock', () => {
    it('replaces a lock whose process is gone', async () => {
        const dir = await mkdtemp(path.join(tmpdir(), 'lock-'));
        const lockPath = path.join(dir, 'store.lock');
        await writeFile(lockPath, '999999\n', 'utf8');
        const release = await acquireProcessLock(lockPath);
        await release();
    });

    it('refuses a lock held by this process', async () => {
        const dir = await mkdtemp(path.join(tmpdir(), 'lock-'));
        const lockPath = path.join(dir, 'store.lock');
        const release = await acquireProcessLock(lockPath);
        await assert.rejects(acquireProcessLock(lockPath), /already locked/);
        await release();
    });
});
