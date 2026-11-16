/**
 * epicOwnership — helpers of the Epic ilm#364 tests: prepared accounts, the ownership setting, uploads, imports, reads, upload triggers.
 * API contexts that renew their tokens; every object a test creates goes into a Cleanup, removed in dependency order also after a failure.
 */

import { APIRequestContext } from '@playwright/test';
import { TestEnv } from './env';
import { openAuthenticatedApiContext } from './auth/apiContext';
import { RENEW_MARGIN_MS, renewingContext } from './auth/renewingContext';
import { Logger } from './Logger';
import { attemptCleanup, recordCleanupFailure } from './cleanupLedger';
import { requiredCustomAttributes } from './regression/customAttributes';
import { getCertificateKeyUuid, deleteKeyIfOrphaned } from './keyUtils';
import { findCryptoConnector, tokenRequestAttributes, tokenAlias, activationCode } from './regression/platform/tokens';
import { PROFILE_USAGES } from './regression/platform/cryptoAlgorithmCases';
import { ApiAnswer, answerOf, fingerprintFilter, pollCertificateByFingerprint } from './regression/apiReads';
import { toBase64, uploadBody } from './regression/inventory/importFixtures';
import { certificateDetail } from './regression/inventory/groupProbes';
import { CERT_FIELD, ConditionItem, ExecutionItem } from './regression/events/workflowObjects';
import { pollUntil } from './regression/wait';
import { csrFromKey, derToPem, newKeyPair } from './regression/pkiBuilders';
import { deleteCertificate, waitForCertificateState } from './certificateUtils';

const logger = new Logger('EpicOwnership');

export type Account = 'U' | 'V' | 'R';

const UPLOAD_EVENT = 'certificate_uploaded';

export interface Json { [key: string]: any }

/** The sign-in of a prepared account (`EPIC_USER_<letter>_USERNAME` / `_PASSWORD`); the accounts carry over between runs. */
export function accountCredentials(env: TestEnv, account: Account): { username: string; password: string } {
    const credentials = env.epicUsers?.[account];
    if (!credentials) throw new Error(`Missing EPIC_USER_${account}_USERNAME / EPIC_USER_${account}_PASSWORD`);
    return credentials;
}

/** The environment with the account's sign-in in the place of the smoke user's. */
export function envFor(env: TestEnv, account: Account): TestEnv {
    return { ...env, ...accountCredentials(env, account) };
}

/** A context that renews its token before it runs out, as the worker API does; `grant` must stay open while it is used. */
const renewing = (grant: APIRequestContext, env: TestEnv): APIRequestContext =>
    renewingContext(() => openAuthenticatedApiContext(grant, env, { minLifetimeMs: RENEW_MARGIN_MS }));

/** An API context that acts as the account. */
export const apiAs = (grant: APIRequestContext, env: TestEnv, account: Account): APIRequestContext => renewing(grant, envFor(env, account));

/** The administrator's context (the smoke user), for reads and for the setup the accounts may not do. */
export const adminApi = (grant: APIRequestContext, env: TestEnv): APIRequestContext => renewing(grant, env);

export async function send(
    api: APIRequestContext, method: 'GET' | 'POST' | 'PUT' | 'PATCH' | 'DELETE', url: string, data?: unknown,
): Promise<ApiAnswer> {
    const started = Date.now();
    return answerOf(await api.fetch(url, { method, ...(data === undefined ? {} : { data }) }), started);
}

export async function sendOk(
    api: APIRequestContext, method: 'GET' | 'POST' | 'PUT' | 'PATCH' | 'DELETE', url: string, data?: unknown,
): Promise<ApiAnswer> {
    const answer = await send(api, method, url, data);
    if (answer.status < 200 || answer.status >= 300) {
        throw new Error(`${method} ${url} answered ${answer.status}: ${answer.text.slice(0, 500)}`);
    }
    return answer;
}

const SETTING_CACHE_MS = 30_000;

/** The stored value as the API returns it; undefined when the field is missing. */
export async function readAutomaticOwnership(api: APIRequestContext): Promise<boolean | undefined> {
    const answer = await sendOk(api, 'GET', '/api/v1/settings/platform');
    return (answer.json as Json).certificates?.upload?.automaticOwnership;
}

/** Sets the switch and waits until a read shows it; after a change the caches of the other Core instances follow within 30 seconds (about 40 more for some caches). */
export async function setAutomaticOwnership(api: APIRequestContext, on: boolean): Promise<void> {
    const changes = (await readAutomaticOwnership(api)) !== on;
    await sendOk(api, 'PUT', '/api/v1/settings/platform', { certificates: { upload: { automaticOwnership: on } } });
    await waitUntil(async () => (await readAutomaticOwnership(api)) === on, `the platform setting reads ${on ? 'on' : 'off'}`);
    if (!changes) return;
    // the other Core instances follow within the cache interval: the reads that follow are kept to say what they showed
    const reads: string[] = [];
    const started = Date.now();
    await pollUntil(async () => {
        reads.push(`${Math.round((Date.now() - started) / 1000)}s:${await readAutomaticOwnership(api)}`);
    }, () => Date.now() - started > SETTING_CACHE_MS + 10_000, { timeoutMs: SETTING_CACHE_MS + 20_000, intervalMs: 2_000, tolerateErrors: 0 });
    if (reads.slice(-5).some((read) => !read.endsWith(`:${on}`))) throw new Error(`The setting was set to ${on}; later reads: ${reads.join(' ')}`);
}

/** The validation fields a settings read returned, for a PUT that writes no value the platform did not have. */
export function validationFields(captured: Json): Json {
    const { enabled, frequency, expiringThreshold } = captured;
    return Object.fromEntries(Object.entries({ enabled, frequency, expiringThreshold }).filter(([, value]) => value !== undefined));
}

/** Puts back the validation settings as they were read. */
export async function restoreValidation(admin: APIRequestContext, captured: Json): Promise<void> {
    await sendOk(admin, 'PUT', '/api/v1/settings/platform', { certificates: { validation: validationFields(captured) } });
}

/** The shared poll of utils/regression/wait.ts with a message: an error of the check fails at once, as a timeout does. */
export async function waitUntil(check: () => Promise<boolean>, what: string, timeoutMs = 30_000): Promise<void> {
    const ok = await pollUntil(check, (done) => done, { timeoutMs, intervalMs: 500, tolerateErrors: 0, onTimeout: 'return' });
    if (!ok) throw new Error(`Timed out waiting for: ${what}`);
}

export interface CertificateFile { pem: string; fingerprint: string }

/** Sends a request that stores the registered certificates: the cleanup waits for them unless the platform refused it. */
async function storing(cleanup: Cleanup | undefined, fingerprints: string[], request: () => Promise<ApiAnswer>): Promise<ApiAnswer> {
    fingerprints.forEach((f) => cleanup?.expectStored(f, true));
    const answer = await request();
    if (answer.status >= 300) fingerprints.forEach((f) => cleanup?.expectStored(f, false));
    return answer;
}

export async function upload(api: APIRequestContext, pem: string, customAttributes: unknown[] = []): Promise<ApiAnswer> {
    return send(api, 'POST', '/api/v1/certificates/upload', uploadBody(Buffer.from(pem), customAttributes));
}

export async function uploadAsync(api: APIRequestContext, cleanup: Cleanup, cert: CertificateFile): Promise<ApiAnswer> {
    cleanup.certificate(cert.fingerprint);
    return storing(cleanup, [cert.fingerprint], () => send(api, 'POST', '/api/v1/certificates/upload/async', uploadBody(Buffer.from(cert.pem))));
}

/** Imports the entries by reference; a key-pair entry's reference names its key, so `stores` lists the certificates it brings in. */
export async function importEntries(
    api: APIRequestContext, file: Buffer, entries: Array<{ entryReference: string; keyDestination?: Json }>,
    opts: { cleanup?: Cleanup; extra?: Json; stores?: string[] } = {},
): Promise<ApiAnswer> {
    return storing(opts.cleanup, [...entries.map((e) => e.entryReference), ...(opts.stores ?? [])], () =>
        send(api, 'POST', '/api/v1/certificates/import', { file: toBase64(file), entries, ...opts.extra }));
}

export interface ImportResult {
    entryReference: string;
    imported: boolean;
    certificateOutcome?: string;
    certificateUuid?: string;
    message?: string;
}

export const importResults = (answer: ApiAnswer): ImportResult[] => ((answer.json as Json)?.results ?? []) as ImportResult[];

/** Registers the keys of the certificates an import created, before any assertion; a failed read only logs (the token sweep removes it). */
export async function registerImportedKeys(admin: APIRequestContext, cleanup: Cleanup, answer: ApiAnswer): Promise<void> {
    for (const { certificateUuid } of importResults(answer)) {
        if (!certificateUuid) continue;
        try {
            const keyUuid = await getCertificateKeyUuid(admin, certificateUuid);
            if (keyUuid) cleanup.key(keyUuid);
        } catch (e) {
            logger.warn(
                `The key of imported certificate ${certificateUuid} was not read (${String(e).slice(0, 200)}); the token sweep removes it`,
            );
        }
    }
}

const fingerprintSearch = (fingerprint: string, includeArchived = false): Json => ({
    itemsPerPage: 10, pageNumber: 1, filters: fingerprintFilter(fingerprint), includeArchived,
});

export async function findByFingerprint(api: APIRequestContext, fingerprint: string): Promise<ApiAnswer> {
    return send(api, 'POST', '/api/v1/certificates', fingerprintSearch(fingerprint));
}

/** The inventory row of the certificate as the signed-in account sees it, or undefined; archived ones only when asked (clean-up). */
export async function inventoryRow(
    api: APIRequestContext, fingerprint: string, opts: { includeArchived?: boolean } = {},
): Promise<Json | undefined> {
    const answer = await sendOk(api, 'POST', '/api/v1/certificates', fingerprintSearch(fingerprint, opts.includeArchived));
    return ((answer.json as Json).certificates as Json[])[0];
}

/** Waits until the certificate with the fingerprint is in the inventory (the asynchronous upload) and returns its uuid. */
export async function waitForCertificate(admin: APIRequestContext, fingerprint: string): Promise<string> {
    const row = await pollCertificateByFingerprint(admin, fingerprint, 60_000);
    if (!row?.uuid) throw new Error(`Timed out waiting for: a certificate with fingerprint ${fingerprint} in the inventory`);
    return String(row.uuid);
}

/**
 * The detail once its owner is the expected one (`null` for none). The upload handler sets the owner after the certificate
 * is stored, so a read right after the certificate appears may still show the owner before; a wrong final owner fails with it.
 */
export async function detailOwnedBy(api: APIRequestContext, uuid: string, owner: string | null): Promise<Json> {
    const reached = await pollUntil(() => certificateDetail(api, uuid), (d) => (d.owner ?? null) === owner,
        { timeoutMs: 30_000, intervalMs: 500, tolerateErrors: 0, onTimeout: 'return' });
    if ((reached.owner ?? null) !== owner) {
        const events = (await history(api, uuid)).map((e) => `${e.event}: ${e.message}`).join('; ');
        throw new Error(`The owner of ${uuid} is ${reached.owner ?? 'nobody'}, expected ${owner ?? 'nobody'}; its history: ${events}`);
    }
    return reached;
}

/**
 * The detail, after the owner kept the expected value (`null` for none) over a short window: the owner is set just after the
 * certificate is stored, so a read right after it appears cannot show that nothing will change it.
 */
export async function detailKeepsOwner(api: APIRequestContext, uuid: string, owner: string | null, windowMs = 8_000): Promise<Json> {
    const changed = await pollUntil(() => certificateDetail(api, uuid), (d) => (d.owner ?? null) !== owner,
        { timeoutMs: windowMs, intervalMs: 1_000, tolerateErrors: 0, onTimeout: 'return' });
    if ((changed.owner ?? null) !== owner) {
        const events = (await history(api, uuid)).map((e) => `${e.event}: ${e.message}`).join('; ');
        throw new Error(`The owner of ${uuid} changed to ${changed.owner}, expected ${owner ?? 'nobody'} to stay; its history: ${events}`);
    }
    return changed;
}

async function history(api: APIRequestContext, uuid: string): Promise<Json[]> {
    return (await sendOk(api, 'GET', `/api/v1/certificates/${uuid}/history`)).json as Json[];
}

/** The messages of the owner changes in the history (`<old> -> <new>`), oldest first as the platform lists them. */
export async function ownerChanges(api: APIRequestContext, uuid: string): Promise<string[]> {
    return (await history(api, uuid)).filter((e) => e.event === 'Update Owner' || e.event === 'UPDATE_OWNER').map((e) => String(e.message));
}

/** Uploads as the account, registered for the cleanup, and returns the answer as it came. */
async function uploadRegistered(
    as: APIRequestContext, cleanup: Cleanup, cert: CertificateFile, customAttributes: unknown[] = [],
): Promise<ApiAnswer> {
    cleanup.certificate(cert.fingerprint);
    return storing(cleanup, [cert.fingerprint], () => upload(as, cert.pem, customAttributes));
}

/** Uploads as the account (registered for the cleanup) and returns the uuid of the new certificate. */
export async function uploadAndFind(
    as: APIRequestContext, admin: APIRequestContext, cleanup: Cleanup, cert: CertificateFile, customAttributes: unknown[] = [],
): Promise<string> {
    const answer = await uploadRegistered(as, cleanup, cert, customAttributes);
    if (answer.status !== 200 && answer.status !== 201) throw new Error(`upload answered ${answer.status}: ${answer.text.slice(0, 500)}`);
    return waitForCertificate(admin, cert.fingerprint);
}

export interface RaProfileRef { authorityUuid: string; raProfileUuid: string }

/** Issues a certificate for the subject through the RA profile as the account and waits until it is issued; the cleanup removes it. */
export async function issueThroughRaProfile(
    as: APIRequestContext, admin: APIRequestContext, cleanup: Cleanup, ra: RaProfileRef, cn: string,
): Promise<string> {
    const csr = csrFromKey(newKeyPair(), cn, { dns: [cn], ip: [] });
    const answer = await send(
        as,
        'POST',
        `/api/v2/operations/authorities/${ra.authorityUuid}/raProfiles/${ra.raProfileUuid}/certificates`,
        { request: csr.derBase64, format: 'pkcs10', attributes: [], customAttributes: [] },
    );
    if (answer.status !== 200) throw new Error(`issue answered ${answer.status}: ${answer.text.slice(0, 500)}`);
    const uuid = (answer.json as Json)?.uuid;
    if (!uuid) throw new Error(`issue answered without a certificate uuid: ${answer.text.slice(0, 500)}`);
    // the key is read once and kept, so a retry after a failed key delete still deletes it (the certificate is gone then)
    let keyUuid: string | undefined;
    cleanup.add('issued certificate', cn, async () => {
        keyUuid ??= await getCertificateKeyUuid(admin, uuid);
        await removeFromInventory(admin, uuid, keyUuid);
    });
    await waitForCertificateState(admin, uuid, 'issued', 120_000);
    return uuid;
}

/** Deletes the certificate and its key from the inventory; its authority still knows it. Nothing to do when it is gone. */
export async function removeFromInventory(admin: APIRequestContext, uuid: string, knownKeyUuid?: string): Promise<void> {
    const keyUuid = knownKeyUuid ?? await getCertificateKeyUuid(admin, uuid);
    await deleteCertificate(admin, uuid);
    if (keyUuid) await sendOk(admin, 'DELETE', '/api/v1/keys', [keyUuid]);
}

/** The certificate as an upload sends it, read from the inventory. */
export async function certificateFile(admin: APIRequestContext, uuid: string): Promise<CertificateFile> {
    const stored = await certificateDetail(admin, uuid);
    return { pem: derToPem(Buffer.from(String(stored.certificateContent), 'base64')), fingerprint: String(stored.fingerprint) };
}

/** How long the cleanup waits for a certificate that an accepted request stores, as `waitForCertificate` does. */
const STORED_LATER_MS = 60_000;

/** True when the reads over the wait never found the certificate; reads that keep failing leave it to the retried cleanup step. */
async function stillMissing(admin: APIRequestContext, fingerprint: string): Promise<boolean> {
    try {
        const row = await pollUntil(() => inventoryRow(admin, fingerprint, { includeArchived: true }), (found) => found !== undefined,
            { timeoutMs: STORED_LATER_MS, intervalMs: 3_000, onTimeout: 'return' });
        return row === undefined;
    } catch {
        return false;
    }
}

export interface CleanupStep {
    readonly describe: { resource: string; name?: string };
    readonly remove: () => Promise<unknown>;
    /** An earlier step that still refers to this object until it succeeds; when it fails, this object is kept and recorded instead. */
    requires?: CleanupStep;
    cleaned?: boolean;
    /** Set when kept: the root failure, so a cascade is recorded as one cause. */
    blockedBy?: string;
}

/** Everything a test creates, removed in dependency order by `run` (also after a failed test). */
export class Cleanup {
    private readonly steps: CleanupStep[] = [];
    /** Fingerprint → true while a request that stores the certificate is in flight or was accepted. */
    private readonly certificates = new Map<string, boolean>();
    private readonly keys = new Set<string>();
    private startedAt = new Date(Date.now() - 60_000);

    add(resource: string, ref: string, remove: () => Promise<unknown>): CleanupStep {
        const step: CleanupStep = { describe: { resource, name: ref }, remove };
        this.steps.unshift(step);
        return step;
    }

    /** A certificate the test may create. */
    certificate(fingerprint: string): void {
        if (!this.certificates.has(fingerprint)) this.certificates.set(fingerprint, false);
    }

    /** For a registered certificate: whether the platform may store it after the test, so the cleanup waits for it. */
    expectStored(fingerprint: string, expected: boolean): void {
        if (this.certificates.has(fingerprint)) this.certificates.set(fingerprint, expected);
    }

    /** A key in a token (made by an import); removed after the certificates and before the token. */
    key(keyUuid: string): void {
        this.keys.add(keyUuid);
    }

    /** Removes the certificates (archived ones too), then the keys they left, then the registered objects, last created first. */
    async run(admin: APIRequestContext): Promise<void> {
        const leftKeys = new Set<string>();
        const certificates = [...this.certificates];
        this.certificates.clear();
        for (const [fingerprint, storedLater] of certificates) {
            const describe = { resource: 'certificate', name: fingerprint };
            if (storedLater && await stillMissing(admin, fingerprint)) {
                recordCleanupFailure({
                    ...describe,
                    message: `an accepted request stores it, but it is not in the inventory after ${STORED_LATER_MS / 1000} s: it may still appear`,
                });
                continue;
            }
            await attemptCleanup(describe, async () => {
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
        const keys = [...this.keys];
        this.keys.clear();
        for (const keyUuid of keys) {
            await attemptCleanup({ resource: 'key', uuid: keyUuid }, () => sendOk(admin, 'DELETE', '/api/v1/keys', [keyUuid]));
        }
        for (const step of this.steps.splice(0)) {
            const referrer = step.requires;
            if (referrer && !referrer.cleaned) {
                step.blockedBy = referrer.blockedBy ?? referrer.describe.resource;
                recordCleanupFailure({
                    ...step.describe, message: `kept: the ${referrer.describe.resource} still refers to it`, blockedBy: step.blockedBy,
                });
                continue;
            }
            step.cleaned = await attemptCleanup(step.describe, step.remove);
        }
    }
}

/** The uuid of the platform user with the username. */
export async function userUuid(admin: APIRequestContext, username: string): Promise<string> {
    const answer = (await sendOk(admin, 'GET', `/api/v1/users?username=${encodeURIComponent(username)}`)).json as Json[] | Json;
    const users = (Array.isArray(answer) ? answer : (answer.users ?? [])) as Json[];
    const user = users.find((u) => u.username === username);
    if (!user) throw new Error(`The user ${username} was not found in the user list`);
    return String(user.uuid);
}

export async function createTeamUser(
    admin: APIRequestContext, cleanup: Cleanup, username: string,
): Promise<{ uuid: string; username: string }> {
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

export async function createCustomAttribute(
    admin: APIRequestContext, cleanup: Cleanup, name: string,
): Promise<{ uuid: string; name: string; contentType: string }> {
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

export interface TriggerSpec {
    name: string;
    /** Conditions on the certificate: the trigger applies when every item holds. */
    conditions: ConditionItem[];
    ignore?: boolean;
    /** Execution items of the "set field" action, or the notification profile of the "send notification" action. */
    setFields?: ExecutionItem[];
    notificationProfileUuid?: string;
}

interface Created { uuid: string; step: CleanupStep }

async function create(admin: APIRequestContext, cleanup: Cleanup, kind: string, body: Json): Promise<Created> {
    const created = await sendOk(admin, 'POST', `/api/v1/workflows/${kind}`, body);
    const uuid = (created.json as Json).uuid as string;
    return {
        uuid,
        step: cleanup.add(`workflow ${kind}`, String(body.name), () => sendOk(admin, 'DELETE', `/api/v1/workflows/${kind}/${uuid}`)),
    };
}

/** A trigger chain on "Certificate uploaded", added to the global platform list (callers are exclusive); `cleanup` restores the list. */
export async function createUploadTrigger(admin: APIRequestContext, cleanup: Cleanup, spec: TriggerSpec): Promise<string> {
    const condition = await create(admin, cleanup, 'conditions', {
        name: `${spec.name}-c`, description: 'Epic test', type: 'checkField', resource: 'certificates', items: spec.conditions,
    });
    const rule = await create(admin, cleanup, 'rules', {
        name: `${spec.name}-r`, description: 'Epic test', resource: 'certificates', conditionsUuids: [condition.uuid],
    });
    // each object is removed only after the one that refers to it: the platform list, the trigger, then rule and action
    condition.step.requires = rule.step;
    let action: Created | undefined;
    if (!spec.ignore) {
        const execution = await create(admin, cleanup, 'executions', spec.notificationProfileUuid
            ? {
                name: `${spec.name}-e`, description: 'Epic test', type: 'sendNotification', resource: 'certificates',
                items: [{ notificationProfileUuid: spec.notificationProfileUuid }],
            }
            : {
                name: `${spec.name}-e`, description: 'Epic test', type: 'setField', resource: 'certificates',
                items: spec.setFields ?? [],
            });
        action = await create(admin, cleanup, 'actions', {
            name: `${spec.name}-a`, description: 'Epic test', resource: 'certificates', executionsUuids: [execution.uuid],
        });
        execution.step.requires = action.step;
    }
    const trigger = await create(admin, cleanup, 'triggers', {
        name: spec.name,
        description: 'Epic test',
        type: 'event',
        resource: 'certificates',
        event: UPLOAD_EVENT,
        ignoreTrigger: spec.ignore ?? false,
        rulesUuids: [rule.uuid],
        actionsUuids: action ? [action.uuid] : [],
    });
    rule.step.requires = trigger.step;
    if (action) action.step.requires = trigger.step;
    await associateWithUploadEvent(admin, cleanup, trigger);
    return trigger.uuid;
}

/** The platform-level triggers on the upload event (getPlatformTriggerGate reads the same, but needs a regression-guarded context). */
export async function platformTriggers(admin: APIRequestContext): Promise<string[]> {
    const answer = await sendOk(admin, 'GET', '/api/v1/settings/events');
    return (((answer.json as Json).eventsMapping ?? {})[UPLOAD_EVENT] ?? []) as string[];
}

/** True when the item can never hold for a certificate with the common name; items the helper cannot judge count as possibly holding. */
function failsForCommonName(item: ConditionItem, cn: string): boolean {
    if (item.fieldSource !== 'property' || item.fieldIdentifier !== CERT_FIELD.commonName || typeof item.value !== 'string') return false;
    const [name, value] = [cn.toLowerCase(), item.value.toLowerCase()];
    switch (item.operator) {
        case 'EQUALS': return name !== value;
        case 'NOT_EQUALS': return name === value;
        case 'STARTS_WITH': return !name.startsWith(value);
        case 'ENDS_WITH': return !name.endsWith(value);
        case 'CONTAINS': return !name.includes(value);
        default: return false;
    }
}

/**
 * The platform triggers on the upload event that may apply to a certificate with the common name: every trigger except those
 * whose rules each hold a condition with an item that cannot hold for it. Others' triggers that do not match the subject do not matter.
 */
export async function platformTriggersMatching(admin: APIRequestContext, cn: string): Promise<string[]> {
    const matching: string[] = [];
    for (const uuid of await platformTriggers(admin)) {
        const rules = ((await sendOk(admin, 'GET', `/api/v1/workflows/triggers/${uuid}`)).json as Json).rules as Json[] | undefined ?? [];
        const ruleFails = (rule: Json): boolean =>
            ((rule.conditions ?? []) as Json[]).some((c) => ((c.items ?? []) as ConditionItem[]).some((item) => failsForCommonName(item, cn)));
        if (rules.length === 0 || !rules.every(ruleFails)) matching.push(uuid);
    }
    return matching;
}

/**
 * Takes this test's trigger off the platform list, as the list is now: triggers others added meanwhile stay. A read of the list that
 * fails stops the restore, so no trigger is dropped from it.
 */
async function restorePlatformTriggers(admin: APIRequestContext, own: string): Promise<void> {
    const now = await platformTriggers(admin);
    await sendOk(admin, 'PATCH', '/api/v1/settings/events', { event: UPLOAD_EVENT, triggerUuids: now.filter((uuid) => uuid !== own) });
}

async function associateWithUploadEvent(admin: APIRequestContext, cleanup: Cleanup, trigger: Created): Promise<void> {
    const before = await platformTriggers(admin);
    // Registered before the change and required by the trigger's delete: the platform list never names a deleted trigger.
    trigger.step.requires = cleanup.add('platform trigger list of the upload event', UPLOAD_EVENT, () =>
        restorePlatformTriggers(admin, trigger.uuid));
    await sendOk(admin, 'PATCH', '/api/v1/settings/events', { event: UPLOAD_EVENT, triggerUuids: [...before, trigger.uuid] });
    logger.info(`Platform triggers on the upload event: ${before.length} before, ${before.length + 1} now`);
}

/** A subject name that only this run's triggers' conditions match. */
export const subjectOf = (runPrefix: string, scenario: string): string => `${runPrefix}-${scenario}.example.com`;

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

/** The certificate's event-history rows of the trigger (getObjectHistory reads the same, but needs a regression-guarded context). */
export async function triggerRows(admin: APIRequestContext, certificateUuid: string, triggerUuid: string): Promise<Json[]> {
    const answer = await sendOk(
        admin, 'GET', `/api/v1/workflows/events/certificates/${certificateUuid}/history?itemsPerPage=100&pageNumber=1`,
    );
    return (((answer.json as Json).items ?? []) as Json[]).filter((row) => row.trigger?.uuid === triggerUuid);
}

/** The signed-in account's "has been uploaded" internal notifications for the subject (newest first). */
export async function uploadNotifications(api: APIRequestContext, cn: string): Promise<Json[]> {
    const answer = await sendOk(api, 'GET', '/api/v1/notifications?itemsPerPage=100&pageNumber=1');
    return (((answer.json as Json).items ?? []) as Json[])
        .filter((n) => String(n.message).includes(`CN=${cn}`) && String(n.message).includes('has been uploaded'));
}

/** A token on the software cryptography provider with an enabled token profile, the key destination of a PKCS#12 import. */
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
    const tokenStep = cleanup.add('token', name, () => sendOk(admin, 'DELETE', `/api/v1/tokens/${tokenUuid}`));
    const profile = await sendOk(admin, 'POST', `/api/v1/tokens/${tokenUuid}/tokenProfiles`, {
        name: `${name}-profile`,
        description: 'Epic test token profile',
        attributes: [],
        customAttributes: await requiredCustomAttributes(admin, 'tokenProfiles', name),
        enabled: true,
        usage: [...PROFILE_USAGES],
    });
    const profileUuid = (profile.json as Json).uuid as string;
    const profileStep = cleanup.add('token profile', `${name}-profile`, () =>
        sendOk(admin, 'DELETE', `/api/v1/tokens/${tokenUuid}/tokenProfiles/${profileUuid}`));
    tokenStep.requires = profileStep;
    // every key on this test's own token goes, also those of an import whose answer the test never read
    profileStep.requires = cleanup.add('keys on the token profile', `${name}-profile`, async () => {
        const pairs = (await sendOk(admin, 'GET', `/api/v1/keys/pairs?tokenProfileUuid=${profileUuid}`)).json;
        if (!Array.isArray(pairs)) throw new Error('keys on the token profile: unexpected answer (not a list)');
        const own = (pairs as Json[]).filter((k) => k.tokenInstanceUuid === tokenUuid).map((k) => String(k.uuid));
        if (own.length) await sendOk(admin, 'DELETE', '/api/v1/keys', own);
    });
    return profileUuid;
}
