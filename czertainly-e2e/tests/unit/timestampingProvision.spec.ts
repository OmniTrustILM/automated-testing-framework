/**
 * timestampingProvision — the timestamping setup (utils/timestamping/provision) against an in-process fake core, through
 * the REAL guard (`guardApiWithSeams`, `localStack` on a proven local stack): what the preflight refuses and why, the
 * creation order of timestamping-setup.sh, one ledger line per created object right after its create (run-prefixed name,
 * spec `timestamping/setup`, the parents the teardown handlers read), the summary's shape and mode, and generated
 * secrets. No network, no tier: the fake records method + path + body and answers canned JSON.
 */
import { APIRequestContext, expect, test } from '@playwright/test';
import * as fs from 'fs';
import * as path from 'path';
import { guardApiWithSeams } from '../../utils/regression/guard/createGuard';
import { GuardedApi } from '../../utils/regression/guard/types';
import { LedgerLine, readLedger } from '../../utils/regression/ledger/ledger';
import { OwnObjectViolation } from '../../utils/regression/ledger/ownership';
import { runId } from '../../utils/regression/ledger/runState';
import { tierIdentity } from '../../utils/regression/tier/kind';
import { localProofFile } from '../../utils/regression/tier/localProof';
import { summaryFile, timestampingConfig } from '../../utils/timestamping/config';
import { permissionDocument } from '../../utils/timestamping/provision/profiles';
import { provisionTimestamping, SETUP_LEDGER_SPEC, writeSummary } from '../../utils/timestamping/provision/provision';
import { SetupError } from '../../utils/timestamping/provision/transport';
import type { TimestampingSummary } from '../../utils/timestamping/types';
import { withProcessEnv } from './helpers/guardRig';

type Json = Record<string, any>;

const U = (n: number) => `00000000-0000-4000-8000-${String(n).padStart(12, '0')}`;
const UUID = '[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}';
const C_CRED = U(1);
const C_EJBCA = U(2);
const C_CRYPTO = U(3);
const C_TFC = U(4);
const C_VAULT = U(5);
const AUTHORITY = U(10);
const VAULT = U(11);
const CREDENTIAL = U(12);
const ROOT_CA = U(13);
const AUTHORITY_NAME = 'ejbca.3key.company';
const BASE_DATE = Date.parse('2026-10-22T10:00:00Z');
const NO_POLL_PAUSE = { certificateIntervalMs: 0, linkageIntervalMs: 0, validationIntervalMs: 0 };

const def = (name: string, contentType: string | undefined, extra: Json = {}): Json => ({ uuid: U(500 + name.length * 7 + (contentType?.length ?? 0)), name, type: 'data', contentType, version: 2, ...extra });

interface FakeOptions {
    v1?: Json[];
    v2?: Json[];
    authorities?: Json[];
    cas?: string[];
    caTrusted?: boolean;
    /** The CN fragment whose issuance fails (history: "CA refused"). */
    failIssuanceOf?: string;
    /** The CN fragment whose certificate never leaves `requested` (the issuance wait runs out). */
    neverIssue?: string;
    /** `METHOD /path/{id}` → a status answered instead of the route's (with a body that must never reach a reason). */
    statusFor?: Record<string, number>;
    /** The ML-DSA leaves' issuer: not self-signed, or a self-signed certificate without a trustedCa flag. */
    mldsaIssuer?: 'notSelfSigned' | 'noTrustFlag';
    /** The key create answers no items; the detail has them. */
    keyWithoutItems?: boolean;
    /** The root CA's first history event (default: long before the run, a pre-existing CA). */
    rootCreatedAt?: string;
    /** The name of the ML-DSA level field the connector offers (default data_mldsaLevel). */
    mldsaLevelName?: string;
}

/** The text a refused answer carries: it must stay in the log. */
const ECHO = 'ECHO-OF-THE-REQUEST-BODY';
const OTHER_CA = U(14);

interface Sent {
    method: string;
    path: string;
    body: unknown;
    /** Ledger lines in the file when the request was sent. */
    ledgerLines: number;
    /** The uuid the answer created, when it was a create. */
    created?: string;
    /** The answer as sent (a create's items are made with it). */
    answer?: string;
    date: string;
}

const defaultV1 = (): Json[] => [
    { uuid: C_CRED, name: 'common-credential-provider', status: 'connected', url: 'http://connectors.local:8200', functionGroups: [{ functionGroupCode: 'credentialProvider', kinds: ['SoftKeyStore', 'Basic'] }] },
    { uuid: C_EJBCA, name: 'ejbca-ng-connector', status: 'connected', url: 'http://connectors.local:8210', functionGroups: [{ functionGroupCode: 'authorityProvider', kinds: ['EJBCA'] }] },
];
const defaultV2 = (): Json[] => [
    { uuid: C_CRED, name: 'common-credential-provider', version: 'v1', status: 'connected', url: 'http://connectors.local:8200', interfaces: [] },
    { uuid: C_CRYPTO, name: 'software-cryptography-provider-v2', version: 'v2', status: 'connected', url: 'http://connectors.local:8230', interfaces: [{ uuid: U(30), code: 'cryptography' }] },
    { uuid: C_TFC, name: 'timestamp-formatting-connector', version: 'v2', status: 'connected', url: 'http://connectors.local:8270', interfaces: [{ uuid: U(31), code: 'signatureFormatting', features: ['timestamping'] }] },
    { uuid: C_VAULT, name: 'common-credential-provider-v2', version: 'v2', status: 'connected', url: 'http://connectors.local:8200', interfaces: [{ uuid: U(32), code: 'secret' }] },
];

/** A fake core: canned answers for every route the setup uses; creates answer fresh uuids; every request is recorded. */
function fakeCore(opts: FakeOptions = {}) {
    const sent: Sent[] = [];
    let seq = 1000;
    const next = () => `aaaaaaaa-0000-4000-8000-${String(++seq).padStart(12, '0')}`;
    const keyAlgorithm = new Map<string, string>();
    const keyItems = new Map<string, Json[]>();
    const certificates = new Map<string, { cn: string; key: string; reads: number }>();
    let caTrusted = opts.caTrusted ?? false;
    const cas = opts.cas ?? ['DemoRootCA_2307RSA', 'MLDSA'];
    const create = (extra: Json = {}) => ({ uuid: next(), ...extra });

    const routes: Array<[string, RegExp, (m: RegExpMatchArray, body: Json) => [number, unknown]]> = [
        ['GET', /^\/v1\/connectors$/, () => [200, opts.v1 ?? defaultV1()]],
        ['POST', /^\/v2\/connectors\/list$/, () => [200, { items: opts.v2 ?? defaultV2() }]],
        ['GET', /^\/v1\/authorities$/, () => [200, opts.authorities ?? [{ uuid: AUTHORITY, name: AUTHORITY_NAME, connectorUuid: C_EJBCA, attributes: [{ name: 'credential', content: [{ data: { uuid: CREDENTIAL, name: AUTHORITY_NAME } }] }] }]]],
        ['POST', /^\/v1\/vaults\/list$/, () => [200, { items: [{ uuid: VAULT, name: 'vault', connector: { uuid: C_VAULT, name: 'common-credential-provider-v2' } }] }]],
        ['GET', new RegExp(`^/v1/authorities/${UUID}/attributes/raProfile$`), () => [200, [
            def('endEntityProfile', 'object', { content: [{ data: { id: 7, name: 'DemoTSAEndEntityProfile' } }, { data: { id: 8, name: 'Other' } }] }),
            def('certificateProfile', 'object'),
            def('certificationAuthority', 'object', { attributeCallback: { mappings: [{ to: 'endEntityProfileId', from: 'endEntityProfile.data.id' }, { to: 'authorityId', value: 'ejbca-authority-1' }] } }),
            def('sendNotifications', 'boolean'), def('keyRecoverable', 'boolean'), def('usernameGenMethod', 'string'),
        ]]],
        ['POST', new RegExp(`^/v1/raProfiles/${UUID}/callback$`), (_m, b) => [200, b.name === 'certificateProfile'
            ? [{ data: { id: 11, name: 'DemoTSAEECertificateProfile' } }, { data: { id: 12, name: 'DemoTSAQCEECertificateProfile' } }]
            : cas.map((name, i) => ({ data: { id: 21 + i, name } }))]],
        // provisioning
        ['POST', new RegExp(`^/v1/vaults/${UUID}/vaultProfiles$`), () => [200, create()]],
        ['PATCH', new RegExp(`^/v1/vaults/${UUID}/vaultProfiles/${UUID}/enable$`), () => [204, undefined]],
        ['GET', new RegExp(`^/v1/tokens/${UUID}/attributes$`), () => [200, [
            def('data_options', 'string', { content: [{ data: 'new', reference: 'Create new Token' }, { data: 'existing' }] }),
            { uuid: U(40), name: 'group_loadToken', type: 'group' },
        ]]],
        ['POST', new RegExp(`^/v2/connectors/${UUID}/callback$`), () => [200, [def('data_createTokenAction', 'string'), def('data_newTokenName', 'string'), def('data_tokenCode', 'secret')]]],
        ['POST', /^\/v1\/tokens$/, () => [200, create()]],
        ['POST', new RegExp(`^/v1/tokens/${UUID}/tokenProfiles$`), () => [200, create()]],
        ['PATCH', new RegExp(`^/v1/tokens/${UUID}/tokenProfiles/${UUID}/enable$`), () => [204, undefined]],
        ['POST', /^\/v1\/timeQualityConfigurations$/, (_m, b) => [200, create({ name: b.name, accuracy: b.accuracy, ntpServers: b.ntpServers, maxClockDrift: b.maxClockDrift })]],
        ['POST', /^\/v1\/users$/, () => [200, create()]],
        ['POST', /^\/v1\/roles$/, () => [200, create()]],
        ['PATCH', new RegExp(`^/v1/users/${UUID}/roles$`), () => [200, {}]],
        ['GET', new RegExp(`^/v1/tokens/${UUID}/tokenProfiles/${UUID}/keys/keyPair/attributes$`), () => [200, [
            def('data_keyAlias', 'string'),
            def('data_keyAlgorithm', 'string', { content: [{ data: 'RSA', reference: 'RSA' }, { data: 'ML-DSA', reference: 'ML-DSA' }] }),
            { uuid: U(41), name: 'group_keySpecV2', type: 'group' },
        ]]],
        ['POST', new RegExp(`^/v1/keys/${UUID}/callback$`), (_m, b) => [200, b.attributes?.[0]?.content?.[0]?.data === 'RSA'
            ? [def('data_rsaKeySize', 'integer', { content: [{ data: 2048, reference: '2048' }, { data: 4096, reference: '4096' }], properties: { required: true, list: true } })]
            : [def(opts.mldsaLevelName ?? 'data_mldsaLevel', 'integer', { content: [{ data: 2 }, { data: 3 }, { data: 5 }], properties: { required: true, list: true } })]]],
        ['POST', new RegExp(`^/v1/tokens/${UUID}/tokenProfiles/${UUID}/keys/keyPair$`), (_m, b) => {
            const items = [{ uuid: next(), type: 'Private' }, { uuid: next(), type: 'Public' }];
            const key = create(opts.keyWithoutItems ? {} : { items });
            keyItems.set(key.uuid, items);
            keyAlgorithm.set(key.uuid, String((b.attributes as Json[]).find((a) => a.name === 'data_keyAlgorithm')?.content?.[0]?.data));
            return [200, key];
        }],
        ['PATCH', new RegExp(`^/v1/keys/${UUID}/enable$`), () => [204, undefined]],
        ['GET', new RegExp(`^/v1/keys/(${UUID})$`), (m) => [200, { uuid: m[1], items: [...(keyItems.get(m[1]) ?? [])].reverse() }]],
        ['POST', new RegExp(`^/v1/authorities/${UUID}/raProfiles$`), () => [200, create()]],
        ['PATCH', new RegExp(`^/v1/authorities/${UUID}/raProfiles/${UUID}/enable$`), () => [204, undefined]],
        ['GET', /^\/v1\/certificates\/csr\/attributes$/, () => [200, [def('commonName', 'string', { version: 3 }), def('organization', 'string')]]],
        ['GET', new RegExp(`^/v1/operations/tokens/${UUID}/tokenProfiles/${UUID}/keys/(${UUID})/items/${UUID}/sign/attributes$`), (m) => [200, signatureDefs(keyAlgorithm.get(m[1]))]],
        ['POST', new RegExp(`^/v2/operations/authorities/${UUID}/raProfiles/${UUID}/certificates$`), (_m, b) => {
            const cert = create();
            certificates.set(cert.uuid, { cn: b.csrAttributes[0].content[0].data, key: b.keyUuid, reads: 0 });
            return [200, cert];
        }],
        ['GET', new RegExp(`^/v1/certificates/(${UUID})/chain$`), () => [200, { certificates: [], completeChain: true }]],
        ['GET', new RegExp(`^/v1/certificates/(${UUID})/validate$`), () => [200, { resultStatus: caTrusted ? 'valid' : 'invalid' }]],
        ['GET', new RegExp(`^/v1/certificates/(${UUID})/history$`), (m) => [200, m[1] === ROOT_CA
            ? [{ event: 'Upload Certificate', status: 'SUCCESS', created: opts.rootCreatedAt ?? '2026-01-01T00:00:00Z' }]
            : [{ event: 'Issue Certificate', status: 'FAILED', message: JSON.stringify({ message: 'CA refused' }) }]]],
        ['GET', new RegExp(`^/v1/certificates/(${UUID})$`), (m) => {
            if (m[1] === ROOT_CA) return [200, { uuid: ROOT_CA, commonName: 'Demo Root', subjectDn: 'CN=Demo Root', issuerDn: 'CN=Demo Root', trustedCa: caTrusted }];
            if (m[1] === OTHER_CA) {
                return [200, opts.mldsaIssuer === 'notSelfSigned'
                    ? { uuid: OTHER_CA, subjectDn: 'CN=Sub CA', issuerDn: 'CN=Missing Root', trustedCa: false }
                    : { uuid: OTHER_CA, subjectDn: 'CN=Odd', issuerDn: 'CN=Odd' }];
            }
            const c = certificates.get(m[1])!;
            c.reads += 1;
            const failed = opts.failIssuanceOf && c.cn.includes(opts.failIssuanceOf);
            const stuck = opts.neverIssue && c.cn.includes(opts.neverIssue);
            // The first read still sees the request in flight: the poll has to wait for it.
            const state = c.reads === 1 || stuck ? 'requested' : failed ? 'failed' : 'issued';
            const issuer = opts.mldsaIssuer && c.cn.includes('mldsa65') ? OTHER_CA : ROOT_CA;
            return [200, { uuid: m[1], commonName: c.cn, state, subjectDn: `CN=${c.cn}`, issuerDn: 'CN=Demo Root', ...(state === 'issued' ? { issuerCertificateUuid: issuer } : {}) }];
        }],
        ['PATCH', new RegExp(`^/v1/certificates/(${UUID})$`), (_m, b) => {
            if (b.trustedCa === true) caTrusted = true;
            return [200, {}];
        }],
        ['POST', /^\/v1\/tspProfiles$/, () => [200, create()]],
        ['PATCH', new RegExp(`^/v1/tspProfiles/${UUID}/enable$`), () => [204, undefined]],
        ['GET', new RegExp(`^/v1/signingProfiles/certificates/(${UUID})/signatureAttributes$`), (m) => [200, signatureDefs(keyAlgorithm.get(certificates.get(m[1])!.key))]],
        ['GET', new RegExp(`^/v1/signingProfiles/signatureFormattingConnectors/${UUID}/formattingAttributes$`), () => [200, [def('data_tsaName', 'string', { version: 2 })]]],
        ['POST', /^\/v1\/signingProfiles$/, () => [200, create()]],
        ['PATCH', new RegExp(`^/v1/signingProfiles/${UUID}/enable$`), () => [204, undefined]],
        ['PUT', new RegExp(`^/v1/tspProfiles/${UUID}$`), () => [200, {}]],
        ['PATCH', new RegExp(`^/v1/signingProfiles/${UUID}/protocols/tsp/activate/${UUID}$`), () => [200, { signingUrl: 'http://x/tsp' }]],
        ['POST', new RegExp(`^/v1/tspProfiles/${UUID}/basicCredentials$`), () => [200, create()]],
        ['POST', new RegExp(`^/v1/roles/${UUID}/permissions$`), () => [200, {}]],
    ];

    const answer = (method: string, url: string, data: unknown) => {
        const apiPath = url.replace(/^\/api/, '').split('?')[0];
        const body = (typeof data === 'string' ? (data ? JSON.parse(data) : undefined) : Buffer.isBuffer(data) ? JSON.parse(data.toString('utf8')) : data) as Json | undefined;
        const lines = fs.existsSync(ledgerPath()) ? fs.readFileSync(ledgerPath(), 'utf8').split('\n').filter(Boolean).length : 0;
        const date = new Date(BASE_DATE + sent.length * 1000).toUTCString();
        const entry: Sent = { method, path: apiPath, body, ledgerLines: lines, date };
        sent.push(entry);
        let status = 404;
        let out: unknown = { message: `no route for ${method} ${apiPath}` };
        const forced = opts.statusFor?.[`${method} ${template(apiPath)}`];
        if (forced !== undefined) [status, out] = [forced, { message: ECHO }];
        else {
            for (const [m, re, handle] of routes) {
                const hit = m === method ? apiPath.match(re) : null;
                if (hit) {
                    [status, out] = handle(hit, body ?? {});
                    break;
                }
            }
        }
        if (status < 300 && out && typeof out === 'object' && 'uuid' in (out as Json) && method === 'POST') entry.created = String((out as Json).uuid);
        const text = out === undefined ? '' : JSON.stringify(out);
        entry.answer = text;
        return { status: () => status, ok: () => status < 300, text: async () => text, json: async () => out, headers: () => ({ date }) };
    };
    const api = {
        get: async (url: string) => answer('GET', url, undefined),
        head: async () => answer('HEAD', '/', undefined),
        fetch: async (url: string, o: { method?: string; data?: unknown } = {}) => answer((o.method ?? 'GET').toUpperCase(), url, o.data),
        dispose: async () => undefined,
        storageState: async () => ({ cookies: [], origins: [] }),
    } as unknown as APIRequestContext;
    return { api, sent, isCaTrusted: () => caTrusted };
}

function signatureDefs(alg: string | undefined): Json[] {
    if (alg === 'RSA') {
        return [
            def('data_rsaSigScheme', 'string', { content: [{ data: 'PKCS1-v1_5' }, { data: 'PSS' }] }),
            def('data_sigDigest', 'string', { content: [{ data: 'SHA-256' }, { data: 'SHA-384' }, { data: 'SHA-512' }] }),
        ];
    }
    return [def('signatureAlgorithm', 'string', { content: [{ data: 'ML-DSA-65' }] })];
}

let stateDir = '';
const ledgerPath = () => path.join(stateDir, 'created-objects.jsonl');

/** A local env with this run's local-backend proof written (the guard's localStack needs it, and so does the preflight). */
function provenLocalEnv(dir: string, extra: NodeJS.ProcessEnv = {}): NodeJS.ProcessEnv {
    const env: NodeJS.ProcessEnv = { TIER_KIND: 'local', BASE_URL: 'http://localhost:3080', REG_STATE_DIR: dir, REG_RUN_ID: runId(), ...extra };
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(localProofFile(env), JSON.stringify({ runId: runId(), tier: tierIdentity(env), at: new Date().toISOString() }));
    return env;
}

interface Run {
    summary: TimestampingSummary;
    sent: Sent[];
    ledger: LedgerLine[];
    env: NodeJS.ProcessEnv;
    isCaTrusted: () => boolean;
}

/** Runs the setup against a fake core, through the real guard (localStack) judging against `env`. */
async function runSetup(testInfo: { outputPath: (p: string) => string }, fake: FakeOptions = {}, envOf: (dir: string) => NodeJS.ProcessEnv = (d) => provenLocalEnv(d)): Promise<Run> {
    stateDir = testInfo.outputPath('state');
    const env = envOf(stateDir);
    const core = fakeCore(fake);
    return withProcessEnv({ REG_STATE_DIR: stateDir, BASE_URL: env.BASE_URL ?? 'http://localhost:3080' }, async () => {
        const api: GuardedApi = guardApiWithSeams(core.api, { localStack: true, env, lines: [], runId: runId(), tier: null });
        const summary = await provisionTimestamping(api, { cfg: timestampingConfig(env), env, poll: NO_POLL_PAUSE, stamp: 'ab12' });
        return { summary, sent: core.sent, ledger: readLedger(ledgerPath()), env, isCaTrusted: core.isCaTrusted };
    });
}

const mutations = (sent: Sent[]) => sent.filter((s) => s.method !== 'GET' && !/\/list$|\/callback$/.test(s.path));
const template = (p: string) => p.replace(new RegExp(UUID, 'g'), '{id}');
const ready = (s: TimestampingSummary) => {
    expect(s.status, s.status === 'unavailable' ? s.reason : '').toBe('ready');
    return s as Extract<TimestampingSummary, { status: 'ready' }>;
};

// ------------------------------------------------------------------ the offline blockers: no request at all

test('a shared tier, a missing local proof and pkcs11 are unavailable without a single request', async ({}, testInfo) => {
    const shared = await runSetup(testInfo, {}, (d) => ({ TIER_KIND: 'shared', BASE_URL: 'https://tier.example', REG_STATE_DIR: d, REG_RUN_ID: runId() }));
    expect(shared.summary.status).toBe('unavailable');
    expect(shared.summary.status === 'unavailable' && shared.summary.reason).toMatch(/not a local stack/);
    expect(shared.sent, 'no request on a shared tier').toEqual([]);

    const unproven = await runSetup(testInfo, {}, (d) => ({ TIER_KIND: 'local', BASE_URL: 'http://localhost:3080', REG_STATE_DIR: d, REG_RUN_ID: runId() }));
    expect(unproven.summary.status === 'unavailable' && unproven.summary.reason).toMatch(/local-backend proof/);
    expect(unproven.sent).toEqual([]);

    const pkcs11 = await runSetup(testInfo, {}, (d) => provenLocalEnv(d, { TSA_CRYPTO_PROVIDER: 'pkcs11' }));
    expect(pkcs11.summary.status === 'unavailable' && pkcs11.summary.reason).toMatch(/pkcs11/);
    expect(pkcs11.sent).toEqual([]);
    expect(readLedger(ledgerPath()), 'nothing was created').toEqual([]);
});

// The control: the same run through the same guard WITHOUT localStack is refused at its first non-read request, so the
// full-run tests below prove the guard lets every request of the setup through on a proven local stack.
test('control: without localStack the guard refuses the setup (it is the real guard judging every request)', async ({}, testInfo) => {
    stateDir = testInfo.outputPath('state');
    const env = provenLocalEnv(stateDir);
    const core = fakeCore();
    await withProcessEnv({ REG_STATE_DIR: stateDir, BASE_URL: 'http://localhost:3080' }, async () => {
        const api = guardApiWithSeams(core.api, { env, lines: [], runId: runId(), tier: null });
        await expect(provisionTimestamping(api, { cfg: timestampingConfig(env), env, poll: NO_POLL_PAUSE, stamp: 'ab12' })).rejects.toThrow(OwnObjectViolation);
    });
    expect(core.sent.map((s) => `${s.method} ${s.path}`), 'the refused list POST never reached the core').toEqual(['GET /v1/connectors']);
});

// ------------------------------------------------------------------ the preflight's reasons: read-only

test('preflight: a missing connector, a connector waiting for approval and a missing authority are named reasons; nothing is written', async ({}, testInfo) => {
    const noFormatter = await runSetup(testInfo, { v2: defaultV2().filter((c) => c.uuid !== C_TFC) });
    expect(noFormatter.summary.status === 'unavailable' && noFormatter.summary.reason).toBe('no timestamp-formatting (signatureFormatting / timestamping) connector is registered');
    expect(mutations(noFormatter.sent), 'read-only').toEqual([]);

    const waiting = await runSetup(testInfo, { v1: defaultV1().map((c) => (c.uuid === C_EJBCA ? { ...c, status: 'waitingForApproval' } : c)) });
    expect(waiting.summary.status === 'unavailable' && waiting.summary.reason).toMatch(/authority-provider \(EJBCA\) connector is waiting for approval \(the setup never approves/);
    expect(mutations(waiting.sent), 'never approved, nothing created').toEqual([]);
    expect(waiting.sent.some((s) => /approve/.test(s.path))).toBe(false);

    const noAuthority = await runSetup(testInfo, { authorities: [{ uuid: AUTHORITY, name: 'another-authority', attributes: [] }] });
    expect(noAuthority.summary.status === 'unavailable' && noAuthority.summary.reason).toBe('no authority instance has the name TSA_AUTHORITY_NAME gives; the setup never creates one');
    expect(JSON.stringify(noAuthority.summary), 'a reason names the variable, never the configured value').not.toContain(AUTHORITY_NAME);
    expect(mutations(noAuthority.sent)).toEqual([]);

    const noRsaCa = await runSetup(testInfo, { cas: ['MLDSA'] });
    expect(noRsaCa.summary.status === 'unavailable' && noRsaCa.summary.reason, 'the RSA family is required').toMatch(/no EJBCA CA named by TSA_EJBCA_CA \(the offered ones are in the setup log\)/);
    expect(JSON.stringify(noRsaCa.summary)).not.toContain('DemoRootCA_2307RSA');
    expect(readLedger(ledgerPath())).toEqual([]);
});

test('preflight: a missing ML-DSA CA moves only that family to missingFamilies; the RSA family is provisioned', async ({}, testInfo) => {
    const run = await runSetup(testInfo, { cas: ['DemoRootCA_2307RSA'] });
    const s = ready(run.summary);
    expect(Object.keys(s.provisioning.sets)).toEqual(['rsa']);
    expect(Object.keys(s.missingFamilies)).toEqual(['mldsa65']);
    expect(s.missingFamilies.mldsa65).toMatch(/no EJBCA CA named by TSA_MLDSA_EJBCA_CA \(the offered ones are in the setup log\)/);
    expect(run.sent.filter((x) => /keys\/keyPair$/.test(x.path) && x.method === 'POST').map((x) => (x.body as Json).attributes.find((a: Json) => a.name === 'data_keyAlgorithm').content[0].data))
        .toEqual(['RSA', 'RSA']);
});

// ------------------------------------------------------------------ the full run

test('provisioning follows timestamping-setup.sh order and records every object once, right after its create', async ({}, testInfo) => {
    const run = await runSetup(testInfo);
    ready(run.summary);
    const half = [
        'POST /v1/tokens/{id}/tokenProfiles/{id}/keys/keyPair', 'PATCH /v1/keys/{id}/enable',
        'POST /v1/authorities/{id}/raProfiles', 'PATCH /v1/authorities/{id}/raProfiles/{id}/enable',
        'POST /v2/operations/authorities/{id}/raProfiles/{id}/certificates',
        'POST /v1/tspProfiles', 'PATCH /v1/tspProfiles/{id}/enable',
        'POST /v1/signingProfiles', 'PATCH /v1/signingProfiles/{id}/enable',
        'PUT /v1/tspProfiles/{id}', 'PATCH /v1/signingProfiles/{id}/protocols/tsp/activate/{id}',
        'POST /v1/tspProfiles/{id}/basicCredentials', 'POST /v1/roles/{id}/permissions',
    ];
    const trust = 'PATCH /v1/certificates/{id}';
    const expected = [
        'POST /v1/vaults/{id}/vaultProfiles', 'PATCH /v1/vaults/{id}/vaultProfiles/{id}/enable',
        'POST /v1/tokens', 'POST /v1/tokens/{id}/tokenProfiles', 'PATCH /v1/tokens/{id}/tokenProfiles/{id}/enable',
        'POST /v1/timeQualityConfigurations', 'POST /v1/users', 'POST /v1/roles', 'PATCH /v1/users/{id}/roles',
        // The issuing CA is marked trusted once (it was not yet), between the first issuance and the first TSP profile.
        ...half.slice(0, 5), trust, ...half.slice(5), ...half, ...half, ...half,
    ];
    expect(mutations(run.sent).map((s) => `${s.method} ${template(s.path)}`)).toEqual(expected);
    expect(mutations(run.sent).filter((s) => s.method === 'PATCH' && s.path === `/v1/certificates/${ROOT_CA}`).map((s) => s.body)).toEqual([{ trustedCa: true }]);

    // Ledger: the created objects in order, each once, run-prefixed, spec timestamping/setup.
    const own = run.ledger.filter((l) => l.type !== 'keyItems');
    const perHalf = ['keys', 'raProfiles', 'certificates', 'tspProfiles', 'signingProfiles'];
    expect(own.map((l) => l.type)).toEqual([
        'vaultProfiles', 'tokens', 'tokenProfiles', 'timeQualityConfigurations', 'users', 'roles', ...perHalf, ...perHalf, ...perHalf, ...perHalf,
    ]);
    expect(run.ledger.filter((l) => l.type === 'keyItems')).toHaveLength(8);
    expect(new Set(run.ledger.map((l) => l.uuid)).size, 'every uuid once').toBe(run.ledger.length);
    for (const l of run.ledger) {
        expect(l.spec, `${l.type} spec`).toBe(SETUP_LEDGER_SPEC);
        expect(l.name.startsWith(`${runId()}-`), `${l.type} ${l.name} carries the run prefix`).toBe(true);
        expect(l.event).toBe('created');
    }
    // Right after the create: not in the file when the create was sent, in the file when the next request was sent.
    for (const [i, line] of run.ledger.entries()) {
        const at = run.sent.findIndex((s) => s.created !== undefined && !!s.answer?.includes(line.uuid));
        expect(at, `the create of ${line.type} ${line.uuid}`).toBeGreaterThanOrEqual(0);
        expect(run.sent[at].ledgerLines, `${line.type}: no line before its create`).toBeLessThanOrEqual(i);
        expect(run.sent[at + 1].ledgerLines, `${line.type}: recorded before the next request`).toBeGreaterThan(i);
    }
    // Parents as the teardown handlers read them.
    const byType = (t: string) => run.ledger.filter((l) => l.type === t);
    const token = byType('tokens')[0].uuid;
    const tokenProfile = byType('tokenProfiles')[0].uuid;
    const vaultProfile = byType('vaultProfiles')[0].uuid;
    expect(byType('vaultProfiles')[0].parents).toEqual({ vault: VAULT });
    expect(byType('tokens')[0].parents).toBeUndefined();
    expect(byType('tokenProfiles')[0].parents).toEqual({ token });
    for (const k of byType('keys')) expect(k.parents).toEqual({ token, tokenProfile });
    for (const item of byType('keyItems')) expect(byType('keys').map((k) => k.uuid)).toContain(item.parents?.key);
    for (const r of byType('raProfiles')) expect(r.parents).toEqual({ authority: AUTHORITY });
    const certs = byType('certificates');
    certs.forEach((c, i) => expect(c.parents).toEqual({ raProfile: byType('raProfiles')[i].uuid, authority: AUTHORITY }));
    for (const t of byType('tspProfiles')) expect(t.parents).toEqual({ vaultProfile });
    const tq = byType('timeQualityConfigurations')[0].uuid;
    byType('signingProfiles').forEach((sp, i) => {
        const qualified = i % 2 === 1;
        expect(sp.parents, `signing profile ${i}`).toEqual({
            tspProfile: byType('tspProfiles')[i].uuid, certificate: certs[i].uuid, token, ...(qualified ? { timeQualityConfiguration: tq } : {}),
        });
    });
});

test('request bodies follow the script: names, certificate CN, signature settings, qualified wiring, permissions', async ({}, testInfo) => {
    const run = await runSetup(testInfo);
    const s = ready(run.summary);
    const posts = (re: RegExp) => run.sent.filter((x) => x.method === 'POST' && re.test(x.path)).map((x) => x.body as Json);
    const [token] = posts(/^\/v1\/tokens$/);
    expect(token.connectorUuid).toBe(C_CRYPTO);
    expect(token.kind, 'a v2 token carries no kind').toBeUndefined();
    expect(token.attributes.map((a: Json) => a.name)).toEqual(['data_createTokenAction', 'data_newTokenName', 'data_tokenCode', 'data_options']);
    expect(token.attributes[1].content[0].data, 'keystore name: underscores only').toBe(`${runId()}-tsa-token-ab12`.replace(/-/g, '_'));

    const certificates = posts(/\/certificates$/).filter((b) => b.csrAttributes);
    expect(certificates.map((b) => b.csrAttributes[0].content[0].data)).toEqual(
        ['rsa-non-qualified', 'rsa-qualified', 'mldsa65-non-qualified', 'mldsa65-qualified'].map((x) => `${runId()}-tsa-${x}-ab12`));
    expect(certificates[0].signatureAttributes.map((a: Json) => [a.name, a.content[0].data])).toEqual([['data_rsaSigScheme', 'PKCS1-v1_5'], ['data_sigDigest', 'SHA-384']]);
    expect(certificates[2].signatureAttributes.map((a: Json) => [a.name, a.content[0].data]), 'ML-DSA: signatureAlgorithm only').toEqual([['signatureAlgorithm', 'ML-DSA-65']]);
    expect(certificates[0].csrAttributes[0].version, 'the CN attribute as the script sends it').toBe('v3');

    const ras = posts(/\/raProfiles$/);
    expect(ras.map((b) => b.attributes.find((a: Json) => a.name === 'certificateProfile').content[0].data)).toEqual(
        [{ id: 11, name: 'DemoTSAEECertificateProfile' }, { id: 12, name: 'DemoTSAQCEECertificateProfile' }, { id: 11, name: 'DemoTSAEECertificateProfile' }, { id: 12, name: 'DemoTSAQCEECertificateProfile' }]);
    expect(ras.map((b) => b.attributes.find((a: Json) => a.name === 'certificationAuthority').content[0].data.name)).toEqual(['DemoRootCA_2307RSA', 'DemoRootCA_2307RSA', 'MLDSA', 'MLDSA']);
    expect(ras[0].attributes.find((a: Json) => a.name === 'usernameGenMethod').content).toEqual([{ data: 'CN' }]);

    const keys = posts(/keys\/keyPair$/);
    expect(keys.map((k) => k.attributes.map((a: Json) => `${a.name}=${JSON.stringify(a.content[0].data)}`))).toEqual([
        [`data_keyAlias="${runId()}-tsa-rsa-non-qualified-ab12"`, 'data_keyAlgorithm="RSA"', 'data_rsaKeySize=2048'],
        [`data_keyAlias="${runId()}-tsa-rsa-qualified-ab12"`, 'data_keyAlgorithm="RSA"', 'data_rsaKeySize=2048'],
        [`data_keyAlias="${runId()}-tsa-mldsa65-non-qualified-ab12"`, 'data_keyAlgorithm="ML-DSA"', 'data_mldsaLevel=3'],
        [`data_keyAlias="${runId()}-tsa-mldsa65-qualified-ab12"`, 'data_keyAlgorithm="ML-DSA"', 'data_mldsaLevel=3'],
    ]);

    const signing = posts(/^\/v1\/signingProfiles$/);
    const tq = s.provisioning.timeQuality.uuid;
    expect(signing.map((b) => [b.workflow.qualifiedTimestamp, b.workflow.defaultPolicyId, b.workflow.timeQualityConfigurationUuid])).toEqual([
        [false, '1.2.3.4.5.6', undefined], [true, '1.2.3.4.5.7', tq], [false, '1.2.3.4.5.6', undefined], [true, '1.2.3.4.5.7', tq],
    ]);
    expect(signing[0].workflow.allowedPolicyIds).toEqual(['1.2.3.4.5.6']);
    expect(signing[0].workflow.allowedDigestAlgorithms).toEqual(['SHA-256', 'SHA-384', 'SHA-512']);
    expect(signing[0].workflow.signatureFormattingConnectorUuid).toBe(C_TFC);
    expect(signing[0].workflow.signatureFormattingConnectorAttributes[0].version, 'the formatter version, v-prefixed').toBe('v2');
    expect(signing[0].signingScheme).toMatchObject({ signingScheme: 'managed', managedSigningType: 'static_key' });

    const [tqBody] = posts(/timeQualityConfigurations$/);
    expect(tqBody).toMatchObject({ accuracy: 'PT1S', ntpServers: ['ntp'], maxClockDrift: 'PT0.8S', ntpCheckInterval: 'PT0.5S', ntpCheckTimeout: 'PT0.3S', ntpSamplesPerServer: 3, ntpServersMinReachable: 1, leapSecondGuard: true });
    const [user] = posts(/^\/v1\/users$/);
    expect(Object.keys(user).sort(), 'a password-less user').toEqual(['email', 'enabled', 'firstName', 'lastName', 'username']);

    const perms = posts(/permissions$/);
    expect(perms).toHaveLength(4);
    const last = perms[3];
    expect(last.allowAllResources).toBe(false);
    expect(last.resources.map((r: Json) => r.name)).toEqual(['keys', 'signingProfiles', 'tokenProfiles', 'tokens', 'tspProfiles']);
    const tsp = last.resources.find((r: Json) => r.name === 'tspProfiles');
    expect(tsp.objects.map((o: Json) => o.uuid).sort()).toEqual(Object.values(s.provisioning.sets).flatMap((f) => [f.nonQualified.tspProfile.uuid, f.qualified.tspProfile.uuid]).sort());
    expect(tsp.objects.every((o: Json) => JSON.stringify(o.allow) === '["detail","timestamp"]' && o.deny.length === 0)).toBe(true);
    expect(last.resources.find((r: Json) => r.name === 'keys')).toEqual({ name: 'keys', allowAllActions: false, actions: ['sign'], objects: [] });
    expect(perms[0].resources.find((r: Json) => r.name === 'tspProfiles').objects, 'the first save holds the first set only').toHaveLength(1);
});

test('the summary has the shape of write_json_summary, the server date as provisionedAt, and mode 0600', async ({}, testInfo) => {
    const run = await runSetup(testInfo);
    const s = ready(run.summary);
    const firstProvisioning = run.sent.find((x) => x.method === 'POST' && /vaultProfiles$/.test(x.path))!;
    expect(s.provisionedAt, 'the Date header of the first provisioning answer').toBe(new Date(firstProvisioning.date).toISOString());
    expect(s.runId).toBe(runId());
    const p = s.provisioning;
    expect(p.ilmHost).toBe('http://localhost:3080');
    expect(p.connectorHost).toBe('connectors.local');
    expect(p.connectors).toEqual({
        credentialProvider: { name: 'common-credential-provider', uuid: C_CRED }, ejbca: { name: 'ejbca-ng-connector', uuid: C_EJBCA },
        timestampFormatting: { name: 'timestamp-formatting-connector', uuid: C_TFC }, vault: { name: 'common-credential-provider-v2', uuid: C_VAULT },
    });
    expect(p.credential).toEqual({ name: AUTHORITY_NAME, uuid: CREDENTIAL });
    expect(p.authority).toEqual({ name: AUTHORITY_NAME, uuid: AUTHORITY });
    expect(p.vaultInstance).toEqual({ name: 'vault', uuid: VAULT });
    expect(p.mappedUser.username).toBe(`${runId()}-tsp-user-ab12`);
    expect(p.timeQuality).toEqual({ name: `${runId()}-time-quality-ab12`, uuid: p.timeQuality.uuid, accuracy: 'PT1S', ntpServers: ['ntp'], maxClockDrift: 'PT0.8S' });
    expect(Object.keys(p.sets)).toEqual(['rsa', 'mldsa65']);
    const rsa = p.sets.rsa;
    expect(rsa).toMatchObject({ cryptoProvider: 'software-v2', connector: { uuid: C_CRYPTO }, keyAlgorithm: 'RSA', label: 'RSA' });
    expect(p.sets.mldsa65).toMatchObject({ keyAlgorithm: 'ML-DSA', label: 'ML-DSA', token: rsa.token, tokenProfile: rsa.tokenProfile });
    expect(Object.keys(rsa.nonQualified).sort()).toEqual(['basicCredential', 'certificate', 'key', 'policyOid', 'qualified', 'raProfile', 'signingProfile', 'tspProfile']);
    expect(rsa.nonQualified.qualified).toBe(false);
    expect(rsa.qualified).toMatchObject({ qualified: true, policyOid: '1.2.3.4.5.7' });
    expect(rsa.qualified.certificate.commonName).toBe(`${runId()}-tsa-rsa-qualified-ab12`);
    expect(rsa.qualified.basicCredential.username).toBe(p.mappedUser.username);
    expect(s.missingFamilies).toEqual({});

    await withProcessEnv({ REG_STATE_DIR: stateDir, REG_RUN_ID: runId() }, async () => {
        const file = writeSummary(s);
        expect(file).toBe(summaryFile());
        expect(fs.statSync(file).mode & 0o777, 'mode 0600: the file holds the Basic credential passwords').toBe(0o600);
        expect(JSON.parse(fs.readFileSync(file, 'utf8'))).toEqual(s);
        expect(fs.readdirSync(path.dirname(file)).filter((f) => f.endsWith('.tmp')), 'no temp file left').toEqual([]);
    });
});

test('secrets are generated: no literal password in any body or in the provisioner source', async ({}, testInfo) => {
    const first = await runSetup(testInfo);
    const second = await runSetup(testInfo);
    const passwords = (r: Run) => r.sent.filter((x) => /basicCredentials$/.test(x.path)).map((x) => (x.body as Json).password as string);
    const codes = (r: Run) => r.sent.filter((x) => x.method === 'POST' && x.path === '/v1/tokens').map((x) => (x.body as Json).attributes.find((a: Json) => a.name === 'data_tokenCode').content[0].data.secret as string);
    const all = [...passwords(first), ...passwords(second), ...codes(first), ...codes(second)];
    expect(all).toHaveLength(10);
    expect(new Set(all).size, 'every secret differs (per credential, per run)').toBe(all.length);
    for (const p of all) expect(p).toMatch(/^Ts[A-Za-z0-9_-]{24}$/);
    // The summary carries exactly what was sent (the specs authenticate with it).
    const s = ready(first.summary);
    const inSummary = Object.values(s.provisioning.sets).flatMap((f) => [f.nonQualified.basicCredential.password, f.qualified.basicCredential.password]);
    expect(inSummary).toEqual(passwords(first));
    // Every secret-like field of every body sent, at any depth, holds a generated value.
    const secretKey = /pass(word|phrase)?|secret|pin|code/i;
    const walk = (v: unknown, at: string): void => {
        if (Array.isArray(v)) v.forEach((x, i) => walk(x, `${at}[${i}]`));
        else if (v && typeof v === 'object') {
            for (const [k, x] of Object.entries(v)) {
                if (secretKey.test(k) && typeof x === 'string') expect(x, `${at}.${k} is generated`).toMatch(/^Ts[A-Za-z0-9_-]{24}$/);
                walk(x, `${at}.${k}`);
            }
        }
    };
    for (const x of [...first.sent, ...second.sent]) walk(x.body, `${x.method} ${template(x.path)}`);
    // And the provisioner's source assigns no secret-like name a string literal (any quote, `:` or `=`, any case).
    const dir = path.join(__dirname, '..', '..', 'utils', 'timestamping', 'provision');
    const literal = /\b\w*(pass(word|phrase)?|secret|pin|token_?code)\w*['"]?\s*[:=]\s*['"`][^'"`\s]/i;
    for (const f of [...fs.readdirSync(dir).map((x) => path.join(dir, x)), path.join(__dirname, '..', 'timestamping', 'timestamping.setup.ts')]) {
        const src = fs.readFileSync(f, 'utf8');
        const hit = src.split('\n').find((l) => literal.test(l));
        expect(hit, `${path.basename(f)}: no secret literal`).toBeUndefined();
    }
});

test('a family that fails mid-way is missing with its step and reason; its objects stay in the ledger; the others are ready', async ({}, testInfo) => {
    const run = await runSetup(testInfo, { failIssuanceOf: 'mldsa65-non-qualified' });
    const s = ready(run.summary);
    expect(Object.keys(s.provisioning.sets)).toEqual(['rsa']);
    expect(s.missingFamilies.mldsa65).toBe('the ML-DSA family stopped at step 15 (issuance, non-qualified): certificate issuance failed (the CA\'s message is in the setup log)');
    const mldsa = run.ledger.filter((l) => l.name.includes('mldsa65') && l.type !== 'keyItems').map((l) => l.type);
    expect(mldsa, 'created before the failure, recorded, left to the teardown').toEqual(['keys', 'raProfiles', 'certificates']);
    expect(run.sent.filter((x) => x.method === 'POST' && x.path === '/v1/tspProfiles'), 'no TSP profile for the failed family').toHaveLength(2);
});

test('an already trusted issuing CA is left alone (the only pre-existing object the setup may change)', async ({}, testInfo) => {
    const run = await runSetup(testInfo, { caTrusted: true });
    ready(run.summary);
    expect(run.sent.filter((x) => x.method === 'PATCH' && x.path.startsWith('/v1/certificates/'))).toEqual([]);
    // Every other write targets an own object: the last uuid of the path is in the ledger, unless the path creates
    // under a parent (a vault profile under the vault, an RA profile under the authority, …).
    const own = new Set(run.ledger.map((l) => l.uuid));
    for (const m of mutations(run.sent)) {
        if (/\/(vaultProfiles|tokenProfiles|raProfiles|certificates|keyPair|basicCredentials)$/.test(m.path)) continue;
        const target = m.path.match(new RegExp(UUID, 'g'))?.pop();
        if (target) expect(own.has(target), `${m.method} ${template(m.path)} targets an own object`).toBe(true);
    }
});

test('permissionDocument merges the sets like merge_permissions: grouped, sorted, de-duplicated', () => {
    const ref = (n: number, name: string) => ({ uuid: U(n), name, kind: 'own' as const });
    const token = ref(1, 't');
    const tp = ref(2, 'tp');
    const doc = permissionDocument([
        { tspProfile: ref(9, 'b'), signingProfile: ref(8, 's2'), token, tokenProfile: tp },
        { tspProfile: ref(7, 'a'), signingProfile: ref(6, 's1'), token, tokenProfile: tp },
    ]);
    expect(doc.resources.map((r: Json) => r.name)).toEqual(['keys', 'signingProfiles', 'tokenProfiles', 'tokens', 'tspProfiles']);
    expect(doc.resources.find((r: Json) => r.name === 'tspProfiles').objects.map((o: Json) => o.uuid), 'objects by uuid').toEqual([U(7), U(9)]);
    expect(doc.resources.find((r: Json) => r.name === 'tokens').objects, 'one object per uuid').toEqual([{ uuid: U(1), name: 't', allow: ['detail'], deny: [] }]);
    expect(permissionDocument([])).toEqual({ allowAllResources: false, resources: [] });
});

// ------------------------------------------------------------------ failures: the tier's answer, or the setup's own error

test('a 4xx on one of the setup\'s creates or a refused identity is a hard failure, never a tier reason; no answer text in it', async ({}, testInfo) => {
    const refusedBody = runSetup(testInfo, { statusFor: { 'POST /v1/tspProfiles': 422 } });
    await expect(refusedBody).rejects.toThrow(SetupError);
    await expect(refusedBody).rejects.toThrow(/^step 17 \(TSP profile, non-qualified\): POST \/v1\/tspProfiles answered HTTP 422: core refuses the body the setup sent$/);
    const badRequest = runSetup(testInfo, { statusFor: { 'POST /v1/authorities/{id}/raProfiles': 400 } });
    await expect(badRequest).rejects.toThrow(/POST \/v1\/authorities\/\{id\}\/raProfiles answered HTTP 400/);
    const identity = runSetup(testInfo, { statusFor: { 'GET /v1/connectors': 401 } });
    await expect(identity).rejects.toThrow(/^GET \/v1\/connectors answered HTTP 401: the admin identity is refused$/);
    const forbidden = runSetup(testInfo, { statusFor: { 'POST /v1/users': 403 } });
    await expect(forbidden).rejects.toThrow(SetupError);
    for (const p of [refusedBody, badRequest, identity, forbidden]) await expect(p).rejects.not.toThrow(new RegExp(ECHO));
});

test('a shared step failing at the tier is unavailable with the step and status, no answer text', async ({}, testInfo) => {
    const run = await runSetup(testInfo, { statusFor: { 'POST /v1/timeQualityConfigurations': 500 } });
    expect(run.summary.status).toBe('unavailable');
    const reason = run.summary.status === 'unavailable' ? run.summary.reason : '';
    expect(reason).toBe('provisioning stopped at step 8 (time-quality configuration): POST /v1/timeQualityConfigurations answered HTTP 500 '
        + '(the objects created so far are in the ledger; the teardown removes them)');
    expect(reason).not.toContain(ECHO);
    expect(run.ledger.map((l) => l.type), 'what was created stays recorded').toEqual(['vaultProfiles', 'tokens', 'tokenProfiles']);
});

test('the RSA family failing mid-way fails the setup (the plan requires it); a timed-out ML-DSA issuance is a missing family', async ({}, testInfo) => {
    await expect(runSetup(testInfo, { failIssuanceOf: 'rsa-non-qualified' })).rejects.toThrow(/the RSA family is required/);
    const stuck = await runSetup(testInfo, { neverIssue: 'mldsa65-qualified' });
    const s = ready(stuck.summary);
    expect(s.missingFamilies.mldsa65).toBe('the ML-DSA family stopped at step 15 (issuance, qualified): certificate issuance timed out after 20 reads (last state: \'requested\')');
    expect(Object.keys(s.provisioning.sets)).toEqual(['rsa']);
});

test('the chain root must be a self-signed CA Core has not trusted yet; anything else is the family\'s reason, and nothing is patched', async ({}, testInfo) => {
    const notRoot = await runSetup(testInfo, { mldsaIssuer: 'notSelfSigned' });
    expect(ready(notRoot.summary).missingFamilies.mldsa65).toBe('the ML-DSA family stopped at step 16 (trust chain, non-qualified): '
        + 'the top of the TSA certificate\'s chain is not self-signed: Core holds no certificate of its issuer');
    expect(notRoot.sent.filter((x) => x.method === 'PATCH' && x.path === `/v1/certificates/${OTHER_CA}`)).toEqual([]);
    const noFlag = await runSetup(testInfo, { mldsaIssuer: 'noTrustFlag' });
    expect(ready(noFlag.summary).missingFamilies.mldsa65).toMatch(/carries no trustedCa flag \(not a CA certificate in Core\)$/);
    expect(noFlag.sent.filter((x) => x.method === 'PATCH' && x.path === `/v1/certificates/${OTHER_CA}`)).toEqual([]);
});

test('a key-spec field the run sets that the connector does not offer stops the family (no silent default size)', async ({}, testInfo) => {
    const run = await runSetup(testInfo, { mldsaLevelName: 'data_mldsaParameterSet' });
    expect(ready(run.summary).missingFamilies.mldsa65).toBe('the ML-DSA family stopped at step 12 (key pair, non-qualified): the run sets data_mldsaLevel, which the ML-DSA key spec does not offer');
    expect(run.sent.filter((x) => x.method === 'POST' && /keys\/keyPair$/.test(x.path))).toHaveLength(2);
});

test('key items come from the key detail when the create answers none, read before the enable', async ({}, testInfo) => {
    const run = await runSetup(testInfo, { keyWithoutItems: true });
    ready(run.summary);
    const items = run.ledger.filter((l) => l.type === 'keyItems');
    expect(items).toHaveLength(8);
    for (const key of run.ledger.filter((l) => l.type === 'keys')) {
        expect(items.filter((i) => i.parents?.key === key.uuid), `two items of ${key.name}`).toHaveLength(2);
        const detail = run.sent.findIndex((x) => x.method === 'GET' && x.path === `/v1/keys/${key.uuid}`);
        const enable = run.sent.findIndex((x) => x.method === 'PATCH' && x.path === `/v1/keys/${key.uuid}/enable`);
        expect(detail, 'the detail is read before the enable').toBeLessThan(enable);
        expect(run.sent[enable].ledgerLines, 'the items are recorded before the enable is sent').toBe(run.ledger.indexOf(items.filter((i) => i.parents?.key === key.uuid)[1]) + 1);
    }
});

test('an issuer certificate Core added during the run is a derived line with the server-clock bound; a pre-existing one is not recorded', async ({}, testInfo) => {
    // The pre-existing case first: both runs share one ledger, and a recorded uuid is never recorded again.
    const preExisting = await runSetup(testInfo);
    expect(preExisting.ledger.filter((l) => l.uuid === ROOT_CA)).toEqual([]);
    const added = await runSetup(testInfo, { rootCreatedAt: '2026-10-22T10:00:30Z' });
    const s = ready(added.summary);
    const derived = added.ledger.filter((l) => l.uuid === ROOT_CA);
    expect(derived, 'recorded once, though four chains walk it').toHaveLength(1);
    expect(derived[0]).toMatchObject({ type: 'certificates', derived: true, spec: SETUP_LEDGER_SPEC, name: 'Demo Root', createdAfter: new Date(Date.parse(s.provisionedAt) - 2_000).toISOString() });
});
