/**
 * schedulerApi — the scheduler jobs API: the job list and detail, the six system jobs and their next fire time in UTC
 * (a Quartz subset implemented here, no cron library), and on a proven local stack only the cron update and delete of
 * a job, plus the teardown handler for `scheduledJobs`.
 */
import type { APIRequestContext, APIResponse } from '@playwright/test';
import type { GuardedApi } from '../guard/types';
import { apiJson } from '../apiReads';
import type { TeardownHandler } from '../teardown/runTeardown';
import { deleteAndVerify } from '../teardown/teardownHandlers';
import type { JsonObject } from '../json';

export interface SystemJob {
    jobName: string;
    task: string;
    cron: string;
}

/** The six system jobs core registers at boot, with their Quartz crons in UTC. */
export const SYSTEM_JOBS: readonly SystemJob[] = [
    { jobName: 'updateCertificateStatusJob', task: 'UpdateCertificateStatusTask', cron: '0 0 * ? * *' },
    { jobName: 'updateIntuneRevocationRequestsJob', task: 'UpdateIntuneRevocationRequestsTask', cron: '0 30 * ? * *' },
    { jobName: 'CbomSyncTask', task: 'CbomSyncTask', cron: '0 0 * ? * *' },
    { jobName: 'CbomReconcileTask', task: 'CbomReconcileTask', cron: '0 30 2 ? * SUN' },
    { jobName: 'CryptoAssetPqcSweepTask', task: 'CryptoAssetPqcSweepTask', cron: '0 30 * ? * *' },
    { jobName: 'CbomSyncSkipRetentionTask', task: 'CbomSyncSkipRetentionTask', cron: '0 15 3 ? * *' },
];

export const SYSTEM_JOB_NAMES: readonly string[] = SYSTEM_JOBS.map((j) => j.jobName);

// ------------------------------------------------------------------ reads

export const JOBS_URL = '/api/v1/scheduler/jobs';

/** `GET /v1/scheduler/jobs` (paged envelope or a bare list: both shapes are read). */
export async function listJobs(api: APIRequestContext): Promise<JsonObject[]> {
    const body = await apiJson<JsonObject>(api, 'GET', `${JOBS_URL}?itemsPerPage=100&pageNumber=1`);
    return Array.isArray(body) ? body : ((body.scheduledJobs ?? body.items ?? []) as JsonObject[]);
}

export const getJob = (api: APIRequestContext, uuid: string): Promise<JsonObject> => apiJson<JsonObject>(api, 'GET', `${JOBS_URL}/${uuid}`);

/** The system jobs of a list (`system === true`). */
export const systemJobsOf = (jobs: JsonObject[]): JsonObject[] => jobs.filter((j) => j.system === true);

// ------------------------------------------------------------------ writes (@local)

/** `PUT /v1/scheduler/jobs/{uuid} { cronExpression }` — the raw response (422 `["Cannot updated system job."]` on a system job). */
export const updateJobCron = (api: GuardedApi, uuid: string, cronExpression: string): Promise<APIResponse> => api.put(`${JOBS_URL}/${uuid}`, { data: { cronExpression } });

/** `DELETE /v1/scheduler/jobs/{uuid}` — the raw response (422 `["Unable to delete system job."]` on a system job). */
export const deleteJob = (api: GuardedApi, uuid: string): Promise<APIResponse> => api.delete(`${JOBS_URL}/${uuid}`);

/** The fields of a job detail that must stay unchanged around a refused mutation. */
export const jobFingerprint = (job: JsonObject): JsonObject => ({
    cronExpression: job.cronExpression, enabled: job.enabled, scheduleState: job.scheduleState, nextFireTime: job.nextFireTime, system: job.system, oneTime: job.oneTime,
});

// ------------------------------------------------------------------ Quartz cron subset, UTC

const DOW: Record<string, number> = { SUN: 0, MON: 1, TUE: 2, WED: 3, THU: 4, FRI: 5, SAT: 6 };

interface Field {
    any: boolean;
    values: Set<number>;
}

function parseField(raw: string, min: number, max: number, names: Record<string, number> = {}): Field {
    const token = raw.trim().toUpperCase();
    if (token === '*' || token === '?') return { any: true, values: new Set() };
    const values = new Set<number>();
    for (const part of token.split(',')) {
        const m = /^([A-Z0-9]+)(?:-([A-Z0-9]+))?(?:\/(\d+))?$/.exec(part);
        if (!m) throw new Error(`unsupported cron field "${raw}" (the suite implements the subset the six system crons use)`);
        const num = (s: string) => (names[s] !== undefined ? names[s] : Number(s));
        const start = num(m[1]);
        const end = m[2] ? num(m[2]) : start;
        const step = m[3] ? Number(m[3]) : 1;
        if ([start, end, step].some((n) => Number.isNaN(n)) || start < min || end > max || step < 1) throw new Error(`cron field "${raw}" is out of range`);
        for (let v = start; v <= end; v += step) values.add(v);
    }
    return { any: false, values };
}

export interface ParsedCron {
    second: Field;
    minute: Field;
    hour: Field;
    dayOfMonth: Field;
    month: Field;
    dayOfWeek: Field;
}

/** Parses a Quartz cron (6 or 7 fields; the year field must be `*` when present). */
export function parseQuartzCron(cron: string): ParsedCron {
    const f = cron.trim().split(/\s+/);
    if (f.length < 6 || f.length > 7) throw new Error(`a Quartz cron has 6 or 7 fields: "${cron}"`);
    if (f.length === 7 && f[6] !== '*') throw new Error(`the year field must be * (got "${f[6]}")`);
    return {
        second: parseField(f[0], 0, 59),
        minute: parseField(f[1], 0, 59),
        hour: parseField(f[2], 0, 23),
        dayOfMonth: parseField(f[3], 1, 31),
        month: parseField(f[4], 1, 12),
        dayOfWeek: parseField(f[5], 0, 6, DOW),
    };
}

const matches = (field: Field, v: number): boolean => field.any || field.values.has(v);

/**
 * The next fire time of a Quartz cron strictly after `from`, in UTC (the scheduler sets no explicit zone and the
 * containers run on UTC; a scheduler on another zone fails the system-job test). Minute precision: scans forward
 * minute by minute (the six system crons fire at whole minutes), at most 400 days.
 */
export function nextFireUtc(cron: string, from: Date): Date {
    const c = parseQuartzCron(cron);
    const second = c.second.any ? 0 : Math.min(...c.second.values);
    const t = new Date(Date.UTC(from.getUTCFullYear(), from.getUTCMonth(), from.getUTCDate(), from.getUTCHours(), from.getUTCMinutes(), 0, 0));
    t.setUTCMinutes(t.getUTCMinutes() + 1);
    const limit = from.getTime() + 400 * 86_400_000;
    while (t.getTime() <= limit) {
        if (matches(c.minute, t.getUTCMinutes()) && matches(c.hour, t.getUTCHours()) && matches(c.dayOfMonth, t.getUTCDate())
            && matches(c.month, t.getUTCMonth() + 1) && matches(c.dayOfWeek, t.getUTCDay())) {
            const fire = new Date(t.getTime());
            fire.setUTCSeconds(second);
            if (fire.getTime() > from.getTime()) return fire;
        }
        t.setUTCMinutes(t.getUTCMinutes() + 1);
    }
    throw new Error(`no fire time within 400 days for "${cron}"`);
}

/** True when `instant` is a fire time of the cron (minute precision, UTC). */
export function isFireTime(cron: string, instant: Date): boolean {
    const c = parseQuartzCron(cron);
    return matches(c.second, instant.getUTCSeconds()) && matches(c.minute, instant.getUTCMinutes()) && matches(c.hour, instant.getUTCHours())
        && matches(c.dayOfMonth, instant.getUTCDate()) && matches(c.month, instant.getUTCMonth() + 1) && matches(c.dayOfWeek, instant.getUTCDay());
}

/** Problems of a system-job list against `SYSTEM_JOBS`: missing / extra system jobs, cron or flag mismatches. */
export function systemJobProblems(jobs: JsonObject[]): string[] {
    const problems: string[] = [];
    const system = systemJobsOf(jobs);
    const names = new Set(system.map((j) => String(j.jobName)));
    for (const expected of SYSTEM_JOBS) {
        const job = system.find((j) => String(j.jobName) === expected.jobName);
        if (!job) {
            problems.push(`system job ${expected.jobName} is missing`);
            continue;
        }
        if (String(job.cronExpression).trim() !== expected.cron) problems.push(`${expected.jobName}: cron "${job.cronExpression}" (expected "${expected.cron}")`);
        if (job.oneTime !== false) problems.push(`${expected.jobName}: oneTime ${String(job.oneTime)} (expected false)`);
        if (!job.jobType) problems.push(`${expected.jobName}: jobType is empty`);
    }
    for (const name of names) if (!SYSTEM_JOB_NAMES.includes(name)) problems.push(`unexpected system job ${name}`);
    return problems;
}

// ------------------------------------------------------------------ teardown handler (registry module `schedulerApi`)

/**
 * `scheduledJobs`: the registry's `scheduledJobs` entry loads this module. Only a
 * `@local` row with `localStack` can create a job (`POST /v1/discoveries/schedule`); the spec deletes its own job in `finally`
 * and writes the `deleted` line, so this handler is the safety net for a spec that aborted. An id-named ledger type has no live
 * name read in the guard, so the handler reads the job itself (200 → marked seen), refuses a system job or a job whose name is
 * not the ledger line's, deletes it and proves absence by the same GET. A job that is executing answers 422: reported, never forced.
 */
export const teardownHandlers: Record<string, TeardownHandler> = {
    scheduledJobs: {
        action: 'id-named; read the job (GET /scheduler/jobs/{uuid}), delete it (DELETE), absence proven by the same GET; an executing job refuses with 422 and is reported',
        async remove(ctx, line) {
            const detail = await ctx.api.get(`${JOBS_URL}/${line.uuid}`);
            if (detail.status() === 404) return; // already gone (the spec deleted it, or a one-time job completed)
            if (!detail.ok()) throw new Error(`scheduled job ${line.uuid}: route or object missing (GET answered ${detail.status()})`);
            const job = (await detail.json()) as JsonObject;
            if (job.system === true) throw new Error(`scheduled job ${line.uuid} is a system job: never deleted by the teardown`);
            if (line.name && String(job.jobName ?? '') !== line.name) {
                throw new Error(`scheduled job ${line.uuid}: its name is not the ledger line's name; not deleted`);
            }
            ctx.seen.add(line.uuid);
            await deleteAndVerify(ctx, { uuid: line.uuid, what: `scheduled job ${line.uuid}`, detailUrl: `${JOBS_URL}/${line.uuid}` });
        },
    },
};
