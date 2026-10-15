/**
 * Platform area (B2 / B3 / B4) — pure helpers without an environment (npm run test:unit):
 * - cryptoMatrix: the §3 cells, the signature option picker, the r10 usage rule, the SCP#50 / must-offer verdicts;
 * - keyApi: token alias, token / key request attributes, item lookup, event filters;
 * - schedulerApi: the Quartz-subset next fire in UTC for the six system crons, P-JOBS problems;
 * - upgradeHarness: the snapshot diff rules, schema history, the one-way guard;
 * - platformApi: attribute filling, secret attributes, P-COMP overall status, string values;
 * - platformStack: compose argv, the refusal rules, the start-log facts.
 */
import { expect, test } from '@playwright/test';
import {
    absentFamilies, algorithmListProblems, encryptedFamilies, expectedItemUsages, generatedFamilies, namesForbiddenDigest, offeredAlgorithms, pickSignatureOption, sameUsages, signedFamilies, signVariants,
} from '../../utils/regression/cryptoMatrix';
import { eventsOf, itemOf, KEY_EVENT, keyCreateBody, keyItemsOf, keyRequestAttributes, tokenAlias, tokenRequestAttributes } from '../../utils/regression/keyApi';
import { expectedOverallStatus, requestAttributesFrom, secretAttributesFor, stringValues } from '../../utils/regression/platformApi';
import { composeArgs, coreStartLogFacts, PlatformStack, stackConfig, stackProblem } from '../../utils/regression/platformStack';
import { isFireTime, nextFireUtc, parseQuartzCron, SYSTEM_JOBS, systemJobProblems } from '../../utils/regression/schedulerApi';
import { diffSnapshots, parseSchemaHistory, schemaHistoryProblems, Snapshot, upgradeDirectionProblem } from '../../utils/regression/upgradeHarness';

// ------------------------------------------------------------------ cryptoMatrix

test('matrix cells: SCP v2 generates the G families, signs the S ones, encrypts RSA only; RSA 3072 is absent on the SCP', () => {
    expect(generatedFamilies('scp-v2')).toEqual(expect.arrayContaining(['rsa-2048', 'rsa-4096', 'ec-p256', 'ml-dsa-65', 'falcon-1024', 'ml-kem-768']));
    expect(generatedFamilies('scp-v2')).not.toContain('rsa-3072');
    expect(signedFamilies('scp-v2')).toContain('falcon-1024');
    expect(signedFamilies('scp-v1')).not.toContain('ml-dsa-65');
    expect(encryptedFamilies('scp-v2')).toEqual(['rsa-2048', 'rsa-4096']);
    expect(absentFamilies('scp-v2')).toEqual(['rsa-3072']);
    expect(absentFamilies('pkcs11')).toEqual(expect.arrayContaining(['falcon-1024', 'ml-kem-768']));
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

test('r10 usages: private sign + decrypt, public verify + encrypt, ECDSA never encrypts; the algorithm verdicts', () => {
    expect(expectedItemUsages(['sign', 'verify', 'encrypt', 'decrypt'], 'private', 'RSA')).toEqual(['sign', 'decrypt']);
    expect(expectedItemUsages(['sign', 'verify', 'encrypt', 'decrypt'], 'public', 'RSA')).toEqual(['verify', 'encrypt']);
    expect(expectedItemUsages(['sign', 'verify', 'encrypt', 'decrypt'], 'private', 'ECDSA')).toEqual(['sign']);
    expect(sameUsages(['verify', 'sign'], ['sign', 'verify'])).toBe(true);
    const v = algorithmListProblems('scp-v2', ['RSA', 'ECDSA', 'ML-DSA', 'FALCON', 'SLH-DSA', 'ML-KEM', 'Unknown']);
    expect(v).toEqual({ missing: [], forbidden: [], neverOffered: ['Unknown'] });
    expect(algorithmListProblems('pkcs11', ['RSA', 'FALCON'])).toEqual({ missing: ['ECDSA'], forbidden: ['FALCON'], neverOffered: [] });
    expect(offeredAlgorithms([{ name: 'data_keyAlgorithm', content: [{ reference: 'RSA', data: 'RSA' }, { data: 'ECDSA' }] }])).toEqual(['RSA', 'ECDSA']);
});

// ------------------------------------------------------------------ keyApi (pure)

test('tokenAlias: letters, digits and single underscores, a letter first; the token request attributes follow the live schema', () => {
    expect(tokenAlias('qa-reg-20261014-160000-ab12-tok')).toBe('qa_reg_20261014_160000_ab12_tok');
    expect(tokenAlias('9-x')).toBe('t_9_x');
    expect(tokenAlias('a--b__c')).toBe('a_b_c');
    const without = tokenRequestAttributes([{ name: 'data_createTokenAction', uuid: 'u1' }], 'alias_1', 'c0de');
    expect(without.map((a) => a.name)).toEqual(['data_createTokenAction', 'data_newTokenName', 'data_tokenCode']);
    expect(without[0].uuid).toBe('u1');
    expect(without[2].content[0].data).toEqual({ secret: 'c0de' });
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
    expect(keyRequestAttributes(defs, 'rsa-2048', 'k', 3072)[2].content[0]).toEqual({ reference: '3072', data: 3072 });
    expect(() => keyRequestAttributes(defs, 'ml-dsa-65', 'k')).toThrow(/not offered/);
    const body = keyCreateBody(defs, 'qa-reg-x-key', { family: 'rsa-2048', exportable: true }, []);
    expect(body).toMatchObject({ name: 'qa-reg-x-key', enabled: false, exportable: true, groupUuids: [] });
    expect(body.attributes[0].content[0].data).toBe('qa_reg_x_key');
});

test('itemOf / keyItemsOf / eventsOf read a key detail and a history', () => {
    const detail = { items: [{ uuid: 'p', type: 'PrivateKey' }, { uuid: 'q', type: 'Public' }] };
    expect(itemOf(detail, 'private')?.uuid).toBe('p');
    expect(keyItemsOf(detail)).toEqual({ privateUuid: 'p', publicUuid: 'q' });
    // The wire carries the @JsonValue CODE of KeyEvent ('Enable Key'), never the enum name (Sonnet F1).
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

test('Quartz subset: the six system crons parse; next fire in UTC; isFireTime; P-JOBS problems', () => {
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

// ------------------------------------------------------------------ upgradeHarness

const snap = (types: Snapshot['types'], extra: Partial<Snapshot> = {}): Snapshot => ({
    takenAt: 't', types, certificatesTotal: 10, auditLogTotal: 100, connectorStatuses: { A: 'connected' }, schemaHistory: [], ...extra,
});

test('diffSnapshots: kept objects pass; a lost or renamed object, a new non-system user, a reset audit log and an offline connector fail; system extras are reported', () => {
    const before = snap({ roles: { count: 2, objects: { r1: 'qa-reg-role', r2: 'admin' } }, groups: { count: 1, objects: { g1: 'g' } } });
    expect(diffSnapshots(before, before)).toEqual({ problems: [], systemExtras: [] });
    const after = snap({ roles: { count: 3, objects: { r1: 'qa-reg-role', r2: 'admin', r3: 'acme' } }, groups: { count: 1, objects: { g1: 'g' } } });
    expect(diffSnapshots(before, after)).toEqual({ problems: [], systemExtras: ['roles: acme (r3)'] });
    const bad = snap({ roles: { count: 2, objects: { r1: 'qa-reg-role-x', r9: 'someone' } }, groups: { count: 0, objects: {} } }, { auditLogTotal: 5, connectorStatuses: { A: 'offline' } });
    const r = diffSnapshots(before, bad);
    expect(r.problems).toEqual(expect.arrayContaining([
        'roles: r1 renamed qa-reg-role → qa-reg-role-x', 'roles: r2 (admin) is gone', 'roles: unexpected new someone (r9)', 'groups: g1 (g) is gone',
        'audit log total 100 → 5 (the 2.14 reset must not be crossed, A1 r21)', 'connector A: connected → offline',
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

// ------------------------------------------------------------------ platformApi (pure)

test('requestAttributesFrom fills required data attributes by type and given values by name; secretAttributesFor; P-COMP; stringValues', () => {
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
    expect(out[2].content, 'the list item is completed with the definition\'s contentType (live run 2)').toEqual([{ reference: 'A', data: 'a', contentType: 'string' }]);
    expect(() => requestAttributesFrom([{ name: 'x', contentType: 'file', type: 'data', properties: { required: true } }])).toThrow(/cannot fill/);
    const secret = secretAttributesFor([{ name: 'data_username', contentType: 'string', type: 'data', properties: { required: true } }, { name: 'data_password', contentType: 'secret', type: 'data', properties: { required: true } }], 'basicAuth', 'v4lue', 'bob');
    expect(secret).toEqual([{ name: 'data_username', uuid: undefined, version: 'v2', contentType: 'string', content: [{ data: 'bob' }] }, { name: 'data_password', uuid: undefined, version: 'v2', contentType: 'secret', content: [{ data: { secret: 'v4lue' } }] }]);
    expect(expectedOverallStatus(['ok', 'ok'])).toBe('ok');
    expect(expectedOverallStatus(['ok', 'nok'])).toBe('nok');
    expect(expectedOverallStatus([])).toBe('na');
    expect(expectedOverallStatus(['na'])).toBe('na');
    expect(stringValues({ a: 'x', b: [1, 'y', { c: 'z' }] })).toEqual(['x', 'y', 'z']);
});

// ------------------------------------------------------------------ platformStack (pure + fake runner)

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
