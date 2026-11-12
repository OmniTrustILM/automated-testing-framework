/**
 * epicOwnership — helpers of the Epic ilm#364 tests: the prepared accounts, the ownership setting, uploads, imports, reads, upload triggers.
 * Plain API contexts: every object a test creates goes into a Cleanup and is removed in dependency order, also after a failure.
 */

import { APIRequestContext, request as playwrightRequest } from '@playwright/test';
import { TestEnv } from './env';
import { fetchAccessToken } from './auth/accessToken';
import { Logger } from './Logger';
import { attemptCleanup } from './cleanupLedger';
import { requiredCustomAttributes } from './regression/customAttributes';
import { getCertificateKeyUuid, deleteKeyIfOrphaned } from './keyUtils';
import { findCryptoConnector, tokenRequestAttributes, tokenAlias, activationCode } from './regression/platform/tokens';
import { PROFILE_USAGES } from './regression/platform/cryptoAlgorithmCases';
import { fingerprintFilter, pollCertificateByFingerprint } from './regression/apiReads';
import { pollUntil } from './regression/wait';

const logger = new Logger('EpicOwnership');

export type Account = 'U' | 'V' | 'R';

const UPLOAD_EVENT = 'certificate_uploaded';

export interface Json { [key: string]: any }

/** The sign-in of a prepared account, from `EPIC_USER_<letter>_USERNAME` / `_PASSWORD`; the accounts carry over between runs. */
export function accountCredentials(account: Account): { username: string; password: string } {
    const username = process.env[`EPIC_USER_${account}_USERNAME`];
    const password = process.env[`EPIC_USER_${account}_PASSWORD`];
    if (!username || !password) throw new Error(`Missing EPIC_USER_${account}_USERNAME / EPIC_USER_${account}_PASSWORD`);
    return { username, password };
}

/** The environment with the account's sign-in in the place of the smoke user's, for the login page object. */
export function envFor(env: TestEnv, account: Account): TestEnv {
    return { ...env, ...accountCredentials(account) };
}

async function contextFor(request: APIRequestContext, env: TestEnv, credentials: { username: string; password: string }): Promise<APIRequestContext> {
    const token = await fetchAccessToken(request, env, credentials, { minLifetimeMs: 300_000 });
    return playwrightRequest.newContext({
        baseURL: env.baseUrl,
        extraHTTPHeaders: { Authorization: `Bearer ${token.bearer()}`, Accept: 'application/json' },
        ignoreHTTPSErrors: true,
    });
}

/** An API context that acts as the account (password grant, cached per account by `fetchAccessToken`). */
export const apiAs = (request: APIRequestContext, env: TestEnv, account: Account): Promise<APIRequestContext> => contextFor(request, env, accountCredentials(account));

/** The administrator's context (the smoke user), for reads and for the setup the accounts may not do. */
export const adminApi = (request: APIRequestContext, env: TestEnv): Promise<APIRequestContext> => contextFor(request, env, { username: env.username, password: env.password });

export interface Answer { status: number; json: Json | any[] | undefined; text: string }

export async function send(api: APIRequestContext, method: 'GET' | 'POST' | 'PUT' | 'PATCH' | 'DELETE', url: string, data?: unknown): Promise<Answer> {
    const response = await api.fetch(url, { method, ...(data === undefined ? {} : { data }) });
    const text = await response.text();
    let json: Answer['json'];
    try { json = text ? JSON.parse(text) : undefined; } catch { json = undefined; }
    return { status: response.status(), json, text };
}

export async function sendOk(api: APIRequestContext, method: 'GET' | 'POST' | 'PUT' | 'PATCH' | 'DELETE', url: string, data?: unknown): Promise<Answer> {
    const answer = await send(api, method, url, data);
    if (answer.status < 200 || answer.status >= 300) throw new Error(`${method} ${url} answered ${answer.status}: ${answer.text.slice(0, 500)}`);
    return answer;
}

/** The stored value as the API returns it; undefined when the field is missing. */
export async function readAutomaticOwnership(api: APIRequestContext): Promise<boolean | undefined> {
    const answer = await sendOk(api, 'GET', '/api/v1/settings/platform');
    return (answer.json as Json).certificates?.upload?.automaticOwnership;
}

/** Sets the switch and waits until a read shows it (one Core instance is assumed; with several, the caches follow within 30 seconds). */
export async function setAutomaticOwnership(api: APIRequestContext, on: boolean): Promise<void> {
    await sendOk(api, 'PUT', '/api/v1/settings/platform', { certificates: { upload: { automaticOwnership: on } } });
    await waitUntil(async () => (await readAutomaticOwnership(api)) === on, `the platform setting reads ${on ? 'on' : 'off'}`);
}

/** The shared poll of utils/regression/wait.ts with a message: an error of the check fails at once, as a timeout does. */
export async function waitUntil(check: () => Promise<boolean>, what: string, timeoutMs = 30_000): Promise<void> {
    const ok = await pollUntil(check, (done) => done, { timeoutMs, intervalMs: 500, tolerateErrors: 0, onTimeout: 'return' });
    if (!ok) throw new Error(`Timed out waiting for: ${what}`);
}

const base64 = (text: string | Buffer): string => Buffer.from(text).toString('base64');

const uploadRequest = (pem: string, customAttributes: unknown[] = []): Json => ({ certificate: base64(pem), customAttributes });

export async function upload(api: APIRequestContext, pem: string, customAttributes: unknown[] = [], path: 'upload' | 'upload/async' = 'upload'): Promise<Answer> {
    return send(api, 'POST', `/api/v1/certificates/${path}`, uploadRequest(pem, customAttributes));
}

/** Imports the entries named by their references (certificate-only entries have no key destination). */
export async function importEntries(api: APIRequestContext, file: Buffer, entries: Array<{ entryReference: string; keyDestination?: Json }>, extra: Json = {}): Promise<Answer> {
    return send(api, 'POST', '/api/v1/certificates/import', { file: base64(file), entries, ...extra });
}

export interface ImportResult { entryReference: string; imported: boolean; certificateOutcome?: string; certificateUuid?: string; message?: string }

export const importResults = (answer: Answer): ImportResult[] => ((answer.json as Json)?.results ?? []) as ImportResult[];

const fingerprintSearch = (fingerprint: string, includeArchived = false): Json => ({ itemsPerPage: 10, pageNumber: 1, filters: fingerprintFilter(fingerprint), includeArchived });

export async function findByFingerprint(api: APIRequestContext, fingerprint: string): Promise<Answer> {
    return send(api, 'POST', '/api/v1/certificates', fingerprintSearch(fingerprint));
}

/** The inventory row of the certificate as the signed-in account sees it, or undefined; archived ones only when asked (clean-up). */
export async function inventoryRow(api: APIRequestContext, fingerprint: string, opts: { includeArchived?: boolean } = {}): Promise<Json | undefined> {
    const answer = await sendOk(api, 'POST', '/api/v1/certificates', fingerprintSearch(fingerprint, opts.includeArchived));
    return ((answer.json as Json).certificates as Json[])[0];
}

/** Waits until the certificate with the fingerprint is in the inventory (the asynchronous upload) and returns its uuid. */
export async function waitForCertificate(admin: APIRequestContext, fingerprint: string): Promise<string> {
    const row = await pollCertificateByFingerprint(admin, fingerprint, 60_000);
    if (!row?.uuid) throw new Error(`Timed out waiting for: a certificate with fingerprint ${fingerprint} in the inventory`);
    return String(row.uuid);
}

export async function detail(api: APIRequestContext, uuid: string): Promise<Json> {
    return (await sendOk(api, 'GET', `/api/v1/certificates/${uuid}`)).json as Json;
}

async function history(api: APIRequestContext, uuid: string): Promise<Json[]> {
    return (await sendOk(api, 'GET', `/api/v1/certificates/${uuid}/history`)).json as Json[];
}

/** The messages of the owner changes in the history (`<old> -> <new>`), oldest first as the platform lists them. */
export async function ownerChanges(api: APIRequestContext, uuid: string): Promise<string[]> {
    return (await history(api, uuid)).filter((e) => e.event === 'Update Owner' || e.event === 'UPDATE_OWNER').map((e) => String(e.message));
}

/** Uploads as the account and returns the uuid of the new certificate. */
export async function uploadAndFind(as: APIRequestContext, admin: APIRequestContext, pem: string, fingerprint: string, customAttributes: unknown[] = []): Promise<string> {
    const answer = await upload(as, pem, customAttributes);
    if (answer.status !== 200 && answer.status !== 201) throw new Error(`upload answered ${answer.status}: ${answer.text.slice(0, 500)}`);
    return waitForCertificate(admin, fingerprint);
}

/** Everything a test creates, removed in dependency order by `run` (also after a failed test). */
export class Cleanup {
    private readonly steps: Array<{ describe: { resource: string; name?: string; uuid?: string }; remove: () => Promise<unknown> }> = [];
    private readonly fingerprints: string[] = [];
    private readonly keys: string[] = [];
    private startedAt = new Date(Date.now() - 60_000);

    add(resource: string, ref: string, remove: () => Promise<unknown>): void {
        this.steps.unshift({ describe: { resource, name: ref }, remove });
    }

    certificate(fingerprint: string): void {
        this.fingerprints.push(fingerprint);
    }

    /** A key in a token (made by an import); removed after the certificates and before the token. */
    key(keyUuid: string): void {
        this.keys.push(keyUuid);
    }

    /** Removes the certificates (archived ones too), then the keys they left, then the registered objects, last created first. */
    async run(admin: APIRequestContext): Promise<void> {
        const leftKeys = new Set<string>();
        for (const fingerprint of this.fingerprints.splice(0)) {
            await attemptCleanup({ resource: 'certificate', name: fingerprint }, async () => {
                const row = await inventoryRow(admin, fingerprint, { includeArchived: true });
                if (!row) return;
                const keyUuid = await getCertificateKeyUuid(admin, row.uuid);
                if (keyUuid) leftKeys.add(keyUuid);
                await sendOk(admin, 'DELETE', `/api/v1/certificates/${row.uuid}`);
            });
        }
        // a key step of its own: a failed key removal is retried and reported apart from its certificate
        for (const keyUuid of leftKeys) {
            await attemptCleanup({ resource: 'key', uuid: keyUuid }, () => deleteKeyIfOrphaned(admin, keyUuid, this.startedAt));
        }
        for (const keyUuid of this.keys.splice(0)) {
            await attemptCleanup({ resource: 'key', uuid: keyUuid }, () => sendOk(admin, 'DELETE', '/api/v1/keys', [keyUuid]));
        }
        for (const step of this.steps.splice(0)) await attemptCleanup(step.describe, step.remove);
    }
}

export async function createTeamUser(admin: APIRequestContext, cleanup: Cleanup, username: string): Promise<{ uuid: string; username: string }> {
    const created = await sendOk(admin, 'POST', '/api/v1/users', {
        username,
        firstName: 'QA',
        lastName: 'Team',
        email: `${username}@example.test`,
        enabled: false,
        description: 'Epic test account of a team',
        groupUuids: [],
        customAttributes: await requiredCustomAttributes(admin, 'users', username),
    });
    const uuid = (created.json as Json).uuid as string;
    cleanup.add('user', username, () => sendOk(admin, 'DELETE', `/api/v1/users/${uuid}`));
    return { uuid, username };
}

export async function createGroup(admin: APIRequestContext, cleanup: Cleanup, name: string): Promise<{ uuid: string; name: string }> {
    const created = await sendOk(admin, 'POST', '/api/v1/groups', {
        name,
        description: 'Epic test group',
        customAttributes: await requiredCustomAttributes(admin, 'groups', name),
    });
    const uuid = (created.json as Json).uuid as string;
    cleanup.add('group', name, () => sendOk(admin, 'DELETE', `/api/v1/groups/${uuid}`));
    return { uuid, name };
}

export async function createCustomAttribute(admin: APIRequestContext, cleanup: Cleanup, name: string): Promise<{ uuid: string; name: string; contentType: string }> {
    const created = await sendOk(admin, 'POST', '/api/v1/attributes/custom', {
        name,
        label: name,
        description: 'Epic test attribute',
        contentType: 'string',
        required: false,
        visible: true,
        readOnly: false,
        list: false,
        multiSelect: false,
        resources: ['certificates'],
    });
    const uuid = (created.json as Json).uuid as string;
    cleanup.add('custom attribute', name, () => sendOk(admin, 'DELETE', '/api/v1/attributes/custom', [uuid]));
    return { uuid, name, contentType: 'string' };
}

export const attributeValue = (attr: { uuid: string; name: string; contentType: string }, value: string): Json => ({
    uuid: attr.uuid,
    name: attr.name,
    contentType: attr.contentType,
    content: [{ data: value }],
});

export const customValue = (certificateDetail: Json, name: string): unknown => {
    const attribute = ((certificateDetail.customAttributes ?? []) as Json[]).find((a) => a.name === name);
    return attribute?.content?.[0]?.data;
};

export interface TriggerSpec {
    name: string;
    /** Conditions on the certificate: the trigger applies when every item holds. */
    conditions: Array<{ fieldSource: string; fieldIdentifier: string; operator: string; value?: unknown }>;
    ignore?: boolean;
    /** Execution items of the "set field" action, or the notification profile of the "send notification" action. */
    setFields?: Array<{ fieldSource: string; fieldIdentifier: string; data: unknown }>;
    notificationProfileUuid?: string;
}

async function create(admin: APIRequestContext, cleanup: Cleanup, kind: string, body: Json): Promise<string> {
    const created = await sendOk(admin, 'POST', `/api/v1/workflows/${kind}`, body);
    const uuid = (created.json as Json).uuid as string;
    cleanup.add(`workflow ${kind}`, String(body.name), () => sendOk(admin, 'DELETE', `/api/v1/workflows/${kind}/${uuid}`));
    return uuid;
}

/**
 * Creates the chain of a platform trigger on "Certificate uploaded" (condition, rule, execution, action, trigger) and puts the trigger
 * on the event's platform list next to the triggers already there; the earlier list comes back when `cleanup` runs.
 * The platform list is global: tests that call this are exclusive.
 */
export async function createUploadTrigger(admin: APIRequestContext, cleanup: Cleanup, spec: TriggerSpec): Promise<string> {
    const conditionUuid = await create(admin, cleanup, 'conditions', {
        name: `${spec.name}-c`, description: 'Epic test', type: 'checkField', resource: 'certificates', items: spec.conditions,
    });
    const ruleUuid = await create(admin, cleanup, 'rules', {
        name: `${spec.name}-r`, description: 'Epic test', resource: 'certificates', conditionsUuids: [conditionUuid],
    });
    const actionUuids: string[] = [];
    if (!spec.ignore) {
        const executionUuid = await create(admin, cleanup, 'executions', spec.notificationProfileUuid
            ? { name: `${spec.name}-e`, description: 'Epic test', type: 'sendNotification', resource: 'certificates', items: [{ notificationProfileUuid: spec.notificationProfileUuid }] }
            : { name: `${spec.name}-e`, description: 'Epic test', type: 'setField', resource: 'certificates', items: spec.setFields ?? [] });
        actionUuids.push(await create(admin, cleanup, 'actions', {
            name: `${spec.name}-a`, description: 'Epic test', resource: 'certificates', executionsUuids: [executionUuid],
        }));
    }
    const triggerUuid = await create(admin, cleanup, 'triggers', {
        name: spec.name,
        description: 'Epic test',
        type: 'event',
        resource: 'certificates',
        event: UPLOAD_EVENT,
        ignoreTrigger: spec.ignore ?? false,
        rulesUuids: [ruleUuid],
        actionsUuids: actionUuids,
    });
    await associateWithUploadEvent(admin, cleanup, triggerUuid);
    return triggerUuid;
}

async function platformTriggers(admin: APIRequestContext): Promise<string[]> {
    const answer = await sendOk(admin, 'GET', '/api/v1/settings/events');
    return (((answer.json as Json).eventsMapping ?? {})[UPLOAD_EVENT] ?? []) as string[];
}

/** Puts the earlier platform list back, leaving out only triggers that are gone (404): any other failed read stops the restore. */
async function restorePlatformTriggers(admin: APIRequestContext, before: string[]): Promise<void> {
    const existing: string[] = [];
    for (const uuid of before) {
        const answer = await admin.get(`/api/v1/workflows/triggers/${uuid}`);
        if (answer.ok()) existing.push(uuid);
        else if (answer.status() !== 404) throw new Error(`GET trigger ${uuid} answered ${answer.status()}: the platform list is not restored, so no trigger is dropped from it`);
    }
    await sendOk(admin, 'PATCH', '/api/v1/settings/events', { event: UPLOAD_EVENT, triggerUuids: existing });
}

async function associateWithUploadEvent(admin: APIRequestContext, cleanup: Cleanup, triggerUuid: string): Promise<void> {
    const before = await platformTriggers(admin);
    // Registered before the change, so a trigger is never deleted while the platform list still names it.
    cleanup.add('platform trigger list of the upload event', UPLOAD_EVENT, () =>
        restorePlatformTriggers(admin, before));
    await sendOk(admin, 'PATCH', '/api/v1/settings/events', { event: UPLOAD_EVENT, triggerUuids: [...before, triggerUuid] });
    logger.info(`Platform triggers on the upload event: ${before.length} before, ${before.length + 1} now`);
}

/** A subject name that only this run's triggers' conditions match. */
export const subjectOf = (runPrefix: string, scenario: string): string => `${runPrefix}-${scenario}.example.com`;

export const commonNameIs = (cn: string): TriggerSpec['conditions'][number] => ({ fieldSource: 'property', fieldIdentifier: 'COMMON_NAME', operator: 'EQUALS', value: cn });

export const setOwner = (userUuid: string | null): NonNullable<TriggerSpec['setFields']>[number] => ({ fieldSource: 'property', fieldIdentifier: 'OWNER', data: userUuid });

/** An internal notification profile whose recipient is the owner of the certificate (nothing is sent outside the platform). */
export async function createOwnerNotificationProfile(admin: APIRequestContext, cleanup: Cleanup, name: string): Promise<string> {
    const created = await sendOk(admin, 'POST', '/api/v1/notificationProfiles', {
        name,
        description: 'Epic test profile',
        recipientType: 'owner',
        internalNotification: true,
    });
    const uuid = (created.json as Json).uuid as string;
    cleanup.add('notification profile', name, () => sendOk(admin, 'DELETE', `/api/v1/notificationProfiles/${uuid}`));
    return uuid;
}

/** The internal notifications of the signed-in account that mention the text (the certificate's subject or UUID). */
export async function notificationsMentioning(api: APIRequestContext, text: string): Promise<Json[]> {
    const answer = await sendOk(api, 'GET', '/api/v1/notifications');
    return (((answer.json as Json).items ?? []) as Json[]).filter((n) => JSON.stringify(n).includes(text));
}

/**
 * A token on the software cryptography provider and an enabled token profile on it, the key destination of a PKCS#12 import.
 * The profile is removed first, then the token.
 */
export async function createSoftwareTokenProfile(admin: APIRequestContext, cleanup: Cleanup, name: string): Promise<string> {
    const connector = await findCryptoConnector(admin, 2) ?? await findCryptoConnector(admin, 1);
    if (!connector) throw new Error('No software cryptography connector is registered');
    const kind = connector.version === 1 ? 'Soft' : undefined;
    const defs = (await sendOk(admin, 'GET', `/api/v1/tokens/${connector.uuid}/attributes${kind ? `?kind=${kind}` : ''}`)).json as any[];
    const token = await sendOk(admin, 'POST', '/api/v1/tokens', {
        name,
        description: 'Epic test token',
        connectorUuid: connector.uuid,
        ...(kind ? { kind } : {}),
        attributes: tokenRequestAttributes(defs, tokenAlias(name), activationCode()),
        customAttributes: await requiredCustomAttributes(admin, 'tokens', name),
    });
    const tokenUuid = (token.json as Json).uuid as string;
    cleanup.add('token', name, () => sendOk(admin, 'DELETE', `/api/v1/tokens/${tokenUuid}`));
    const profile = await sendOk(admin, 'POST', `/api/v1/tokens/${tokenUuid}/tokenProfiles`, {
        name: `${name}-profile`,
        description: 'Epic test token profile',
        attributes: [],
        customAttributes: await requiredCustomAttributes(admin, 'tokenProfiles', name),
        enabled: true,
        usage: [...PROFILE_USAGES],
    });
    const profileUuid = (profile.json as Json).uuid as string;
    cleanup.add('token profile', `${name}-profile`, () => sendOk(admin, 'DELETE', `/api/v1/tokens/${tokenUuid}/tokenProfiles/${profileUuid}`));
    return profileUuid;
}
