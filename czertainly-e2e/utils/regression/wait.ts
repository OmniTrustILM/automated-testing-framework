/**
 * wait — the one polling helper: specs wait on API state, never on a fixed
 * time; the sleep is private and the last one is cut to the deadline.
 */

export interface WaitOptions {
    timeoutMs?: number;
    intervalMs?: number;
    what?: string;
    /** How many reads or `done` checks in a row may throw before the error is raised (default 2); 0 raises the first error. */
    tolerateErrors?: number;
    attempts?: number;
}

export interface PollOptions extends WaitOptions {
    /**
     * `throw` (default): a wait that runs out raises an error naming `what`; `return`: returns the last value read so the caller can assert
     * on it (the last error is raised when every read or check threw).
     */
    onTimeout?: 'throw' | 'return';
}

const pause = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms));

export async function pollUntil<T>(read: () => Promise<T>, done: (value: T) => boolean, opts: WaitOptions): Promise<T>;
export async function pollUntil<T>(read: () => Promise<T>, done: (value: T) => boolean, opts: WaitOptions & { onTimeout: 'return' }): Promise<T>;
export async function pollUntil<T>(read: () => Promise<T>, done: (value: T) => boolean): Promise<T>;
export async function pollUntil<T>(read: () => Promise<T>, done: (value: T) => boolean, opts: PollOptions = {}): Promise<T> {
    const timeout = opts.timeoutMs ?? 90_000;
    const interval = opts.intervalMs ?? 2_000;
    const tolerated = opts.tolerateErrors ?? 2;
    const startedAt = Date.now();
    let last: T | undefined;
    let lastError: unknown;
    let succeeded = false;
    let failures = 0;
    let reads = 0;
    for (;;) {
        reads += 1;
        try {
            last = await read();
            const finished = done(last);
            succeeded = true;
            failures = 0;
            if (finished) return last;
        } catch (e) {
            failures += 1;
            lastError = e;
            if (failures > tolerated) throw e;
        }
        const left = timeout - (Date.now() - startedAt);
        if (left <= 0 || (opts.attempts !== undefined && reads >= opts.attempts)) {
            if (opts.onTimeout === 'return') {
                if (!succeeded && lastError !== undefined) throw lastError;
                return last as T;
            }
            throw new Error(`${opts.what ?? 'poll'}: not satisfied within ${timeout} ms; last ${JSON.stringify(last)?.slice(0, 600)}`);
        }
        await pause(Math.min(interval, left));
    }
}
