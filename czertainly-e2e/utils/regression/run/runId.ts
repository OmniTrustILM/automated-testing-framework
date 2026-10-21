/**
 * runId — the identity of one regression run, shared by the REG-* and the API-* configs.
 *
 * WHAT: the run id (`qa-reg-<yyyymmdd>-<hhmmss>-<4 random base36>`, UTC), the state directory outside the clone, the
 * per-run defaults both configs set before anything else is loaded, and the run lock.
 *
 * WHY: every object a run creates is named `<run id>-<suffix>` and recorded in one ledger, and the run-end teardown
 * deletes only what that run recorded. A minute-granular id let two runs started in the same minute (the nightly and
 * a manual run) share a prefix; the seconds plus a random suffix keep them apart. The adhoc defaults (`qa-reg-adhoc`,
 * and `qa-api-adhoc` of the API test template) exist only for a helper imported outside a config: a config
 * refuses them as a run id, and the teardown refuses to delete anything under either.
 *
 * Hand-set ids: REG_RUN_ID set by hand must match RUN_ID_FORMAT, unless REG_RUN_ID_REUSE=1 admits an
 * earlier run's id of another shape (`qa-reg-[a-z0-9-]+`); a hand-set id does NOT default API_DELETE_OWN to 1 (a reused
 * id keeps its objects unless API_DELETE_OWN=1 is given explicitly). `<state dir>/<run id>.lock` holds the runner's pid:
 * a second live run with the same id is refused; a lock whose pid is gone is taken over.
 *
 * HOW: `setRunEnvDefaults()` runs inside `prepareRun()` (run/prepareRun.ts), the first call of both configs. Playwright loads the
 * config in the runner and again in every worker; workers inherit the runner's environment, so the values decided
 * first win everywhere. This module imports nothing from the suite, so the config can call it before any helper reads
 * `REG_RUN_ID`.
 */
import * as crypto from 'crypto';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { parseFlag } from './flags';

export const DEFAULT_RUN_ID = 'qa-reg-adhoc';
/** The API test template's default (`API_RUN_ID ?? 'qa-api-adhoc'`). */
export const API_DEFAULT_RUN_ID = 'qa-api-adhoc';
export const DEFAULT_RUN_IDS: readonly string[] = [DEFAULT_RUN_ID, API_DEFAULT_RUN_ID];

/** Name prefixes of every object a regression or API run creates (the API template's `qa-api-` included). */
export const RUN_PREFIX_FAMILY = ['qa-reg-', 'qa-api-'] as const;

/** Format of a generated run id; a hand-set REG_RUN_ID must match it unless REG_RUN_ID_REUSE=1. */
export const RUN_ID_FORMAT = /^qa-reg-\d{8}-\d{6}-[0-9a-z]{4}$/;

/** What REG_RUN_ID_REUSE=1 admits besides RUN_ID_FORMAT: an earlier run's id (e.g. the minute-granular ones). */
const REUSABLE_RUN_ID = /^qa-reg-[0-9a-z][0-9a-z-]*$/;

export function newRunId(now: Date = new Date(), randomInt: (max: number) => number = crypto.randomInt): string {
    const iso = now.toISOString(); // 2026-10-13T19:20:31.123Z
    const date = iso.slice(0, 10).replace(/-/g, '');
    const time = iso.slice(11, 19).replace(/:/g, '');
    let suffix = '';
    for (let i = 0; i < 4; i++) suffix += randomInt(36).toString(36);
    return `qa-reg-${date}-${time}-${suffix}`;
}

export function currentRunId(env: NodeJS.ProcessEnv = process.env): string {
    return env.REG_RUN_ID || DEFAULT_RUN_ID;
}

/** True for either adhoc default. */
export function isDefaultRunId(runId: string = currentRunId()): boolean {
    return DEFAULT_RUN_IDS.includes(runId);
}

/** True when the name carries the prefix of any regression or API run (not only this one). */
export function hasRunFamilyPrefix(name: string | undefined): boolean {
    return !!name && RUN_PREFIX_FAMILY.some((p) => name.startsWith(p));
}

/** Run state, ledger, snapshots and the cleanup ledger: REG_STATE_DIR, else ~/.ilm-qa/regression-state (never the clone). */
export function regressionStateDir(env: NodeJS.ProcessEnv = process.env): string {
    return path.resolve(env.REG_STATE_DIR ?? path.join(os.homedir(), '.ilm-qa', 'regression-state'));
}

/** The "before" snapshot the `snapshot` project stores and the run-end teardown compares against. */
export function beforeSnapshotFile(runId: string = currentRunId(), env: NodeJS.ProcessEnv = process.env): string {
    return path.join(regressionStateDir(env), `${runId}.snapshot-before.json`);
}

/** Throws unless a hand-set run id is usable (RUN_ID_FORMAT, or REUSABLE_RUN_ID with REG_RUN_ID_REUSE=1; never adhoc). */
export function assertValidRunId(id: string, env: NodeJS.ProcessEnv = process.env): void {
    if (isDefaultRunId(id)) {
        throw new Error(`REG_RUN_ID=${id} is an adhoc default: a run under it could not tell its objects from anyone else's. Unset REG_RUN_ID.`);
    }
    if (RUN_ID_FORMAT.test(id)) return;
    const reuse = parseFlag(env.REG_RUN_ID_REUSE, 'REG_RUN_ID_REUSE', false);
    if (reuse && REUSABLE_RUN_ID.test(id)) return;
    throw new Error(
        `REG_RUN_ID "${id}" is not qa-reg-<yyyymmdd>-<hhmmss>-<4 base36>` +
            (reuse ? ' nor qa-reg-[a-z0-9-]+' : '; set REG_RUN_ID_REUSE=1 to reuse an earlier run id of another shape') + '.',
    );
}

/**
 * Sets, when unset:
 * - REG_RUN_ID: a new run id (one prefix and one ledger for both suites); a hand-set id is validated;
 * - API_RUN_ID: ALWAYS the same id (helpers generated from the API test template name objects with it, and
 *   ownership needs the ledger lines under REG_RUN_ID); a different hand-set value is overwritten;
 * - API_DELETE_OWN: `1` for a generated id (the run deletes its own objects at the end), `0` for a hand-set
 *   id (a reused id keeps its objects unless API_DELETE_OWN=1 is given); the value must parse as a switch;
 * - CLEANUP_LEDGER_FILE: the run's cleanup ledger in the state directory, outside the clone.
 */
export function setRunEnvDefaults(env: NodeJS.ProcessEnv = process.env): string {
    const handSet = !!env.REG_RUN_ID;
    if (handSet) assertValidRunId(env.REG_RUN_ID!, env);
    else env.REG_RUN_ID = newRunId();
    const id = env.REG_RUN_ID!;
    env.API_RUN_ID = id;
    if (env.API_DELETE_OWN === undefined) env.API_DELETE_OWN = handSet ? '0' : '1';
    parseFlag(env.API_DELETE_OWN, 'API_DELETE_OWN', true);
    env.CLEANUP_LEDGER_FILE ||= path.join(regressionStateDir(env), `${id}.cleanup.jsonl`);
    return id;
}

// ------------------------------------------------------------------ run lock

export function runLockFile(runId: string, env: NodeJS.ProcessEnv = process.env): string {
    return path.join(regressionStateDir(env), `${runId}.lock`);
}

/** Whether a process with this pid exists (EPERM: it exists but belongs to someone else). */
function pidAlive(pid: number): boolean {
    try {
        process.kill(pid, 0);
        return true;
    } catch (e) {
        return (e as NodeJS.ErrnoException).code === 'EPERM';
    }
}

/**
 * Takes `<state dir>/<run id>.lock` for `pid` (the Playwright runner). Re-entrant for the same pid; a lock whose pid
 * is gone is stale and taken over; a lock of a live process throws (a second live run with the same id).
 */
export function acquireRunLock(runId: string, env: NodeJS.ProcessEnv = process.env, pid: number = process.pid, alive: (pid: number) => boolean = pidAlive): string {
    const file = runLockFile(runId, env);
    fs.mkdirSync(path.dirname(file), { recursive: true });
    for (let attempt = 0; attempt < 3; attempt++) {
        try {
            fs.writeFileSync(file, `${pid}\n`, { flag: 'wx' });
            return file;
        } catch (e) {
            if ((e as NodeJS.ErrnoException).code !== 'EEXIST') throw e;
        }
        const holder = Number.parseInt(fs.readFileSync(file, 'utf8').trim(), 10);
        if (holder === pid) return file;
        if (Number.isInteger(holder) && holder > 0 && alive(holder)) {
            throw new Error(`run ${runId} is already in use by a live process (pid ${holder}, ${file}); ` +
                'two runs with one id would delete each other\'s objects. Wait for it, or use another REG_RUN_ID.');
        }
        fs.rmSync(file, { force: true }); // stale: its runner is gone
    }
    throw new Error(`could not take the run lock ${file}`);
}

/** Removes the lock when `pid` holds it (the runner at exit / at the end of the teardown). */
export function releaseRunLock(runId: string, env: NodeJS.ProcessEnv = process.env, pid: number = process.pid): void {
    const file = runLockFile(runId, env);
    try {
        if (Number.parseInt(fs.readFileSync(file, 'utf8').trim(), 10) === pid) fs.rmSync(file, { force: true });
    } catch {
        // no lock, nothing to release
    }
}
