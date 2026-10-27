/**
 * wait — the one polling helper of the regression suite.
 *
 * Firings, issuance, deletes and stack starts are asynchronous, so a spec waits on API state, never on a fixed time. `pollUntil` reads the
 * state, tests it, and sleeps only between two reads (the last sleep is cut to the deadline). Its sleep is private: no other module needs a
 * bare delay.
 */

export interface WaitOptions {
    /** Give up after this long (default 90 s). */
    timeoutMs?: number;
    /** Time between two reads (default 2 s). */
    intervalMs?: number;
    /** What the wait is for, for the failure message. */
    what?: string;
    /**
     * How many reads or `done` checks in a row may throw before the error is raised (default 2: a poll right after a write
     * may see a 5xx once or twice). 0 raises the first error, which a fail-fast check needs.
     */
    tolerateErrors?: number;
    /** Stop after this many reads (the timeout still applies); for loops that count attempts instead of time. */
    attempts?: number;
}

export interface PollOptions extends WaitOptions {
    /**
     * `throw` (default): a wait that runs out raises an error that names `what` and the last value.
     * `return`: it returns the last value read (it did not satisfy `done`), so the caller can report the outcome in its own
     * assertion; when no read ever succeeded, the last error is raised instead.
     */
    onTimeout?: 'throw' | 'return';
}

const pause = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms));

/** Polls `read` until `done(value)` and returns that value; see `WaitOptions` and `PollOptions` for the failure and timeout rules. */
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
            succeeded = true;
            failures = 0;
            if (done(last)) return last;
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
        // The last pause is cut to the deadline, so the final read happens at the timeout, not after it.
        await pause(Math.min(interval, left));
    }
}
