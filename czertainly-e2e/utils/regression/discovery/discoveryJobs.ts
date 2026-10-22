/**
 * discoveryJobs — the one-time scheduled discovery of the run and its scheduler job.
 *
 * WHAT: Schedules an own discovery as a one-time scheduler job, reads the job and its history, lists the runs the job created and records them as own discoveries, and deletes the own job.
 * WHY: A schedule runs for everyone on the tier, so it is local-stack only and has its own helpers apart from the creates and reads of a plain discovery.
 * HOW: Every job and every run it creates is recorded in the ledger before the spec asserts on it; the delete passes the live own-object check.
 */

import { GuardedApi } from '../guard/types';
import { OwnRef, recordCreated, recordDeleted } from '../ledger/ledger';
import { ownName } from '../ledger/runState';
import { isOk, sendJson } from '../events/workflowRequests';
import { ApiAnswer } from '../apiReads';
import type { JsonObject } from '../json';
import { DiscoveryConnector, runDefinitions, Target, v1Attributes, v2Attributes, discoveryBody } from './discoveryApi';

export interface ScheduleOptions {
    suffix: string;
    /** Quartz cron, SECONDS first (6 or 7 fields), evaluated in UTC. */
    cron: string;
    oneTime: boolean;
    target: Target;
    jobName?: string;
}

export interface OwnJob extends OwnRef {
    /** The discovery name the job creates runs from (`<name>_<timestamp>`). */
    discoveryName: string;
}

/**
 * `POST /v1/discoveries/schedule` (PLATFORM_DENY: only `@local` with `localStack`): core validates the request like a create but
 * persists no discovery, registers the job (`DiscoveryCertificateTask`) and answers 201 with the job uuid. The job is recorded as a
 * `scheduledJobs` ledger line (id-named) before any assertion; the spec deletes its own job in `finally`.
 */
export async function scheduleDiscovery(api: GuardedApi, spec: string, c: DiscoveryConnector, o: ScheduleOptions): Promise<{ job: OwnJob; sent: ApiAnswer }> {
    const defs = await runDefinitions(api, c);
    const attributes = c.generation === 'v1' ? v1Attributes(defs, o.target) : v2Attributes(defs, o.target);
    const discoveryName = ownName(o.suffix);
    const jobName = o.jobName ?? ownName(`${o.suffix}-job`);
    const sent = await sendJson(api, 'POST', '/api/v1/discoveries/schedule', {
        jobName,
        cronExpression: o.cron,
        oneTime: o.oneTime,
        request: discoveryBody(c, discoveryName, attributes),
    });
    const uuid = sent.json?.uuid ?? /\/scheduler\/jobs\/([0-9a-f-]{36})/.exec(sent.headers.location ?? '')?.[1];
    if (!isOk(sent) || typeof uuid !== 'string') throw new Error(`POST /v1/discoveries/schedule → ${sent.status} ${sent.text.slice(0, 400)}`);
    const ref = recordCreated('scheduledJobs', { uuid, name: jobName }, { spec, note: `${c.generation} scheduled discovery (${o.oneTime ? 'one-time' : 'recurrent'}), own job` });
    return { job: { ...ref, discoveryName }, sent };
}

export async function getJob(api: GuardedApi, uuid: string): Promise<JsonObject> {
    const sent = await sendJson(api, 'GET', `/api/v1/scheduler/jobs/${uuid}`);
    if (sent.status !== 200) throw new Error(`GET scheduler job ${uuid} answered ${sent.status}`);
    return sent.json as JsonObject;
}

/** The execution history of a job (`started` / `succeeded` / `failed`), oldest first. */
export async function getJobHistory(api: GuardedApi, uuid: string): Promise<JsonObject[]> {
    const sent = await sendJson(api, 'GET', `/api/v1/scheduler/jobs/${uuid}/history?itemsPerPage=100&pageNumber=1`);
    if (sent.status !== 200) throw new Error(`GET scheduler job history ${uuid} answered ${sent.status}`);
    return [...((sent.json?.scheduledJobHistory ?? []) as JsonObject[])].sort((a, b) => Date.parse(a.startTime as string) - Date.parse(b.startTime as string));
}

/** Deletes an own job (a `@local` spec's `finally`); a 204 is recorded. A job that is executing refuses with 422. */
export async function deleteJob(api: GuardedApi, job: OwnRef, spec: string): Promise<ApiAnswer> {
    const sent = await sendJson(api, 'DELETE', `/api/v1/scheduler/jobs/${job.uuid}`);
    if (sent.status === 204 || sent.status === 200 || sent.status === 404) recordDeleted('scheduledJobs', job, spec, 'own scheduled job removed by its spec');
    return sent;
}

/** Runs created from a job: every discovery whose name starts with `<discoveryName>_` (a read). */
export async function runsOfJob(api: GuardedApi, discoveryName: string): Promise<JsonObject[]> {
    const sent = await sendJson(api, 'POST', '/api/v1/discoveries/list', {
        itemsPerPage: 100,
        pageNumber: 1,
        filters: [{ fieldSource: 'property', fieldIdentifier: 'DISCOVERY_NAME', condition: 'STARTS_WITH', value: `${discoveryName}_` }],
    });
    if (sent.status !== 200) throw new Error(`POST /v1/discoveries/list answered ${sent.status}`);
    return (sent.json?.discoveries ?? []) as JsonObject[];
}

/** Records the run a job created as an own discovery (its name carries the own prefix) before the spec asserts on it. */
export function adoptJobRun(run: JsonObject, spec: string): OwnRef {
    return recordCreated('discoveries', { uuid: String(run.uuid), name: String(run.name) }, { spec, note: 'run created by the own scheduled job' });
}
