/**
 * schedulerApi — the scheduler jobs API: the job list and detail, the six system jobs with their next fire time in UTC (a Quartz subset
 * implemented here), and on a proven local stack the cron update and delete of a job plus the `scheduledJobs` teardown handler.
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

export const SYSTEM_JOBS: readonly SystemJob[] = [
    { jobName: 'updateCertificateStatusJob', task: 'UpdateCertificateStatusTask', cron: '0 0 * ? * *' },
    { jobName: 'updateIntuneRevocationRequestsJob', task: 'UpdateIntuneRevocationRequestsTask', cron: '0 30 * ? * *' },
    { jobName: 'CbomSyncTask', task: 'CbomSyncTask', cron: '0 0 * ? * *' },
    { jobName: 'CbomReconcileTask', task: 'CbomReconcileTask', cron: '0 30 2 ? * SUN' },
    { jobName: 'CryptoAssetPqcSweepTask', task: 'CryptoAssetPqcSweepTask', cron: '0 30 * ? * *' },
    { jobName: 'CbomSyncSkipRetentionTask', task: 'CbomSyncSkipRetentionTask', cron: '0 15 3 ? * *' },
];

export const SYSTEM_JOB_NAMES: readonly string[] = SYSTEM_JOBS.map((j) => j.jobName);


export const JOBS_URL = '/api/v1/scheduler/jobs';

export async function listJobs(api: APIRequestContext): Promise<JsonObject[]> {
    const body = await apiJson<JsonObject>(api, 'GET', `${JOBS_URL}?itemsPerPage=100&pageNumber=1`);
    return Array.isArray(body) ? body : ((body.scheduledJobs ?? body.items ?? []) as JsonObject[]);
}

export const getJob = (api: APIRequestContext, uuid: string): Promise<JsonObject> => apiJson<JsonObject>(api, 'GET', `${JOBS_URL}/${uuid}`);

export const systemJobsOf = (jobs: JsonObject[]): JsonObject[] => jobs.filter((j) => j.system === true);


export const updateJobCron = (api: GuardedApi, uuid: string, cronExpression: string): Promise<APIResponse> => api.put(`${JOBS_URL}/${uuid}`, { data: { cronExpression } });

export const deleteJob = (api: GuardedApi, uuid: string): Promise<APIResponse> => api.delete(`${JOBS_URL}/${uuid}`);

/** The stored configuration of a job; scheduleState and nextFireTime move on their own as the scheduler runs. */
export const jobFingerprint = (job: JsonObject): JsonObject => ({
    jobName: job.jobName, cronExpression: job.cronExpression, enabled: job.enabled, system: job.system, oneTime: job.oneTime, jobType: job.jobType,
});


// Quartz numbers weekdays 1-7 from Sunday; getUTCDay counts 0-6.
const DOW: Record<string, number> = { SUN: 1, MON: 2, TUE: 3, WED: 4, THU: 5, FRI: 6, SAT: 7 };

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
        const end = m[2] ? num(m[2]) : m[3] ? max : start; // `0/15`: from 0 to the maximum, every 15
        const step = m[3] ? Number(m[3]) : 1;
        if ([start, end, step].some((n) => Number.isNaN(n)) || start < min || end > max || step < 1) throw new Error(`cron field "${raw}" is out of range`);
        for (let v = start; v <= end; v += step) values.add(v);
    }
    return { any: false, values };
}

function dayOfWeekField(raw: string): Field {
    const f = parseField(raw, 1, 7, DOW);
    return { any: f.any, values: new Set([...f.values].map((v) => v - 1)) };
}

export interface ParsedCron {
    second: Field;
    minute: Field;
    hour: Field;
    dayOfMonth: Field;
    month: Field;
    dayOfWeek: Field;
}

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
        dayOfWeek: dayOfWeekField(f[5]),
    };
}

const matches = (field: Field, v: number): boolean => field.any || field.values.has(v);

/** The next fire time of a Quartz cron strictly after `from`, in UTC (containers run on UTC), minute by minute, at most 400 days. */
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

export function isFireTime(cron: string, instant: Date): boolean {
    const c = parseQuartzCron(cron);
    return matches(c.second, instant.getUTCSeconds()) && matches(c.minute, instant.getUTCMinutes()) && matches(c.hour, instant.getUTCHours())
        && matches(c.dayOfMonth, instant.getUTCDate()) && matches(c.month, instant.getUTCMonth() + 1) && matches(c.dayOfWeek, instant.getUTCDay());
}

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


/**
 * `scheduledJobs` safety net for a spec that aborted before deleting its own job: reads the job, refuses a system job or a foreign name,
 * deletes it and proves absence; an executing job answers 422 and is reported, never forced.
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
