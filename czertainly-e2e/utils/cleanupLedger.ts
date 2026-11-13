/**
 * cleanupLedger — collects objects the suite failed to delete, so a run that leaks is not green.
 * A file (one JSON object per line, appended), because specs run in worker processes and globalTeardown in the main one.
 * CLEANUP_LEDGER_FILE moves it; the REG-* and API-* configs point it at the run's state directory.
 */

import * as fs from 'fs';
import * as path from 'path';

const DEFAULT_LEDGER_FILE = path.resolve(__dirname, '..', '.smoke-cleanup.jsonl');

export function cleanupLedgerFile(): string {
    return process.env.CLEANUP_LEDGER_FILE ? path.resolve(process.env.CLEANUP_LEDGER_FILE) : DEFAULT_LEDGER_FILE;
}

export interface CleanupFailure {
    resource: string;
    uuid?: string;
    name?: string;
    status?: number;
    message: string;
    /** Set when an earlier object that blocks this one is still there (a cascade is one root cause, not three). */
    blockedBy?: string;
}

export function statusOf(error: unknown): number | undefined {
    const m = /\b(\d{3})\b\s*-/.exec(String(error));
    return m ? Number(m[1]) : undefined;
}

/** Whether the platform refused because something still references the object (core answers 422 naming the dependants). */
export function isDependencyRefusal(error: unknown): boolean {
    const text = String(error);
    return statusOf(error) === 422 && /dependent/i.test(text);
}

export function recordCleanupFailure(failure: CleanupFailure): void {
    const file = cleanupLedgerFile();
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.appendFileSync(file, `${JSON.stringify(failure)}\n`);
}

export function readCleanupFailures(): CleanupFailure[] {
    const file = cleanupLedgerFile();
    if (!fs.existsSync(file)) return [];
    return fs
        .readFileSync(file, 'utf-8')
        .split('\n')
        .filter((line) => line.trim().length > 0)
        .map((line) => JSON.parse(line) as CleanupFailure);
}

/** Rewrites the recorded failures through `update` (the run-end teardown's final pass), in the main process after the workers. */
export function rewriteCleanupFailures(update: (failures: CleanupFailure[]) => CleanupFailure[]): void {
    const next = update(readCleanupFailures());
    const file = cleanupLedgerFile();
    if (!next.length) {
        if (fs.existsSync(file)) fs.unlinkSync(file);
        return;
    }
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(file, next.map((f) => `${JSON.stringify(f)}\n`).join(''));
}

export function clearCleanupFailures(): void {
    const file = cleanupLedgerFile();
    if (fs.existsSync(file)) fs.unlinkSync(file);
}

function blockerOf(error: unknown): string | undefined {
    const b = (error as { blockedBy?: unknown } | null)?.blockedBy;
    return typeof b === 'string' && b ? b : undefined;
}

/** Runs a delete and records a failure instead of throwing. Retries once: deleting right after a change can lose a race. */
export async function attemptCleanup(
    describe: Omit<CleanupFailure, 'message' | 'status' | 'blockedBy'>,
    remove: () => Promise<unknown>,
    options: { blockedBy?: string; retryDelayMs?: number } = {},
): Promise<boolean> {
    const { blockedBy, retryDelayMs = 1500 } = options;
    try {
        await remove();
        return true;
    } catch (first) {
        await new Promise((resolve) => setTimeout(resolve, retryDelayMs));
        try {
            await remove();
            return true;
        } catch (second) {
            recordCleanupFailure({
                ...describe,
                status: statusOf(second),
                message: String(second),
                // An error that names its own blocker keeps it; a dependency refusal is a consequence only when something upstream failed.
                blockedBy: blockerOf(second) ?? (blockedBy && isDependencyRefusal(second) ? blockedBy : undefined),
            });
            return false;
        }
    }
}

export function formatCleanupReport(failures: CleanupFailure[]): string {
    const lines = failures.map((f) => {
        const identity = [f.uuid, f.name].filter(Boolean).join(' ');
        const status = f.status ? `status ${f.status}` : 'no status';
        const because = f.blockedBy ? ` — still referenced by ${f.blockedBy}, which could not be removed either` : '';
        // The full error text stays: "no status" alone hid the cause.
        const text = String(f.message ?? '').replace(/\s+/g, ' ').trim().slice(0, 1500);
        return `  ${f.resource.padEnd(14)} ${identity.padEnd(46)} ${status}${because}${text ? `\n      ${text}` : ''}`;
    });
    const roots = failures.filter((f) => !f.blockedBy).length;
    return [
        `${failures.length} object(s) could not be removed and remain in the environment` +
            (roots < failures.length ? ` (${roots} root cause(s), the rest follow from them)` : ''),
        ...lines,
    ].join('\n');
}
