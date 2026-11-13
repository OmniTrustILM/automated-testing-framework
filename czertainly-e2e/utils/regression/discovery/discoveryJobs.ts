/**
 * discoveryJobs — the one-time scheduled discovery of the run and its scheduler job; local-stack only (a schedule runs for
 * everyone on the tier). Every job and run is recorded before the spec asserts on it.
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
    cron: string;
    oneTime: boolean;
    target: Target;
    jobName?: string;
}

export interface OwnJob extends OwnRef {
    discoveryName: string;
}

/**
 * `POST /v1/discoveries/schedule` (PLATFORM_DENY: `@local` with `localStack` only): registers the job and answers 201 with its uuid;
 * recorded as a `scheduledJobs` line, deleted in the spec's `finally`.
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

export async function getJobHistory(api: GuardedApi, uuid: string): Promise<JsonObject[]> {
    const sent = await sendJson(api, 'GET', `/api/v1/scheduler/jobs/${uuid}/history?itemsPerPage=100&pageNumber=1`);
    if (sent.status !== 200) throw new Error(`GET scheduler job history ${uuid} answered ${sent.status}`);
    return [...((sent.json?.scheduledJobHistory ?? []) as JsonObject[])].sort((a, b) => Date.parse(a.startTime as string) - Date.parse(b.startTime as string));
}

export async function deleteJob(api: GuardedApi, job: OwnRef, spec: string): Promise<ApiAnswer> {
    const sent = await sendJson(api, 'DELETE', `/api/v1/scheduler/jobs/${job.uuid}`);
    if (sent.status === 204 || sent.status === 200 || sent.status === 404) recordDeleted('scheduledJobs', job, spec, 'own scheduled job removed by its spec');
    return sent;
}

export async function runsOfJob(api: GuardedApi, discoveryName: string): Promise<JsonObject[]> {
    const sent = await sendJson(api, 'POST', '/api/v1/discoveries/list', {
        itemsPerPage: 100,
        pageNumber: 1,
        filters: [{ fieldSource: 'property', fieldIdentifier: 'DISCOVERY_NAME', condition: 'STARTS_WITH', value: `${discoveryName}_` }],
    });
    if (sent.status !== 200) throw new Error(`POST /v1/discoveries/list answered ${sent.status}`);
    return (sent.json?.discoveries ?? []) as JsonObject[];
}

export function adoptJobRun(run: JsonObject, spec: string): OwnRef {
    return recordCreated('discoveries', { uuid: String(run.uuid), name: String(run.name) }, { spec, note: 'run created by the own scheduled job' });
}
