import { open, readFile, rm, writeFile } from 'node:fs/promises';

export async function acquireProcessLock(
    lockPath: string
): Promise<() => Promise<void>> {
    const payload = `${process.pid}\n`;
    try {
        const handle = await open(lockPath, 'wx');
        await handle.writeFile(payload);
        await handle.close();
    } catch (error) {
        if (!isAlreadyLocked(error)) {
            throw error;
        }
        const existing = await readLockPid(lockPath);
        if (existing !== null && isProcessAlive(existing)) {
            throw new Error(
                `Schedule store is already locked by process ${existing}`
            );
        }
        await writeFile(lockPath, payload, 'utf8');
    }

    return async () => {
        try {
            const current = await readLockPid(lockPath);
            if (current === process.pid) {
                await rm(lockPath, { force: true });
            }
        } catch {
            // The lock file is already gone.
        }
    };
}

async function readLockPid(lockPath: string): Promise<number | null> {
    const raw = (await readFile(lockPath, 'utf8')).trim();
    const pid = Number(raw);
    return Number.isInteger(pid) && pid > 0 ? pid : null;
}

function isAlreadyLocked(error: unknown): boolean {
    return (
        typeof error === 'object' &&
        error !== null &&
        'code' in error &&
        error.code === 'EEXIST'
    );
}

function isProcessAlive(pid: number): boolean {
    try {
        process.kill(pid, 0);
        return true;
    } catch (error) {
        // Windows denies signal 0 even when the process exists.
        return (
            typeof error === 'object' &&
            error !== null &&
            'code' in error &&
            error.code === 'EPERM'
        );
    }
}
