/**
 * runId — the identity of one regression run, shared by the REG-* and API-* configs: the run id (`qa-reg-<yyyymmdd>-<hhmmss>-<4 base36>`),
 * the state directory outside the clone, the per-run defaults and the run lock. The adhoc ids are refused by a config and the teardown.
 */
import * as crypto from 'crypto';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { parseFlag } from './flags';
import { settings } from './settings';

export const DEFAULT_RUN_ID = 'qa-reg-adhoc';
export const API_DEFAULT_RUN_ID = 'qa-api-adhoc';
export const DEFAULT_RUN_IDS: readonly string[] = [DEFAULT_RUN_ID, API_DEFAULT_RUN_ID];

export const RUN_PREFIX_FAMILY = ['qa-reg-', 'qa-api-'] as const;

export const RUN_ID_FORMAT = /^qa-reg-\d{8}-\d{6}-[0-9a-z]{4}$/;

const REUSABLE_RUN_ID = /^qa-reg-[0-9a-z][0-9a-z-]*$/;

export function newRunId(now: Date = new Date(), randomInt: (max: number) => number = crypto.randomInt): string {
    const iso = now.toISOString();
    const date = iso.slice(0, 10).replace(/-/g, '');
    const time = iso.slice(11, 19).replace(/:/g, '');
    let suffix = '';
    for (let i = 0; i < 4; i++) suffix += randomInt(36).toString(36);
    return `qa-reg-${date}-${time}-${suffix}`;
}

export function currentRunId(env: NodeJS.ProcessEnv = process.env): string {
    return settings(env).runId ?? DEFAULT_RUN_ID;
}

export function isDefaultRunId(runId: string = currentRunId()): boolean {
    return DEFAULT_RUN_IDS.includes(runId);
}

export function hasRunFamilyPrefix(name: string | undefined): boolean {
    return !!name && RUN_PREFIX_FAMILY.some((p) => name.startsWith(p));
}

export function regressionStateDir(env: NodeJS.ProcessEnv = process.env): string {
    return path.resolve(settings(env).stateDir ?? path.join(os.homedir(), '.ilm-qa', 'regression-state'));
}

export function beforeSnapshotFile(runId: string = currentRunId(), env: NodeJS.ProcessEnv = process.env): string {
    return path.join(regressionStateDir(env), `${runId}.snapshot-before.json`);
}

export function assertValidRunId(id: string, env: NodeJS.ProcessEnv = process.env): void {
    if (isDefaultRunId(id)) {
        throw new Error(`REG_RUN_ID=${id} is an adhoc default: a run under it could not tell its objects from anyone else's. Unset REG_RUN_ID.`);
    }
    if (RUN_ID_FORMAT.test(id)) return;
    const reuse = parseFlag(settings(env).runIdReuse, 'REG_RUN_ID_REUSE', false);
    if (reuse && REUSABLE_RUN_ID.test(id)) return;
    throw new Error(
        `REG_RUN_ID "${id}" is not qa-reg-<yyyymmdd>-<hhmmss>-<4 base36>` +
            (reuse ? ' nor qa-reg-[a-z0-9-]+' : '; set REG_RUN_ID_REUSE=1 to reuse an earlier run id of another shape') + '.',
    );
}

/**
 * Sets when unset: REG_RUN_ID (a hand-set id is validated), API_RUN_ID (always the same id), API_DELETE_OWN (1 for a generated id, 0 for a
 * hand-set one), CLEANUP_LEDGER_FILE.
 */
export function setRunEnvDefaults(env: NodeJS.ProcessEnv = process.env): string {
    const handSet = !!settings(env).runId;
    if (handSet) assertValidRunId(settings(env).runId!, env);
    else env.REG_RUN_ID = newRunId();
    const id = env.REG_RUN_ID!;
    env.API_RUN_ID = id;
    if (settings(env).deleteOwn === undefined) env.API_DELETE_OWN = handSet ? '0' : '1';
    parseFlag(settings(env).deleteOwn, 'API_DELETE_OWN', true);
    env.CLEANUP_LEDGER_FILE ||= path.join(regressionStateDir(env), `${id}.cleanup.jsonl`);
    return id;
}

export function runLockFile(runId: string, env: NodeJS.ProcessEnv = process.env): string {
    return path.join(regressionStateDir(env), `${runId}.lock`);
}

function pidAlive(pid: number): boolean {
    try {
        process.kill(pid, 0);
        return true;
    } catch (e) {
        return (e as NodeJS.ErrnoException).code === 'EPERM';
    }
}

/** Takes `<state dir>/<run id>.lock` for `pid`; re-entrant for the same pid, a stale lock (pid gone) is taken over, a live one throws. */
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
        fs.rmSync(file, { force: true });
    }
    throw new Error(`could not take the run lock ${file}`);
}

export function releaseRunLock(runId: string, env: NodeJS.ProcessEnv = process.env, pid: number = process.pid): void {
    const file = runLockFile(runId, env);
    try {
        if (Number.parseInt(fs.readFileSync(file, 'utf8').trim(), 10) === pid) fs.rmSync(file, { force: true });
    } catch {
        // no lock, nothing to release
    }
}
