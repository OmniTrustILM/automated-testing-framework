/**
 * platform — unit tests of the pure parts of the platform/ helpers: algorithm cases, key and token request bodies,
 * the scheduler's cron subset and system-job checks, the upgrade snapshot diff, secret and compliance helpers, the local
 * stack's compose arguments and refusals, the scheduled-job teardown handler and the core restart plan (fake runners
 * and fake APIs only).
 */
import type { APIRequestContext } from '@playwright/test';
import { fakeResponse } from './helpers/fakeResponse';
import type { LedgerLine } from '../../utils/regression/ledger/ledger';
import { partialOf } from './helpers/guardRig';
import { expect, test } from '@playwright/test';
import {
    absentFamilies, algorithmListProblems, encryptedFamilies, FAMILIES, Family, MATRIX, expectedItemUsages, generatedFamilies, namesForbiddenDigest, offeredAlgorithms, pickSignatureOption, sameUsages, signedFamilies, signVariants,
} from '../../utils/regression/platform/cryptoAlgorithmCases';
import { eventsOf, itemOf, KEY_EVENT, keyCreateBody, keyItemsOf, keyRequestAttributes } from '../../utils/regression/platform/keys';
import { tokenAlias, tokenRequestAttributes } from '../../utils/regression/platform/tokens';
import { requestAttributesFrom } from '../../utils/regression/customAttributes';
import { expectedOverallStatus } from '../../utils/regression/platform/complianceProfiles';
import { findConnectorWithInterface } from '../../utils/regression/platform/connectorLookup';
import { secretAttributesFor, secretContentFor, stringValues, waitForSecretState } from '../../utils/regression/platform/secretsAndVaults';
import { composeArgs, coreStartLogFacts, PlatformStack, stackConfig, stackProblem, restartCore, restartPlan } from '../../utils/regression/platform/localStack';
import { isFireTime, nextFireUtc, parseQuartzCron, SYSTEM_JOBS, systemJobProblems, JOBS_URL, teardownHandlers } from '../../utils/regression/platform/schedulerApi';
import { diffSnapshots, parseSchemaHistory, schemaHistoryProblems, Snapshot, upgradeDirectionProblem } from '../../utils/regression/platform/upgradeRunner';
import { randomUUID } from 'node:crypto';
import type { JsonObject } from '../../utils/regression/json';
import { handlerOf, TeardownContext } from '../../utils/regression/teardown/runTeardown';
import * as fs from 'fs';
import * as path from 'path';
import { localProofFile } from '../../utils/regression/tier/localProof';
import { tierIdentity } from '../../utils/regression/tier/kind';
import { blockedConnectors, judgeHealth, parseConnectorVersion, requiredConnectors } from '../../utils/regression/platform/connectorApi';

// ------------------------------------------------------------------ cryptoAlgorithmCases

test('algorithm cases are consistent: every cell is known, signed and encrypted families are generated ones, encrypt is RSA only, absent families are not generated', () => {
    const providers = ['scp-v1', 'scp-v2', 'pkcs11'] as const;
    for (const provider of providers) {
        const generated = generatedFamilies(provider);
        for (const f of Object.keys(MATRIX) as Family[]) expect(['G', 'GS', 'GSE', 'obs', '?', 'absent'], `${f} on ${provider}`).toContain(MATRIX[f][provider]);
        for (const f of signedFamilies(provider)) expect(generated, `${f} is signed on ${provider}, so it is generated`).toContain(f);
        for (const f of encryptedFamilies(provider)) {
            expect(signedFamilies(provider), `${f} is encrypted on ${provider}, so it is signed`).toContain(f);
            expect(FAMILIES[f].algorithm, `${f}: encrypt / decrypt cells are RSA only`).toBe('RSA');
        }
        for (const f of absentFamilies(provider)) expect(generated, `${f} is absent on ${provider}`).not.toContain(f);
    }
    for (const f of Object.keys(MATRIX) as Family[]) expect(FAMILIES[f]?.family, `${f} has a family entry`).toBe(f);
});

test('sign variants: RSA = 2 schemes × 3 digests, EC = 3 digests, PQC = one; the picker matches the live option text', () => {
    expect(signVariants('rsa-2048')).toHaveLength(6);
    expect(signVariants('ec-p384')).toHaveLength(3);
    expect(signVariants('ml-dsa-65')).toHaveLength(1);
    const options = [
        { reference: 'RSASSA-PKCS1-v1_5 with SHA-256', data: 'RSA_PKCS1_SHA256' }, { reference: 'RSASSA-PSS with SHA-512', data: 'RSA_PSS_SHA512' },
        { reference: 'ECDSA with SHA-384', data: 'ECDSA_SHA384' }, { reference: 'ML-DSA-65', data: 'ML-DSA-65' }, { reference: 'FALCON-1024', data: 'FALCON-1024' },
    ];
    expect(pickSignatureOption(options, { family: 'rsa-2048', scheme: 'PKCS1-v1_5', digest: 'SHA-256', label: '' })?.data).toBe('RSA_PKCS1_SHA256');
    expect(pickSignatureOption(options, { family: 'rsa-2048', scheme: 'PSS', digest: 'SHA-512', label: '' })?.data).toBe('RSA_PSS_SHA512');
    expect(pickSignatureOption(options, { family: 'rsa-2048', scheme: 'PSS', digest: 'SHA-256', label: '' })).toBeUndefined();
    expect(pickSignatureOption(options, { family: 'ec-p256', digest: 'SHA-384', label: '' })?.data).toBe('ECDSA_SHA384');
    expect(pickSignatureOption(options, { family: 'ml-dsa-65', label: '' })?.data).toBe('ML-DSA-65');
    expect(pickSignatureOption(options, { family: 'ml-dsa-44', label: '' })).toBeUndefined();
    expect(namesForbiddenDigest(options)).toEqual([]);
    expect(namesForbiddenDigest([{ reference: 'RSA with SHA-1', data: 'x' }, { reference: 'MD5withRSA', data: 'y' }])).toHaveLength(2);
    expect(namesForbiddenDigest([{ reference: 'SHA-1024', data: 'z' }]), 'SHA-1 does not match SHA-1024').toEqual([]);
});

test('key usages: private sign + decrypt, public verify + encrypt, ECDSA never encrypts; the algorithm verdicts', () => {
    expect(expectedItemUsages(['sign', 'verify', 'encrypt', 'decrypt'], 'private', 'RSA')).toEqual(['sign', 'decrypt']);
    expect(expectedItemUsages(['sign', 'verify', 'encrypt', 'decrypt'], 'public', 'RSA')).toEqual(['verify', 'encrypt']);
    expect(expectedItemUsages(['sign', 'verify', 'encrypt', 'decrypt'], 'private', 'ECDSA')).toEqual(['sign']);
    expect(sameUsages(['verify', 'sign'], ['sign', 'verify'])).toBe(true);
    const v = algorithmListProblems('scp-v2', ['RSA', 'ECDSA', 'ML-DSA', 'FALCON', 'SLH-DSA', 'ML-KEM', 'Unknown']);
    expect(v).toEqual({ missing: [], forbidden: [], neverOffered: ['Unknown'] });
    expect(algorithmListProblems('pkcs11', ['RSA', 'FALCON'])).toEqual({ missing: ['ECDSA'], forbidden: ['FALCON'], neverOffered: [] });
    expect(offeredAlgorithms([{ name: 'data_keyAlgorithm', content: [{ reference: 'RSA', data: 'RSA' }, { data: 'ECDSA' }] }])).toEqual(['RSA', 'ECDSA']);
});

// ------------------------------------------------------------------ token and key request builders (pure)

test('tokenAlias: letters, digits and single underscores, a letter first; the token request attributes follow the live schema', () => {
    expect(tokenAlias('qa-reg-20261014-160000-ab12-tok')).toBe('qa_reg_20261014_160000_ab12_tok');
    expect(tokenAlias('9-x')).toBe('t_9_x');
    expect(tokenAlias('a--b__c')).toBe('a_b_c');
    const without = tokenRequestAttributes([{ name: 'data_createTokenAction', uuid: 'u1' }], 'alias_1', 'c0de');
    expect(without.map((a) => a.name)).toEqual(['data_createTokenAction', 'data_newTokenName', 'data_tokenCode']);
    expect(without[0].uuid).toBe('u1');
    expect((without[2].content as JsonObject[])[0].data).toEqual({ secret: 'c0de' });
    const withOptions = tokenRequestAttributes([{ name: 'data_options' }], 'alias_1', 'c0de');
    expect(withOptions[0]).toMatchObject({ name: 'data_options', content: [{ data: 'new' }] });
});

test('keyRequestAttributes: the live algorithm option, the SCP size / curve / level child, no spec attribute for FALCON; an unoffered algorithm throws', () => {
    const defs = [{ name: 'data_keyAlgorithm', uuid: 'alg', content: [{ reference: 'RSA', data: 'RSA' }, { reference: 'ECDSA', data: 'ECDSA' }, { reference: 'FALCON', data: 'FALCON' }] }, { name: 'data_keyAlias', uuid: 'alias' }];
    const rsa = keyRequestAttributes(defs, 'rsa-4096', 'k_1');
    expect(rsa.map((a) => a.name)).toEqual(['data_keyAlias', 'data_keyAlgorithm', 'data_rsaKeySize']);
    expect(rsa[2]).toMatchObject({ contentType: 'integer', content: [{ reference: 'RSA_4096', data: 4096 }] });
    expect(keyRequestAttributes(defs, 'ec-p256', 'k')[2]).toMatchObject({ name: 'data_ecdsaCurve', content: [{ reference: 'secp256r1', data: 'secp256r1' }] });
    expect(keyRequestAttributes(defs, 'falcon-1024', 'k')).toHaveLength(2);
    expect((keyRequestAttributes(defs, 'rsa-2048', 'k', 3072)[2].content as JsonObject[])[0]).toEqual({ reference: '3072', data: 3072 });
    expect(() => keyRequestAttributes(defs, 'ml-dsa-65', 'k')).toThrow(/not offered/);
    const body = keyCreateBody(defs, 'qa-reg-x-key', { family: 'rsa-2048', exportable: true }, []);
    expect(body).toMatchObject({ name: 'qa-reg-x-key', enabled: false, exportable: true, groupUuids: [] });
    expect(((body.attributes as JsonObject[])[0].content as JsonObject[])[0].data).toBe('qa_reg_x_key');
});

test('itemOf / keyItemsOf / eventsOf read a key detail and a history', () => {
    const detail = { items: [{ uuid: 'p', type: 'PrivateKey' }, { uuid: 'q', type: 'Public' }] };
    expect(itemOf(detail, 'private')?.uuid).toBe('p');
    expect(keyItemsOf(detail)).toEqual({ privateUuid: 'p', publicUuid: 'q' });
    // The wire carries the @JsonValue CODE of KeyEvent ('Enable Key'), never the enum name.
    const history = [{ event: 'Enable Key', status: 'SUCCESS' }, { event: 'Enable Key', status: 'FAILED' }, { event: 'Disable Key', status: 'SUCCESS' }, { event: 'EnableKey', status: 'SUCCESS' }];
    expect(eventsOf(history, 'ENABLE')).toHaveLength(2);
    expect(eventsOf(history, 'ENABLE', 'SUCCESS')).toHaveLength(1);
    expect(eventsOf(history, 'DISABLE')).toHaveLength(1);
    expect(KEY_EVENT).toEqual({
        CREATE: 'Create Key', IMPORT: 'Import Key', EXPORT: 'Export Key', EXPORT_DISABLED: 'Disable Key Export', COMPROMISED: 'Compromised Key', DESTROY: 'Destroy Key',
        UPDATE_USAGE: 'Update Key Usages', SIGN: 'Sign Data', VERIFY: 'Verify Data', ENCRYPT: 'Encrypt Data', DECRYPT: 'Decrypt Data', ENABLE: 'Enable Key', DISABLE: 'Disable Key',
    });
});

// ------------------------------------------------------------------ schedulerApi

test('Quartz subset: the six system crons parse; next fire in UTC; isFireTime; system-job problems', () => {
    for (const j of SYSTEM_JOBS) expect(() => parseQuartzCron(j.cron)).not.toThrow();
    const from = new Date('2026-10-14T10:17:30Z');
    expect(nextFireUtc('0 0 * ? * *', from).toISOString()).toBe('2026-10-14T11:00:00.000Z');
    expect(nextFireUtc('0 30 * ? * *', from).toISOString()).toBe('2026-10-14T10:30:00.000Z');
    expect(nextFireUtc('0 15 3 ? * *', from).toISOString()).toBe('2026-10-15T03:15:00.000Z');
    // 2026-10-14 is a Wednesday: the next Sunday 02:30 UTC is 2026-10-18.
    expect(nextFireUtc('0 30 2 ? * SUN', from).toISOString()).toBe('2026-10-18T02:30:00.000Z');
    expect(nextFireUtc('0 0 * ? * *', new Date('2026-10-14T11:00:00Z')).toISOString(), 'strictly after').toBe('2026-10-14T12:00:00.000Z');
    expect(isFireTime('0 30 2 ? * SUN', new Date('2026-10-18T02:30:00Z'))).toBe(true);
    expect(isFireTime('0 30 2 ? * SUN', new Date('2026-10-18T03:30:00Z')), 'another zone would land here').toBe(false);
    expect(() => parseQuartzCron('0 0 0 29 2 ? 2027')).toThrow(/year/);
    expect(() => parseQuartzCron('0 0 L * * ?')).toThrow(/unsupported|out of range/);

    const jobs = SYSTEM_JOBS.map((j) => ({ jobName: j.jobName, cronExpression: j.cron, system: true, oneTime: false, jobType: j.task, enabled: true, scheduleState: 'scheduled' }));
    expect(systemJobProblems(jobs)).toEqual([]);
    const broken = jobs.map((j, i) => (i === 0 ? { ...j, cronExpression: '0 5 * ? * *' } : j)).concat([{ jobName: 'extraJob', cronExpression: '* * * ? * *', system: true, oneTime: false, jobType: 'X', enabled: true, scheduleState: 'scheduled' }]);
    expect(systemJobProblems(broken)).toEqual([`${SYSTEM_JOBS[0].jobName}: cron "0 5 * ? * *" (expected "0 0 * ? * *")`, 'unexpected system job extraJob']);
    expect(systemJobProblems(jobs.slice(1))).toEqual([`system job ${SYSTEM_JOBS[0].jobName} is missing`]);
});

// ------------------------------------------------------------------ upgradeRunner

const snap = (types: Snapshot['types'], extra: Partial<Snapshot> = {}): Snapshot => ({
    takenAt: 't', types, certificatesTotal: 10, auditLogTotal: 100, connectorStatuses: { A: 'connected' }, schemaHistory: [], ...extra,
});

test('diffSnapshots: kept objects pass; a lost or renamed object, a new non-system user, a reset audit log and an offline connector fail; system extras are reported', () => {
    const before = snap({ roles: { count: 2, objects: { rA: 'qa-reg-role', rB: 'admin' } }, groups: { count: 1, objects: { g1: 'g' } } });
    expect(diffSnapshots(before, before)).toEqual({ problems: [], systemExtras: [] });
    const after = snap({ roles: { count: 3, objects: { rA: 'qa-reg-role', rB: 'admin', rC: 'acme' } }, groups: { count: 1, objects: { g1: 'g' } } });
    expect(diffSnapshots(before, after)).toEqual({ problems: [], systemExtras: ['roles: acme (rC)'] });
    const bad = snap({ roles: { count: 2, objects: { rA: 'qa-reg-role-x', rX: 'someone' } }, groups: { count: 0, objects: {} } }, { auditLogTotal: 5, connectorStatuses: { A: 'offline' } });
    const r = diffSnapshots(before, bad);
    expect(r.problems).toEqual(expect.arrayContaining([
        'roles: rA renamed qa-reg-role → qa-reg-role-x', 'roles: rB (admin) is gone', 'roles: unexpected new someone (rX)', 'groups: g1 (g) is gone',
        'audit log total 100 → 5 (the 2.14 reset must not be crossed)', 'connector A: connected → offline',
    ]));
});

test('schemaHistoryProblems: rows kept with the same checksum, new rows success, out-of-order detected; parse of psql rows; one-way guard', () => {
    const before = parseSchemaHistory(['1||schema|0|t', '2|202501010000|a|111|t', '3|2026031912128|secret compliance|222|t']);
    const after = parseSchemaHistory(['1||schema|0|t', '2|202501010000|a|111|t', '3|2026031912128|secret compliance|222|t', '4|202610081500|newer|333|t']);
    expect(schemaHistoryProblems(before, after)).toEqual({ problems: [], newVersions: ['202610081500'], outOfOrder: true });
    const changed = parseSchemaHistory(['1||schema|0|t', '2|202501010000|a|999|t', '3|2026031912128|secret compliance|222|f', '4|202610081500|newer|333|f']);
    expect(schemaHistoryProblems(before, changed).problems).toEqual([
        'schema history rank 2: 202501010000/111 → 202501010000/999', 'schema history rank 3 (2026031912128) is not success', 'new migration 202610081500 is not success',
    ]);
    expect(upgradeDirectionProblem('2.19.1', '2.20.0-SNAPSHOT')).toBeUndefined();
    expect(upgradeDirectionProblem('2.20.1', '2.20.0')).toMatch(/never a downgrade/);
    expect(upgradeDirectionProblem('latest', '2.20.0')).toMatch(/cannot compare/);
});

// ------------------------------------------------------------------ secretsAndVaults and complianceProfiles (pure)

test('requestAttributesFrom fills required data attributes by type and given values by name; secretAttributesFor; the overall compliance status; stringValues', () => {
    const defs = [
        { name: 'data_user', contentType: 'string', type: 'data', properties: { required: true } },
        { name: 'data_pass', contentType: 'secret', type: 'data', properties: { required: true } },
        { name: 'data_opt', contentType: 'string', type: 'data', properties: { required: false } },
        { name: 'data_list', contentType: 'string', type: 'data', properties: { required: true, list: true }, content: [{ reference: 'A', data: 'a' }] },
        { name: 'info_x', contentType: 'text', type: 'info', properties: { required: true } },
    ];
    const out = requestAttributesFrom(defs, { data_user: 'qa' }, 'fb');
    expect(out.map((a) => a.name)).toEqual(['data_user', 'data_pass', 'data_list']);
    expect(out[0].content).toEqual([{ data: 'qa' }]);
    expect(out[1].content).toEqual([{ data: { secret: 'fb' } }]);
    expect(out[2].content, 'the list item is completed with the definition\'s contentType (seen on a live tier)').toEqual([{ reference: 'A', data: 'a', contentType: 'string' }]);
    expect(() => requestAttributesFrom([{ name: 'x', contentType: 'file', type: 'data', properties: { required: true } }])).toThrow(/cannot fill/);
    const secret = secretAttributesFor([{ name: 'data_username', contentType: 'string', type: 'data', properties: { required: true } }, { name: 'data_password', contentType: 'secret', type: 'data', properties: { required: true } }], 'basicAuth', 'v4lue', 'bob');
    expect(secret).toEqual([{ name: 'data_username', uuid: undefined, version: 'v2', contentType: 'string', content: [{ data: 'bob' }] }, { name: 'data_password', uuid: undefined, version: 'v2', contentType: 'secret', content: [{ data: { secret: 'v4lue' } }] }]);
    expect(expectedOverallStatus(['ok', 'ok'])).toBe('ok');
    expect(expectedOverallStatus(['ok', 'nok'])).toBe('nok');
    expect(expectedOverallStatus([])).toBe('na');
    expect(expectedOverallStatus(['na'])).toBe('na');
    expect(stringValues({ a: 'x', b: [1, 'y', { c: 'z' }] })).toEqual(['x', 'y', 'z']);
});

// ------------------------------------------------------------------ localStack (pure + fake runner)

test('composeArgs and the stack commands with a fake runner; refusals without a local tier or a loopback BASE_URL', () => {
    const cfg = stackConfig({ LOCAL_COMPOSE_FILE: '/x/compose.yml', LOCAL_COMPOSE_PROJECT: 'proj', LOCAL_SERVICE_DB: 'postgres', REG_DOCKER_BIN: '/tmp/fake-docker' });
    expect(composeArgs(cfg, 'stop', 'core')).toEqual(['compose', '-f', '/x/compose.yml', '-p', 'proj', 'stop', 'core']);
    const calls: string[][] = [];
    const runner = (bin: string, args: string[]) => {
        calls.push([bin, ...args]);
        return { ok: true, status: 0, stdout: args[0] === 'exec' ? 'a|b\n' : '', stderr: '' };
    };
    expect(stackProblem({ TIER_KIND: 'shared', BASE_URL: 'http://127.0.0.1:3080' })).toMatch(/TIER_KIND=local/);
    expect(stackProblem({ TIER_KIND: 'local', BASE_URL: 'https://qa.example.com' })).toMatch(/loopback/);
    const remote = new PlatformStack(cfg, runner, { TIER_KIND: 'shared', BASE_URL: 'http://127.0.0.1:3080' });
    expect(() => remote.stop('core')).toThrow(/TIER_KIND=local/);
    expect(calls).toEqual([]);
});

test('coreStartLogFacts reads the Flyway line, ERROR lines and the auth sync', () => {
    const log = 'INFO Successfully applied 212 migrations to schema "core", now at version v2026031912128\nWARN outOfOrder mode is active\nINFO Sync operation completed\n';
    expect(coreStartLogFacts(log)).toEqual({ appliedMigrations: 212, nowAtVersion: '2026031912128', validatedOnly: false, errors: [], syncCompleted: true, syncFailed: false });
    const validated = 'INFO Successfully validated 212 migrations\nINFO Schema "core" is up to date. No migration necessary.\nERROR Unable to synchronize resources with Auth Service: x\n';
    const f = coreStartLogFacts(validated);
    expect(f.validatedOnly).toBe(true);
    expect(f.errors).toHaveLength(1);
    expect(f.syncFailed).toBe(true);
});

// ------------------------------------------------------------------ secret body and connector lookup

interface Call { method: string; url: string; data?: unknown }

function fakeApi(handler: (c: Call) => { status: number; body?: unknown }) {
    const calls: Call[] = [];
    const reply = (c: Call) => {
        calls.push(c);
        const r = handler(c);
        return fakeResponse(r);
    };
    const api = {
        get: async (url: string) => reply({ method: 'GET', url }),
        post: async (url: string, o?: { data?: unknown }) => reply({ method: 'POST', url, data: o?.data }),
        delete: async (url: string, o?: { data?: unknown }) => reply({ method: 'DELETE', url, data: o?.data }),
    };
    return { api, calls };
}

test('core\'s secret body (secret polymorphic on type), and the credential provider v2 is found by either spelling', async () => {
    expect(secretContentFor('generic', 'val')).toEqual({ type: 'generic', content: 'val' });
    expect(secretContentFor('apiKey', 'val')).toEqual({ type: 'apiKey', content: 'val' });
    const generated = `qa-${randomUUID().slice(0, 8)}`;
    expect(secretContentFor('basicAuth', generated)).toEqual({ type: 'basicAuth', username: 'qa', password: generated });
    const rows = [
        { uuid: 'c1', name: 'Other-Provider', status: 'connected', functionGroups: [] },
        { uuid: 'c2', name: 'Common-Credential-Connector v2', status: 'connected', functionGroups: [{ functionGroupCode: 'credentialProvider' }] },
    ];
    const { api } = fakeApi((c) => {
        if (c.url === '/api/v1/connectors') return { status: 200, body: rows };
        if (c.url === '/api/v2/connectors/c1') return { status: 200, body: { interfaces: [{ uuid: 'i1', code: 'secret' }] } };
        if (c.url === '/api/v2/connectors/c2') return { status: 200, body: { interfaces: [{ uuid: 'i2', code: 'secret' }] } };
        return { status: 404, body: {} };
    });
    const found = await findConnectorWithInterface(partialOf<APIRequestContext>(api), /^secret/i, {} as NodeJS.ProcessEnv);
    expect(found, 'the space-spelled credential provider wins over the first connected connector').toMatchObject({ uuid: 'c2', interfaceUuid: 'i2' });
});

// ------------------------------------------------------------------ waitForSecretState (own fake API, block scope)

{
    function fakeApi(handler: (url: string) => { status: number; body?: unknown }) {
        const calls: string[] = [];
        const get = async (url: string) => {
            calls.push(url);
            const r = handler(url);
            return fakeResponse(r);
        };
        return { api: partialOf<APIRequestContext>({ get }), calls };
    }

    const U = (n: number): string => `aaaaaaaa-0000-4000-8000-${String(n).padStart(12, '0')}`;

    test('waitForSecretState: inactive, then active -> the detail; polls the API state', async () => {
        const states = ['inactive', 'inactive', 'active'];
        const { api, calls } = fakeApi(() => ({ status: 200, body: { state: states.shift() ?? 'active', enabled: false } }));
        const detail = await waitForSecretState(api, U(7), 'active', 5_000, 1);
        expect(detail.state).toBe('active');
        expect(calls).toEqual(Array(3).fill(`/api/v1/secrets/${U(7)}`));
    });

    test('waitForSecretState: failed stops at once; a secret that stays inactive times out with the detail', async () => {
        const failed = fakeApi(() => ({ status: 200, body: { state: 'failed' } }));
        await expect(waitForSecretState(failed.api, U(7), 'active', 5_000, 1)).rejects.toThrow(/is failed/);
        expect(failed.calls).toHaveLength(1);
        const stuck = fakeApi(() => ({ status: 200, body: { state: 'inactive' } }));
        await expect(waitForSecretState(stuck.api, U(7), 'active', 30, 5)).rejects.toThrow(/still inactive after 30 ms/);
    });
}

// ------------------------------------------------------------------ scheduledJobs teardown handler and stackConfig, own fake API (block scope)

{
    /**
     * Rows for the registry and stack-config pieces:
     * - the `scheduledJobs` teardown handler of `schedulerApi`: a job is read (200 → seen),
     *   a system job or a job with another name is refused, a 404 is done, a normal delete proves absence by the same GET;
     * - `HANDLER_MODULES.scheduledJobs` resolves to a handler (every ledger type a spec records has one);
     * - `stackConfig` reads both spellings of the compose settings (LOCAL_* and REG_LOCAL_*), the platform names first.
     */

    const JOB = 'aaaaaaaa-0000-4000-8000-000000000001';
    const RUN = 'qa-reg-20261014-120000-ab12';
    const line = (name = `${RUN}-job`) => partialOf<LedgerLine>({ type: 'scheduledJobs', uuid: JOB, name, event: 'created', runId: RUN });

    /** A fake API over one job: GET / DELETE with a call log. */
    function fakeApi(job: JsonObject | undefined, opts: { deleteStatus?: number; stillThere?: boolean } = {}) {
        const calls: string[] = [];
        let present = job !== undefined;
        const reply = (status: number, body?: unknown) => ({ status: () => status, ok: () => status >= 200 && status < 300, json: async () => body, text: async () => JSON.stringify(body ?? '') });
        const api = {
            get: async (url: string) => { calls.push(`GET ${url}`); return present ? reply(200, job) : reply(404, {}); },
            delete: async (url: string) => { calls.push(`DELETE ${url}`); const s = opts.deleteStatus ?? 204; if (s < 300 && !opts.stillThere) present = false; return reply(s, {}); },
        };
        return { api, calls };
    }

    const ctxOf = (api: unknown): TeardownContext => ({ api: partialOf<APIRequestContext>(api as Partial<APIRequestContext>), runId: RUN, ledger: [line()], seen: new Set(), tier: null, warn: () => undefined, pollMs: 1 });

    test('scheduledJobs handler: a 404 is done without a delete; a system job and a job with another name are refused with nothing deleted', async () => {
        const gone = fakeApi(undefined);
        await teardownHandlers.scheduledJobs.remove(ctxOf(gone.api), line());
        expect(gone.calls).toEqual([`GET ${JOBS_URL}/${JOB}`]);

        const system = fakeApi({ uuid: JOB, jobName: `${RUN}-job`, system: true });
        await expect(teardownHandlers.scheduledJobs.remove(ctxOf(system.api), line())).rejects.toThrow(/system job/);
        expect(system.calls.some((c) => c.startsWith('DELETE'))).toBe(false);

        const other = fakeApi({ uuid: JOB, jobName: 'someone-elses-job', system: false });
        await expect(teardownHandlers.scheduledJobs.remove(ctxOf(other.api), line())).rejects.toThrow(/name is not the ledger line/);
        expect(other.calls.some((c) => c.startsWith('DELETE'))).toBe(false);
    });

    test('scheduledJobs handler: an own job is read (200), deleted once and proven gone by the same GET; a delete that is refused or leaves the job fails the step', async () => {
        const ok = fakeApi({ uuid: JOB, jobName: `${RUN}-job`, system: false });
        const ctx = ctxOf(ok.api);
        await teardownHandlers.scheduledJobs.remove(ctx, line());
        expect(ok.calls).toEqual([`GET ${JOBS_URL}/${JOB}`, `DELETE ${JOBS_URL}/${JOB}`, `GET ${JOBS_URL}/${JOB}`]);
        expect(ctx.seen.has(JOB)).toBe(true);

        const executing = fakeApi({ uuid: JOB, jobName: `${RUN}-job` }, { deleteStatus: 422 });
        await expect(teardownHandlers.scheduledJobs.remove(ctxOf(executing.api), line())).rejects.toThrow(/Failed to delete scheduled job.*422/);

        const stuck = fakeApi({ uuid: JOB, jobName: `${RUN}-job` }, { stillThere: true });
        await expect(teardownHandlers.scheduledJobs.remove(ctxOf(stuck.api), line())).rejects.toThrow(/absence not proven/);
    });

    test('the registry resolves scheduledJobs to the schedulerApi handler (wrapped by wrapHandlerWithGuard); its plan line names the scheduler route', () => {
        const h = handlerOf('scheduledJobs');
        expect(h, 'a handler for scheduledJobs').toBeDefined();
        expect(h!.action).toMatch(/scheduler\/jobs/);
    });

    test('stackConfig reads LOCAL_* first and REG_LOCAL_* as the alias (the names the tier proof and the auth area documented)', () => {
        expect(stackConfig({ REG_LOCAL_COMPOSE_PROJECT: 'ilm', REG_LOCAL_COMPOSE_FILE: '/abs/c.yml', REG_LOCAL_SERVICE_CORE: 'core-api' } as NodeJS.ProcessEnv))
            .toMatchObject({ project: 'ilm', composeFile: '/abs/c.yml', services: { core: 'core-api' } });
        expect(stackConfig({ LOCAL_COMPOSE_PROJECT: 'a', REG_LOCAL_COMPOSE_PROJECT: 'b', LOCAL_SERVICE_CORE: 'x', REG_LOCAL_SERVICE_CORE: 'y' } as NodeJS.ProcessEnv))
            .toMatchObject({ project: 'a', services: { core: 'x' } });
        expect(stackConfig({} as NodeJS.ProcessEnv)).toMatchObject({ project: undefined, composeFile: undefined, services: { core: 'core' } });
    });
}

// ------------------------------------------------------------------ core restart on a proven local stack

{
    /**
     * the core restart (`localStack.restartCore`): it runs only on a proven local stack, restarts one named compose
     * service of one named project, and never touches the real docker CLI under the unit tests (a fake docker script inside the
     * test output logs its arguments).
     */

    const RUN = 'qa-reg-20261014-120000-ab12';

    function localEnv(dir: string, extra: Record<string, string> = {}): NodeJS.ProcessEnv {
        return { TIER_KIND: 'local', BASE_URL: 'http://127.0.0.1:8081/administrator/', REG_RUN_ID: RUN, REG_STATE_DIR: dir, ...extra };
    }

    function writeProof(env: NodeJS.ProcessEnv, at: Date = new Date()): void {
        fs.mkdirSync(env.REG_STATE_DIR!, { recursive: true });
        fs.writeFileSync(localProofFile(env), JSON.stringify({ runId: RUN, tier: tierIdentity(env), at: at.toISOString() }));
    }

    /** A fake docker (absolute path inside the test output): appends its arguments to a log. */
    function fakeDocker(dir: string): { bin: string; calls: () => string[] } {
        fs.mkdirSync(dir, { recursive: true });
        const log = path.join(dir, 'docker-calls.log');
        const bin = path.join(dir, 'fake-docker');
        fs.writeFileSync(bin, `#!${process.execPath}\nrequire('fs').appendFileSync(${JSON.stringify(log)}, process.argv.slice(2).join(' ') + '\\n');\n`);
        fs.chmodSync(bin, 0o755);
        return { bin, calls: () => (fs.existsSync(log) ? fs.readFileSync(log, 'utf8').trim().split('\n').filter(Boolean) : []) };
    }

    test('restartPlan refuses a shared tier, a run without the local-backend proof and a missing compose project; with all three it names the service', ({}, testInfo) => {
        const dir = testInfo.outputPath('state');
        expect(restartPlan({ TIER_KIND: 'shared' })).toEqual({ problem: expect.stringContaining('local stack') });
        const env = localEnv(dir, { REG_LOCAL_COMPOSE_PROJECT: 'ilm' });
        expect(restartPlan(env)).toEqual({ problem: expect.stringContaining('local-backend proof') });
        writeProof(env);
        expect(restartPlan(env)).toEqual({ args: ['compose', '-p', 'ilm', 'restart', 'core'] });
        expect(restartPlan({ ...env, REG_LOCAL_COMPOSE_FILE: '/abs/ilm-compose.yml', REG_LOCAL_SERVICE_CORE: 'core-api' })).toEqual({ args: ['compose', '-f', '/abs/ilm-compose.yml', '-p', 'ilm', 'restart', 'core-api'] });
        const noProject = localEnv(dir);
        writeProof(noProject);
        expect(restartPlan(noProject)).toEqual({ problem: expect.stringContaining('REG_LOCAL_COMPOSE_PROJECT') });
        // An expired proof (older than 6 h) does not unlock it.
        writeProof(env, new Date(Date.now() - 7 * 3600_000));
        expect(restartPlan(env)).toEqual({ problem: expect.stringContaining('local-backend proof') });
    });

    test('restartCore runs `docker compose -p <project> restart <service>` through REG_DOCKER_BIN once, and nothing when refused; the real docker is never used under the unit tests', ({}, testInfo) => {
        const dir = testInfo.outputPath('state');
        const docker = fakeDocker(testInfo.outputPath('bin'));
        const env = localEnv(dir, { REG_LOCAL_COMPOSE_PROJECT: 'ilm', REG_DOCKER_BIN: docker.bin });
        expect(() => restartCore(env)).toThrow(/local-backend proof/);
        expect(docker.calls()).toEqual([]);
        writeProof(env);
        restartCore(env);
        expect(docker.calls()).toEqual(['compose -p ilm restart core']);
        // Under REG_UNIT_NO_DOCKER only an absolute fake inside the test output may run: `docker` itself is refused.
        expect(process.env.REG_UNIT_NO_DOCKER).toBe('1');
        expect(() => restartCore({ ...env, REG_DOCKER_BIN: 'docker' })).toThrow(/real docker CLI is disabled/);
        expect(() => restartCore({ ...env, REG_DOCKER_BIN: '/usr/local/bin/docker' })).toThrow(/real docker CLI is disabled/);
        expect(docker.calls()).toHaveLength(1);
    });
}

// ------------------------------------------------------------------ connectorApi (pure)

test('parseConnectorVersion reads the interfaces ConnectorVersion codes and nothing else', () => {
    expect(parseConnectorVersion('v1')).toBe(1);
    expect(parseConnectorVersion('v2')).toBe(2);
    expect(parseConnectorVersion('V2')).toBe(2);
    expect(parseConnectorVersion(' v1 ')).toBe(1);
    expect(parseConnectorVersion(1)).toBe(1);
    expect(parseConnectorVersion(2)).toBe(2);
    for (const bad of ['v3', '3', 'version2', '', 'v', null, undefined, 1.5, {}, ['v1']]) expect(parseConnectorVersion(bad), String(bad)).toBeUndefined();
});

test('judgeHealth: v1 needs 200 + ok, v2 needs 200 + UP; anything else is unhealthy with the reason', () => {
    expect(judgeHealth(1, 200, { status: 'ok' })).toMatchObject({ healthy: true, status: 'ok' });
    expect(judgeHealth(2, 200, { status: 'UP', components: {} })).toMatchObject({ healthy: true, status: 'UP' });
    expect(judgeHealth(1, 200, { status: 'nok' })).toMatchObject({ healthy: false, why: 'v1 status nok (expected ok)' });
    expect(judgeHealth(2, 200, { status: 'ok' })).toMatchObject({ healthy: false });
    expect(judgeHealth(1, 200, { status: 'UP' })).toMatchObject({ healthy: false });
    expect(judgeHealth(2, 200, { status: 'DEGRADED' })).toMatchObject({ healthy: false });
    expect(judgeHealth(2, 503, { status: 'DOWN' })).toMatchObject({ healthy: false, status: 'DOWN', why: 'live health 503' });
    expect(judgeHealth(1, 404, undefined)).toMatchObject({ healthy: false, why: 'live health 404' });
    expect(judgeHealth(2, 200, 'UP')).toMatchObject({ healthy: false, why: 'v2 health body without a status' });
});

test('REG_REQUIRED_CONNECTORS / REG_BLOCKED_CONNECTORS', () => {
    expect(requiredConnectors({})).toEqual(['Common-Credential-Connector', 'MS-ADCS-NG-Connector']);
    expect(requiredConnectors({ REG_REQUIRED_CONNECTORS: ' A , B,,A ' })).toEqual(['A', 'B']);
    expect([...blockedConnectors({})]).toEqual([]);
    expect([...blockedConnectors({ REG_BLOCKED_CONNECTORS: '  ' })]).toEqual([]);
    expect([...blockedConnectors({ REG_BLOCKED_CONNECTORS: 'MS-ADCS-NG-Connector: health 503, DevOps ticket; X:a:b' })])
        .toEqual([['MS-ADCS-NG-Connector', 'health 503, DevOps ticket'], ['X', 'a:b']]);
    expect(() => blockedConnectors({ REG_BLOCKED_CONNECTORS: 'MS-ADCS-NG-Connector' })).toThrow(/name:reason/);
    expect(() => blockedConnectors({ REG_BLOCKED_CONNECTORS: 'X:' })).toThrow(/name:reason/);
});
