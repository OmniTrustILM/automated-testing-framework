/**
 * cleanupLedger — collects objects the suite failed to delete, so a run that leaks is not green.
 *
 * WHAT: every place that tidies up after itself records its failures here instead of only
 * logging a warning. globalTeardown reads the ledger at the end of the run, prints one summary
 * naming each object left behind, and fails the run.
 *
 * WHY: cleanup failures used to be caught and logged as warnings, so a run that left a
 * certificate, an RA profile and an authority in the environment still reported `1 passed`.
 * Two things hid there: objects accumulating in a shared environment, and a 500 from the
 * platform, which is a defect worth seeing rather than a tidy-up detail.
 *
 * HOW: a file rather than a module-level array, because specs run in worker processes while
 * globalTeardown runs in the main one, and they do not share memory. One JSON object per line,
 * appended — appending avoids the read-modify-write race two workers would otherwise hit.
 *
 * A run started with SMOKE_PERSIST=true skips teardown altogether and is expected to leave its
 * fixtures behind, so nothing here applies to it.
 */

import * as fs from 'fs';
import * as path from 'path';

/** Sibling of .smoke-state.json, at czertainly-e2e/.smoke-cleanup.jsonl. */
const LEDGER_FILE = path.resolve(__dirname, '..', '.smoke-cleanup.jsonl');

export interface CleanupFailure {
    /** What could not be removed: 'certificate', 'raProfile', 'authority', 'connector', ... */
    resource: string;
    uuid?: string;
    name?: string;
    /** HTTP status the platform answered with, when one could be read off the error. */
    status?: number;
    message: string;
    /**
     * Set when this object could not be removed because an earlier one is still there. The
     * cascade is the common case — a certificate that will not delete keeps its RA profile,
     * which keeps its authority — and reporting three root causes for one problem is noise.
     */
    blockedBy?: string;
}

/** Pulls the status code out of the error text our API helpers raise ("... failed: 500 - ..."). */
export function statusOf(error: unknown): number | undefined {
    const m = /\b(\d{3})\b\s*-/.exec(String(error));
    return m ? Number(m[1]) : undefined;
}

/**
 * Whether the platform refused because something still references the object. Core answers 422
 * and names the dependants, which is what separates "still in use" from "genuinely broken".
 */
export function isDependencyRefusal(error: unknown): boolean {
    const text = String(error);
    return statusOf(error) === 422 && /dependent/i.test(text);
}

export function recordCleanupFailure(failure: CleanupFailure): void {
    fs.appendFileSync(LEDGER_FILE, `${JSON.stringify(failure)}\n`);
}

export function readCleanupFailures(): CleanupFailure[] {
    if (!fs.existsSync(LEDGER_FILE)) return [];
    return fs
        .readFileSync(LEDGER_FILE, 'utf-8')
        .split('\n')
        .filter((line) => line.trim().length > 0)
        .map((line) => JSON.parse(line) as CleanupFailure);
}

export function clearCleanupFailures(): void {
    if (fs.existsSync(LEDGER_FILE)) fs.unlinkSync(LEDGER_FILE);
}

/**
 * Runs a delete and records a failure instead of throwing, so one object that will not go away
 * does not stop the rest of the cleanup. Retries once: deleting an object immediately after the
 * operation that changed it — revoking a certificate, say — can lose a race the platform wins a
 * moment later, and a single retry separates that from a real refusal.
 */
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
                // A dependency refusal is only a consequence when something upstream actually failed.
                blockedBy: blockedBy && isDependencyRefusal(second) ? blockedBy : undefined,
            });
            return false;
        }
    }
}

/** One human-readable block naming everything left behind, ready to print and to throw. */
export function formatCleanupReport(failures: CleanupFailure[]): string {
    const lines = failures.map((f) => {
        const identity = [f.uuid, f.name].filter(Boolean).join(' ');
        const status = f.status ? `status ${f.status}` : 'no status';
        const because = f.blockedBy ? ` — still referenced by ${f.blockedBy}, which could not be removed either` : '';
        return `  ${f.resource.padEnd(14)} ${identity.padEnd(46)} ${status}${because}`;
    });
    const roots = failures.filter((f) => !f.blockedBy).length;
    return [
        `${failures.length} object(s) could not be removed and remain in the environment` +
            (roots < failures.length ? ` (${roots} root cause(s), the rest follow from them)` : ''),
        ...lines,
    ].join('\n');
}
