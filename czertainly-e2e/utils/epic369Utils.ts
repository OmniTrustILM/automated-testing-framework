/**
 * epic369Utils — API helpers of the Epic ilm#369 timeline tests (reminders for non-compliant certificates).
 * WHAT: create and remove the objects of one timeline (groups, custom attribute, compliance rule and profile, notification profiles,
 *       triggers, certificates), flip a certificate's compliance, and read what the product did: the test user's notifications of a
 *       certificate, its event history and the runs of the hourly certificate status job.
 * WHY: the reminders arrive in later runs of a scheduled job, so one spec seeds the objects and later specs find them again by name
 *      and read the outcome of each run; both sides need the same naming and the same readers.
 * HOW: every object is named `atf-e369-<TIMELINE_ID>-<what>`. A run of the job is a history entry of the job `updateCertificateStatusJob`;
 *      the notifications and event firings of a run are those between its start and the start of the next run.
 *      Platform answers that mean "the platform did not answer" (5xx, no connection) carry the prefix `TIMELINE-ENVIRONMENT:`.
 */

import { APIRequestContext } from '@playwright/test';
import { expect } from '@playwright/test';
import { Logger } from './Logger';
import { csrFromKey, newKeyMaterial } from './regression/pkiBuilders';
import { waitForCertificateState } from './certificateUtils';
import type { NotificationProfileDetail } from './notificationProfileUtils';

const logger = new Logger('Epic369Utils');

export const NOT_COMPLIANT_EVENT = 'certificate_not_compliant';
export const EXPIRING_EVENT = 'certificate_expiring';
export const STATUS_JOB_NAME = 'updateCertificateStatusJob';
const NAME_ROOT = 'atf-e369-';
export const STALE_AFTER_MS = 6 * 60 * 60 * 1000;

export const ENVIRONMENT = 'TIMELINE-ENVIRONMENT:';

export function timelineId(): string {
    const id = process.env.TIMELINE_ID;
    if (!id) throw new Error('TIMELINE_ID is not set: the Epic workflow sets it from its timelineId config');
    return id.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '');
}

/** Name prefix of all objects of one timeline. */
export const prefixOf = (id: string = timelineId()): string => `${NAME_ROOT}${id}-`;

/** The custom attribute name allows letters, digits and underscores only. */
export const attributeNameOf = (prefix: string): string => `${prefix.replace(/[^a-z0-9]+/gi, '_')}flag`;

type Json = any; // eslint-disable-line @typescript-eslint/no-explicit-any

export async function call(api: APIRequestContext, method: 'get' | 'post' | 'patch' | 'put' | 'delete', path: string, data?: unknown, okStatuses: number[] = []): Promise<Json> {
    let response;
    try {
        response = await api[method](`/api${path}`, data === undefined ? undefined : { data });
    } catch (e) {
        throw new Error(`${ENVIRONMENT} ${method.toUpperCase()} ${path} got no answer: ${String(e).slice(0, 200)}`);
    }
    const status = response.status();
    if (status >= 502 && status <= 504) throw new Error(`${ENVIRONMENT} ${method.toUpperCase()} ${path} answered ${status}`);
    if (!response.ok() && !okStatuses.includes(status)) {
        throw new Error(`${method.toUpperCase()} ${path} failed: ${status} - ${(await response.text()).slice(0, 500)}`);
    }
    const text = await response.text();
    if (!text) return undefined;
    try {
        return JSON.parse(text);
    } catch {
        return text;
    }
}

const time = (value: unknown): number => new Date(value as string | number).getTime();

// ---------------------------------------------------------------- creating the objects

export async function userUuidOf(api: APIRequestContext, username: string): Promise<string> {
    const users = (await call(api, 'get', '/v1/users')) as Array<{ uuid: string; username: string }>;
    const user = users.find((u) => u.username === username);
    if (!user) throw new Error(`The test user "${username}" is not in the user list`);
    return user.uuid;
}

export async function createGroup(api: APIRequestContext, name: string): Promise<string> {
    return (await call(api, 'post', '/v1/groups', { name, description: `atf epic 369 timeline, created ${new Date().toISOString()}` })).uuid;
}

export async function createNotificationProfile(
    api: APIRequestContext, name: string, userUuid: string, options: { frequency?: string; repetitions?: number } = {},
): Promise<string> {
    const profile = (await call(api, 'post', '/v1/notificationProfiles', {
        name, description: 'atf epic 369', recipientType: 'user', recipientUuids: [userUuid], internalNotification: true,
        ...(options.frequency ? { frequency: options.frequency } : {}),
        ...(options.repetitions ? { repetitions: options.repetitions } : {}),
    })) as NotificationProfileDetail;
    return profile.uuid;
}

/** An event trigger on `event` with one Send Notification action per profile, associated with the group (an association replaces the list). */
export async function createNotifyingTrigger(
    api: APIRequestContext, name: string, event: string, profileUuids: string[], groupUuid: string,
): Promise<string> {
    const actions: string[] = [];
    for (const [i, profileUuid] of profileUuids.entries()) {
        const execution = await call(api, 'post', '/v1/workflows/executions', {
            name: `${name}-ex${i}`, description: 'atf epic 369', type: 'sendNotification', resource: 'certificates',
            items: [{ notificationProfileUuid: profileUuid }],
        });
        const action = await call(api, 'post', '/v1/workflows/actions', {
            name: `${name}-ac${i}`, description: 'atf epic 369', resource: 'certificates', executionsUuids: [execution.uuid],
        });
        actions.push(action.uuid);
    }
    const trigger = await call(api, 'post', '/v1/workflows/triggers', {
        name, description: 'atf epic 369', type: 'event', resource: 'certificates', ignoreTrigger: false, event, rulesUuids: [], actionsUuids: actions,
    });
    await associateTriggers(api, event, groupUuid, [trigger.uuid]);
    return trigger.uuid;
}

export async function associateTriggers(api: APIRequestContext, event: string, groupUuid: string, triggerUuids: string[]): Promise<void> {
    await call(api, 'post', '/v1/workflows/events', { event, resource: 'groups', objectUuid: groupUuid, triggerUuids });
}

export interface ComplianceSetup { attributeUuid: string; attributeName: string; ruleUuid: string; profileUuid: string }

/** A custom attribute on certificates, an internal rule "attribute equals ok" and a compliance profile with that rule. */
export async function createComplianceSetup(api: APIRequestContext, prefix: string): Promise<ComplianceSetup> {
    const attributeName = attributeNameOf(prefix);
    const attribute = await call(api, 'post', '/v1/attributes/custom', {
        name: attributeName, label: `${prefix}flag`, contentType: 'string', resources: ['certificates'], description: 'atf epic 369',
        visible: true, required: false, readOnly: false, list: false,
    });
    const rule = await call(api, 'post', '/v2/complianceProfiles/rules', {
        name: `${prefix}rule`, description: 'atf epic 369', resource: 'certificates',
        conditionItems: [{ fieldSource: 'custom', fieldIdentifier: `${attributeName}|STRING`, operator: 'EQUALS', value: 'ok' }],
    });
    const profile = await call(api, 'post', '/v2/complianceProfiles', {
        name: `${prefix}compliance`, description: 'atf epic 369', internalRules: [rule.uuid], providerRules: [], customAttributes: [],
    });
    return { attributeUuid: attribute.uuid, attributeName, ruleUuid: rule.uuid, profileUuid: profile.uuid };
}

export async function associateComplianceProfile(api: APIRequestContext, profileUuid: string, raProfileUuid: string): Promise<void> {
    await call(api, 'patch', `/v2/complianceProfiles/${profileUuid}/associations/raProfiles/${raProfileUuid}`);
}

export async function issueCertificate(
    api: APIRequestContext, authorityUuid: string, raProfileUuid: string, commonName: string, groupUuid: string,
): Promise<string> {
    const csr = csrFromKey(newKeyMaterial().keys, commonName, { dns: [commonName], ip: [] });
    const issued = await call(api, 'post', `/v2/operations/authorities/${authorityUuid}/raProfiles/${raProfileUuid}/certificates`, {
        request: csr.derBase64, format: 'pkcs10', attributes: [], customAttributes: [],
    });
    await waitForCertificateState(api, issued.uuid, 'issued', 120_000);
    await setGroup(api, issued.uuid, groupUuid);
    return issued.uuid;
}

export async function setGroup(api: APIRequestContext, certUuid: string, groupUuid: string): Promise<void> {
    await call(api, 'patch', `/v1/certificates/${certUuid}`, { groupUuids: [groupUuid] });
}

export async function assignRaProfile(api: APIRequestContext, certUuid: string, raProfileUuid: string): Promise<void> {
    await call(api, 'patch', `/v1/certificates/${certUuid}`, { raProfileUuid });
}

/** The validation settings of an RA profile: a threshold longer than the certificate's validity makes its certificates expiring. */
export async function setExpiringThreshold(api: APIRequestContext, authorityUuid: string, raProfileUuid: string, days: number): Promise<void> {
    await call(api, 'patch', `/v1/authorities/${authorityUuid}/raProfiles/${raProfileUuid}/validation`, { enabled: true, frequency: 1, expiringThreshold: days });
}

export async function archiveCertificate(api: APIRequestContext, certUuid: string): Promise<void> {
    await call(api, 'patch', `/v1/certificates/${certUuid}/archive`);
}

// ---------------------------------------------------------------- reading certificates and compliance

export async function getCertificate(api: APIRequestContext, uuid: string): Promise<{ uuid: string; commonName: string; complianceStatus: string; validationStatus: string; archived?: boolean; state: string }> {
    return call(api, 'get', `/v1/certificates/${uuid}`);
}

/** The certificates of a timeline, archived ones too, by common name suffix: `{ c1: uuid, … }`. */
export async function findTimelineCertificates(api: APIRequestContext, prefix: string): Promise<Record<string, string>> {
    const body = await call(api, 'post', '/v1/certificates', {
        itemsPerPage: 100, pageNumber: 1, includeArchived: true,
        filters: [{ fieldSource: 'property', fieldIdentifier: 'COMMON_NAME', condition: 'STARTS_WITH', value: prefix }],
    });
    const found: Record<string, string> = {};
    for (const c of body.certificates as Array<{ uuid: string; commonName: string }>) found[c.commonName.slice(prefix.length)] = c.uuid;
    return found;
}

export async function setFlag(api: APIRequestContext, certUuid: string, attributeUuid: string, value: 'ok' | 'bad'): Promise<void> {
    await call(api, 'patch', `/v1/attributes/custom/resources/certificates/objects/${certUuid}/${attributeUuid}`, [{ contentType: 'string', data: value }]);
}

/** Sets the flag, runs the compliance check of this certificate only and waits for the status the rule gives. */
export async function makeCompliance(api: APIRequestContext, certUuid: string, attributeUuid: string, compliant: boolean): Promise<void> {
    await setFlag(api, certUuid, attributeUuid, compliant ? 'ok' : 'bad');
    await call(api, 'post', `/v2/compliance/certificates/${certUuid}`);
    await expect.poll(async () => (await getCertificate(api, certUuid)).complianceStatus, {
        message: `compliance status of ${certUuid} after the check of this certificate only`, timeout: 90_000, intervals: [2_000],
    }).toBe(compliant ? 'ok' : 'nok');
}

// ---------------------------------------------------------------- reading what the product did

export interface Notification { uuid: string; message: string; sentAt: number; targetObjectType?: string; targetObjectIdentification?: string[] }

/** All notifications of the logged-in user (newest pages first), with their time as a number. */
export async function listMyNotifications(api: APIRequestContext): Promise<Notification[]> {
    const all: Notification[] = [];
    for (let page = 1; page <= 100; page++) {
        const body = await call(api, 'get', `/v1/notifications?unread=false&pageNumber=${page}&itemsPerPage=100`);
        for (const n of body.items ?? []) all.push({ ...n, sentAt: time(n.sentAt) });
        if (page >= (body.totalPages ?? 1)) break;
    }
    return all;
}

export const notificationsOf = (all: Notification[], certUuid: string): Notification[] =>
    all.filter((n) => (n.targetObjectIdentification ?? []).includes(certUuid)).sort((a, b) => a.sentAt - b.sentAt);

export const isNotCompliant = (n: Notification): boolean => /not compliant/i.test(n.message);
export const isExpiring = (n: Notification): boolean => /expiring/i.test(n.message);

export interface Firing { event: string; triggeredAt: number }

export async function eventHistoryOf(api: APIRequestContext, certUuid: string): Promise<Firing[]> {
    const body = await call(api, 'get', `/v1/workflows/events/certificates/${certUuid}/history?pageNumber=1&itemsPerPage=100`);
    return (body.items ?? []).map((i: { event: string; triggeredAt: unknown }) => ({ event: i.event, triggeredAt: time(i.triggeredAt) }));
}

export interface JobRun { start: number; end?: number; status: string; message: string }

/** The runs of the hourly certificate status job, oldest first. */
export async function statusJobRuns(api: APIRequestContext): Promise<JobRun[]> {
    const jobs = await call(api, 'get', '/v1/scheduler/jobs?pageNumber=1&itemsPerPage=1000');
    const job = (jobs.scheduledJobs as Array<{ uuid: string; jobName: string }>).find((j) => j.jobName === STATUS_JOB_NAME);
    if (!job) throw new Error(`${ENVIRONMENT} the scheduler has no job ${STATUS_JOB_NAME}`);
    const history = await call(api, 'get', `/v1/scheduler/jobs/${job.uuid}/history?pageNumber=1&itemsPerPage=100`);
    return (history.scheduledJobHistory as Array<{ startTime: unknown; endTime?: unknown; status: string; resultMessage?: string }>)
        .map((h) => ({ start: time(h.startTime), end: h.endTime ? time(h.endTime) : undefined, status: h.status, message: h.resultMessage ?? '' }))
        .sort((a, b) => a.start - b.start);
}

/** The k-th run (1 = R1) that started after T0; a missing or unfinished run is the environment's, not the product's. */
export function runAfter(runs: JobRun[], t0: number, k: number): { run: JobRun; next?: JobRun } {
    const after = runs.filter((r) => r.start > t0);
    const run = after[k - 1];
    if (!run) throw new Error(`${ENVIRONMENT} run R${k} of ${STATUS_JOB_NAME} is not in its history (${after.length} run(s) after T0 ${new Date(t0).toISOString()}): the run was skipped`);
    if (!run.end) throw new Error(`${ENVIRONMENT} run R${k} of ${STATUS_JOB_NAME} has not finished`);
    return { run, next: after[k] };
}

/** Items whose time lies in [from, to): from a run's start up to the start of the next run. */
export const within = <T>(items: T[], at: (item: T) => number, from: number, to: number = Number.POSITIVE_INFINITY): T[] =>
    items.filter((i) => at(i) >= from && at(i) < to);

// ---------------------------------------------------------------- removing the objects

interface Named { uuid: string; name: string }

/** Removes everything of a timeline, in the order the objects depend on each other; each step is tried even when one before it failed. */
export async function cleanupTimeline(api: APIRequestContext, prefix: string): Promise<string[]> {
    const failures: string[] = [];
    const attempt = async (what: string, action: () => Promise<unknown>): Promise<void> => {
        try {
            await action();
        } catch (e) {
            failures.push(`${what}: ${String(e).slice(0, 300)}`);
        }
    };
    const own = <T extends Named>(items: T[]): T[] => items.filter((i) => i.name.startsWith(prefix));

    const groups = own((await call(api, 'get', '/v1/groups')) as Named[]);
    const certs = await findTimelineCertificates(api, prefix);
    const certUuids = Object.values(certs);

    // The test user's notifications about these certificates.
    await attempt('notifications', async () => {
        const mine = (await listMyNotifications(api)).filter((n) => (n.targetObjectIdentification ?? []).some((u) => certUuids.includes(u)));
        if (mine.length) await call(api, 'delete', '/v1/notifications', mine.map((n) => n.uuid));
    });
    for (const group of groups) {
        for (const event of [NOT_COMPLIANT_EVENT, EXPIRING_EVENT]) await attempt(`association ${group.name}`, () => associateTriggers(api, event, group.uuid, []));
    }
    for (const t of own((await call(api, 'get', '/v1/workflows/triggers')) as Named[])) await attempt(`trigger ${t.name}`, () => call(api, 'delete', `/v1/workflows/triggers/${t.uuid}`));
    for (const a of own((await call(api, 'get', '/v1/workflows/actions')) as Named[])) await attempt(`action ${a.name}`, () => call(api, 'delete', `/v1/workflows/actions/${a.uuid}`));
    for (const e of own((await call(api, 'get', '/v1/workflows/executions')) as Named[])) await attempt(`execution ${e.name}`, () => call(api, 'delete', `/v1/workflows/executions/${e.uuid}`));
    const profiles = (await call(api, 'get', '/v1/notificationProfiles?itemsPerPage=1000&pageNumber=1')).notificationProfiles as Named[];
    for (const p of own(profiles ?? [])) await attempt(`notification profile ${p.name}`, () => call(api, 'delete', `/v1/notificationProfiles/${p.uuid}`));
    for (const p of own((await call(api, 'get', '/v2/complianceProfiles')) as Named[])) {
        await attempt(`compliance profile ${p.name}`, () => call(api, 'delete', '/v2/complianceProfiles/force', [p.uuid]));
    }
    for (const r of own((await call(api, 'get', '/v2/complianceProfiles/rules')) as Named[])) await attempt(`rule ${r.name}`, () => call(api, 'delete', `/v2/complianceProfiles/rules/${r.uuid}`));
    const attributes = (await call(api, 'get', '/v1/attributes/custom')) as Named[];
    for (const a of attributes.filter((x) => x.name === attributeNameOf(prefix))) await attempt(`custom attribute ${a.name}`, () => call(api, 'delete', `/v1/attributes/custom/${a.uuid}`));
    for (const [suffix, uuid] of Object.entries(certs)) await attempt(`certificate ${suffix}`, () => call(api, 'delete', `/v1/certificates/${uuid}`, undefined, [404]));
    for (const g of groups) await attempt(`group ${g.name}`, () => call(api, 'delete', `/v1/groups/${g.uuid}`));
    if (failures.length) logger.warn(`Timeline ${prefix} was not removed completely:\n${failures.join('\n')}`);
    return failures;
}

/** Removes the leftovers of earlier timelines of this Epic: those older than 6 hours (their group names carry the prefix, the description the time). */
export async function cleanupStaleTimelines(api: APIRequestContext, ownPrefix: string): Promise<void> {
    const groups = (await call(api, 'get', '/v1/groups')) as Array<Named & { description?: string }>;
    const stale = new Set<string>();
    for (const g of groups) {
        const m = /^(atf-e369-.+-)g1$/.exec(g.name);
        const created = /created (\S+)/.exec(g.description ?? '');
        if (m && m[1] !== ownPrefix && created && Date.now() - time(created[1]) > STALE_AFTER_MS) stale.add(m[1]);
    }
    for (const prefix of stale) {
        logger.info(`Removing the leftovers of the earlier timeline ${prefix}`);
        await cleanupTimeline(api, prefix);
    }
}
