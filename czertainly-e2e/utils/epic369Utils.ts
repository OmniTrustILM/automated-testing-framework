/**
 * epic369Utils — API helpers of the Epic ilm#369 timeline: create, flip and remove its objects, read notifications, firings and job runs.
 * Own wrappers: the objects outlive one execution (regression mutations need its ledger), and `call` marks gateway errors as ENVIRONMENT.
 */

import { APIRequestContext } from '@playwright/test';
import { expect } from '@playwright/test';
import { Logger } from './Logger';
import { recordCleanupFailure } from './cleanupLedger';
import { csrFromKey, newKeyMaterial } from './regression/pkiBuilders';
import { waitForCertificateState } from './certificateUtils';
import { deleteKeyIfOrphaned, getCertificateKeyUuid } from './keyUtils';
import { objectOf } from './regression/json';
import { certificateCreationTime, keyAssociationsOf } from './regression/teardown/teardownHandlers';

const logger = new Logger('Epic369Utils');

export const NOT_COMPLIANT_EVENT = 'certificate_not_compliant';
export const EXPIRING_EVENT = 'certificate_expiring';
const STATUS_JOB_NAME = 'updateCertificateStatusJob';
const NAME_ROOT = 'atf-e369-';
const SMOKE_RA_PROFILE = 'smoke-raprofile-'; // global-setup's name for the RA profile of each execution
const STALE_AFTER_MS = 6 * 60 * 60 * 1000;

export const ENVIRONMENT = 'TIMELINE-ENVIRONMENT:';

/** The seed's certificates, by the suffix of their common name. */
export const TIMELINE_CERTIFICATES = ['reminded', 'twohourly', 'once', 'recovered', 'archived', 'expiring', 'everyrun', 'twoprofiles'];

/** Letters and digits only: a dash inside the id would let one timeline's prefix match another's objects. */
function timelineId(): string {
    const id = process.env.TIMELINE_ID;
    if (!id) throw new Error('TIMELINE_ID is not set: the Epic workflow sets it from its timelineId config');
    return id.toLowerCase().replace(/[^a-z0-9]+/g, '');
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
    })) as { uuid: string };
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

async function associateTriggers(api: APIRequestContext, event: string, groupUuid: string, triggerUuids: string[]): Promise<void> {
    await call(api, 'post', '/v1/workflows/events', { event, resource: 'groups', objectUuid: groupUuid, triggerUuids });
}

export interface ComplianceSetup { attributeUuid: string; profileUuid: string }

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
    return { attributeUuid: attribute.uuid, profileUuid: profile.uuid };
}

export async function associateComplianceProfile(api: APIRequestContext, profileUuid: string, raProfileUuid: string): Promise<void> {
    await call(api, 'patch', `/v2/complianceProfiles/${profileUuid}/associations/raProfiles/${raProfileUuid}`);
}

/** Returns once the platform's own compliance check after issuance (as the system user) is done; the certificate is in no group yet. */
export async function issueCertificate(
    api: APIRequestContext, authorityUuid: string, raProfileUuid: string, commonName: string,
): Promise<string> {
    const csr = csrFromKey(newKeyMaterial().keys, commonName, { dns: [commonName], ip: [] });
    const issued = await call(api, 'post', `/v2/operations/authorities/${authorityUuid}/raProfiles/${raProfileUuid}/certificates`, {
        request: csr.derBase64, format: 'pkcs10', attributes: [], customAttributes: [],
    });
    await waitForCertificateState(api, issued.uuid, 'issued', 120_000);
    await expect.poll(async () => (await getCertificate(api, issued.uuid)).complianceStatus, {
        message: `${ENVIRONMENT} the compliance check after the issuance of ${commonName}`, timeout: 180_000, intervals: [2_000],
    }).not.toBe('not_checked');
    return issued.uuid;
}

export async function setGroup(api: APIRequestContext, certUuid: string, groupUuid: string): Promise<void> {
    await call(api, 'patch', `/v1/certificates/${certUuid}`, { groupUuids: [groupUuid] });
}

export async function assignRaProfile(api: APIRequestContext, certUuid: string, raProfileUuid: string): Promise<void> {
    await call(api, 'patch', `/v1/certificates/${certUuid}`, { raProfileUuid });
}

export async function archiveCertificate(api: APIRequestContext, certUuid: string): Promise<void> {
    await call(api, 'patch', `/v1/certificates/${certUuid}/archive`);
}

export async function getCertificate(api: APIRequestContext, uuid: string): Promise<{ uuid: string; commonName: string; complianceStatus: string; validationStatus: string; archived?: boolean; state: string }> {
    return call(api, 'get', `/v1/certificates/${uuid}`);
}

/** The certificates of a timeline, archived ones too, by common name suffix: `{ reminded: uuid, … }`. */
export async function findTimelineCertificates(api: APIRequestContext, prefix: string): Promise<Record<string, string>> {
    const body = await call(api, 'post', '/v1/certificates', {
        itemsPerPage: 100, pageNumber: 1, includeArchived: true,
        filters: [{ fieldSource: 'property', fieldIdentifier: 'COMMON_NAME', condition: 'STARTS_WITH', value: prefix }],
    });
    const found: Record<string, string> = {};
    for (const c of body.certificates as Array<{ uuid: string; commonName: string }>) found[c.commonName.slice(prefix.length)] = c.uuid;
    return found;
}

async function setFlag(api: APIRequestContext, certUuid: string, attributeUuid: string, value: 'ok' | 'bad'): Promise<void> {
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

/** The k-th job run that started after the start of the timeline; a missing or unfinished run is the environment's, not the product's. */
export function runAfter(runs: JobRun[], start: number, k: number): { run: JobRun; next?: JobRun } {
    const after = runs.filter((r) => r.start > start);
    const run = after[k - 1];
    if (!run) throw new Error(`${ENVIRONMENT} job run ${k} of ${STATUS_JOB_NAME} is not in its history (${after.length} run(s) after the start ${new Date(start).toISOString()}): the run was skipped`);
    if (!run.end) throw new Error(`${ENVIRONMENT} job run ${k} of ${STATUS_JOB_NAME} has not finished`);
    return { run, next: after[k] };
}

/** Items whose time lies in [from, to): from a run's start up to the start of the next run. */
export const within = <T>(items: T[], at: (item: T) => number, from: number, to: number = Number.POSITIVE_INFINITY): T[] =>
    items.filter((i) => at(i) >= from && at(i) < to);

interface Named { uuid: string; name: string; description?: string }

/** The creation time a timeline group carries in its description (the seed's clock), if any. */
const createdAtOf = (group: Named): number | undefined => {
    const m = /created (\S+)/.exec(group.description ?? '');
    return m ? time(m[1]) : undefined;
};

/** The certKey_<CN> keys core made for a timeline certificate and keeps after it: exact name, in no token, linked to nothing else. */
async function certificateKeysOf(api: APIRequestContext, commonName: string, certUuid?: string): Promise<string[]> {
    const wanted = `certKey_${commonName}`;
    const candidates = new Set<string>();
    const linked = certUuid ? await getCertificateKeyUuid(api, certUuid) : undefined;
    if (linked) candidates.add(linked);
    const found = await call(api, 'post', '/v1/keys', {
        itemsPerPage: 100, pageNumber: 1, filters: [{ fieldSource: 'property', fieldIdentifier: 'CKI_NAME', condition: 'EQUALS', value: wanted }],
    });
    for (const row of (found?.cryptographicKeys ?? []) as Json[]) if (row.name === wanted && row.keyWrapperUuid) candidates.add(String(row.keyWrapperUuid));
    const own: string[] = [];
    for (const uuid of candidates) {
        const key = await call(api, 'get', `/v1/keys/${uuid}`, undefined, [404]);
        if (key?.name !== wanted || key.tokenInstanceUuid) continue;
        if (keyAssociationsOf(key).some((a) => String(objectOf(a).uuid ?? a) !== certUuid)) continue;
        own.push(uuid);
    }
    return own;
}

/** One retry: the association of a certificate deleted a moment ago can linger. A kept key is a failure, never a silent leak. */
async function removeOwnKey(api: APIRequestContext, uuid: string, createdAfter: Date): Promise<void> {
    for (let attemptNo = 1; ; attemptNo++) {
        if (await deleteKeyIfOrphaned(api, uuid, createdAfter)) return;
        if (attemptNo === 2) throw new Error(`key ${uuid} kept: in a token, older than its certificate or still associated`);
        await new Promise((r) => setTimeout(r, 2_000));
    }
}

/**
 * Removes the associations the timeline made, then a plain delete; the force removes every association, so it is sent only when none
 * of another owner is left. Absence is proven by a 404.
 */
async function removeComplianceProfile(api: APIRequestContext, uuid: string): Promise<void> {
    const associations = ((await call(api, 'get', `/v2/complianceProfiles/${uuid}/associations`)) ?? []) as Array<{ resource?: string; objectUuid?: string; name?: string }>;
    const liveRaProfiles = new Map(((await call(api, 'get', '/v1/raProfiles')) as Named[]).map((r) => [r.uuid, r.name]));
    // "gone" is judged from the RA profiles the test user can see
    const timelines = (a: { resource?: string; objectUuid?: string }): boolean => {
        const raProfile = liveRaProfiles.get(String(a.objectUuid));
        return a.resource === 'raProfiles' && (raProfile === undefined || raProfile.startsWith(SMOKE_RA_PROFILE));
    };
    for (const a of associations.filter(timelines)) {
        const removed = await api.delete(`/api/v2/complianceProfiles/${uuid}/associations/raProfiles/${a.objectUuid}`);
        if (!removed.ok() && removed.status() !== 404) logger.warn(`compliance profile ${uuid}: removing its association with RA profile ${a.objectUuid} answered ${removed.status()}`);
    }
    const gone = async (): Promise<boolean> => (await api.get(`/api/v1/complianceProfiles/${uuid}`)).status() === 404;
    const plain = await api.delete(`/api/v1/complianceProfiles/${uuid}`);
    if ((plain.ok() || plain.status() === 404) && await gone()) return;
    const foreign = associations.filter((a) => !timelines(a));
    if (foreign.length) throw new Error(`not forced, associations the timeline did not make: ${foreign.map((a) => `${a.resource} ${a.name ?? a.objectUuid}`).join(', ')}`);
    const refused = await call(api, 'delete', '/v2/complianceProfiles/force', [uuid]);
    if (refused !== undefined && !(Array.isArray(refused) && !refused.length)) {
        const why = Array.isArray(refused) ? refused.map((m: Json) => `${m.name ?? m.uuid}: ${m.message}`).join('; ') : `unexpected answer ${JSON.stringify(refused)}`;
        throw new Error(`force delete refused: ${why.slice(0, 300)}`);
    }
    if (!await gone()) throw new Error('still there after the force delete');
}

/**
 * Removes everything of a timeline in dependency order; each step is tried even when one before it failed.
 * What a later sweep finds the rest by (the certificates, then the groups) stays until the rest is gone.
 */
export async function cleanupTimeline(api: APIRequestContext, prefix: string): Promise<string[]> {
    const failures: string[] = [];
    const attempt = async (what: string, action: () => Promise<unknown>): Promise<boolean> => {
        try {
            await action();
            return true;
        } catch (e) {
            failures.push(`${what}: ${String(e).slice(0, 300)}`);
            return false;
        }
    };
    // a failed list read is a failure of its own, never a reason to skip the rest
    const listed = async <T>(what: string, read: () => Promise<T>, empty: T): Promise<T> => {
        try {
            return await read();
        } catch (e) {
            failures.push(`${what} list: ${String(e).slice(0, 300)}`);
            return empty;
        }
    };
    const own = <T extends Named>(items: T[]): T[] => items.filter((i) => i.name.startsWith(prefix));
    const ownList = async (what: string, path: string): Promise<Named[]> => own(await listed(what, async () => (await call(api, 'get', path)) as Named[], []));

    const groups = await ownList('groups', '/v1/groups');
    const certs = await listed('certificates', () => findTimelineCertificates(api, prefix), {} as Record<string, string>);
    const certUuids = Object.values(certs);

    // The test user's notifications about these certificates.
    const notificationsGone = await attempt('notifications', async () => {
        const mine = (await listMyNotifications(api)).filter((n) => (n.targetObjectIdentification ?? []).some((u) => certUuids.includes(u)));
        if (mine.length) await call(api, 'delete', '/v1/notifications', mine.map((n) => n.uuid));
    });
    for (const group of groups) {
        for (const event of [NOT_COMPLIANT_EVENT, EXPIRING_EVENT]) await attempt(`association ${group.name}`, () => associateTriggers(api, event, group.uuid, []));
    }
    for (const t of await ownList('triggers', '/v1/workflows/triggers')) await attempt(`trigger ${t.name}`, () => call(api, 'delete', `/v1/workflows/triggers/${t.uuid}`));
    for (const a of await ownList('actions', '/v1/workflows/actions')) await attempt(`action ${a.name}`, () => call(api, 'delete', `/v1/workflows/actions/${a.uuid}`));
    for (const e of await ownList('executions', '/v1/workflows/executions')) await attempt(`execution ${e.name}`, () => call(api, 'delete', `/v1/workflows/executions/${e.uuid}`));
    const profiles = await listed('notification profiles', async () => {
        const all: Named[] = [];
        for (let page = 1; ; page++) {
            const body = await call(api, 'get', `/v1/notificationProfiles?itemsPerPage=100&pageNumber=${page}`);
            all.push(...((body?.notificationProfiles ?? []) as Named[]));
            if (page >= Number(body?.totalPages ?? 0)) return all;
        }
    }, [] as Named[]);
    for (const p of own(profiles)) await attempt(`notification profile ${p.name}`, () => call(api, 'delete', `/v1/notificationProfiles/${p.uuid}`));
    for (const p of await ownList('compliance profiles', '/v2/complianceProfiles')) await attempt(`compliance profile ${p.name}`, () => removeComplianceProfile(api, p.uuid));
    for (const r of await ownList('compliance rules', '/v2/complianceProfiles/rules')) await attempt(`rule ${r.name}`, () => call(api, 'delete', `/v2/complianceProfiles/rules/${r.uuid}`));
    const attributes = await listed('custom attributes', async () => (await call(api, 'get', '/v1/attributes/custom')) as Named[], []);
    for (const a of attributes.filter((x) => x.name === attributeNameOf(prefix))) await attempt(`custom attribute ${a.name}`, () => call(api, 'delete', `/v1/attributes/custom/${a.uuid}`));

    // core links a certKey_<CN> key to each certificate and keeps it after the certificate is deleted
    for (const suffix of new Set([...TIMELINE_CERTIFICATES, ...Object.keys(certs)])) {
        const certUuid = certs[suffix];
        let keys: string[] = [];
        // with the certificate gone the exact name is the proof (it carries the timeline's prefix); else its creation time on the server
        let createdAfter = new Date(0);
        const keysFound = await attempt(`key lookup of certificate ${suffix}`, async () => {
            keys = await certificateKeysOf(api, `${prefix}${suffix}`, certUuid);
            if (!certUuid) return;
            const created = await certificateCreationTime(api, certUuid);
            if (!created) throw new Error('no creation time in the history of the certificate, so its key cannot be proven ours');
            createdAfter = new Date(Date.parse(created) - 60_000);
        });
        if (certUuid) {
            if (!keysFound || !notificationsGone) {
                failures.push(`certificate ${suffix}: kept, so that a later sweep finds its ${keysFound ? 'notifications' : 'key'} through it`);
                continue;
            }
            if (!(await attempt(`certificate ${suffix}`, () => call(api, 'delete', `/v1/certificates/${certUuid}`, undefined, [404])))) continue;
        }
        for (const key of keys) await attempt(`key delete of certificate ${suffix}`, () => removeOwnKey(api, key, createdAfter));
    }

    if (!failures.length) {
        for (const g of groups) await attempt(`group ${g.name}`, () => call(api, 'delete', `/v1/groups/${g.uuid}`));
    } else if (groups.length) {
        failures.push(`groups kept so a later sweep finds the leftovers: ${groups.map((g) => g.name).join(', ')}`);
    }
    if (failures.length) logger.warn(`Timeline ${prefix} was not removed completely:\n${failures.join('\n')}`);
    return failures;
}

/**
 * Removes every atf-e369 timeline older than 6 hours, whoever seeded it (its group names carry the prefix, the descriptions the time).
 * What cannot be removed goes to the cleanup ledger, which fails the run; the kept groups let the next sweep try again.
 */
export async function cleanupStaleTimelines(api: APIRequestContext, ownPrefix: string): Promise<void> {
    const groups = (await call(api, 'get', '/v1/groups')) as Named[];
    const stale = new Set<string>();
    for (const g of groups) {
        const m = /^(atf-e369-.+-)g\d+$/.exec(g.name);
        const created = createdAtOf(g);
        if (m && m[1] !== ownPrefix && created !== undefined && Date.now() - created > STALE_AFTER_MS) stale.add(m[1]);
    }
    for (const prefix of stale) {
        logger.info(`Removing the leftovers of the earlier timeline ${prefix}`);
        for (const message of await cleanupTimeline(api, prefix)) recordCleanupFailure({ resource: 'timeline', name: prefix, message });
    }
}

export async function complianceProfileOf(api: APIRequestContext, prefix: string): Promise<string> {
    const profiles = (await call(api, 'get', '/v2/complianceProfiles')) as Array<{ uuid: string; name: string }>;
    const profile = profiles.find((p) => p.name === `${prefix}compliance`);
    if (!profile) throw new Error(`${ENVIRONMENT} compliance profile of the timeline ${prefix} is not found`);
    return profile.uuid;
}
