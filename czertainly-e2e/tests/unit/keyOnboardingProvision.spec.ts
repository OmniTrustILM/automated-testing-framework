/**
 * keyOnboardingProvision — the key onboarding setup (utils/keyOnboarding/provision) against an in-process fake core,
 * through the REAL strict guard, with a fake docker or kubectl runner (on a shared tier the fake kubectl runs the real
 * in-sidecar scripts with `sh` against a fake pkcs11-tool).
 */
import { APIRequestContext, expect, test } from '@playwright/test';
import { spawnSync } from 'child_process';
import { generateKeyPairSync, randomBytes, X509Certificate } from 'crypto';
import * as fs from 'fs';
import * as path from 'path';
import { keyOnboardingConfig, summaryFile } from '../../utils/keyOnboarding/config';
import { defaultDockerRunner, type DockerResult, type DockerRunner } from '../../utils/keyOnboarding/provision/docker';
import { canIAnswer, clusterPin, connectorTargetProblem, execArgs as execArgsOf, KILLED_EXIT, KubectlRunner, pinnedKubectl, removeKubeconfigs, scriptStdin, shellQuote, sidecarPods, spawnTool } from '../../utils/keyOnboarding/provision/kubectl';
import { keyOnboardingBlock, teardownBlock as koTeardownBlock } from '../../utils/keyOnboarding/blockTeardown';
import { scrubError, scrubSecrets, secretForms, TierError } from '../../utils/devBlocks/provision/transport';
import { uuidOf as uuidOfShared } from '../../utils/devBlocks/provision/names';
import { teardownBlock } from '../../utils/devBlocks/blockTeardown';
import devBlockGlobalTeardown from '../../utils/devBlocks/globalTeardown';
import type { TeardownHandler } from '../../utils/regression/teardown/runTeardown';
import { plantingMarkerFile } from '../../utils/keyOnboarding/config';
import { PLANT_EXEC_SCRIPT, PLANT_SCRIPT, plantingLeftover, plantingMarkerExists, plantKeys, readMarker, UNPLANT_EXEC_SCRIPT, UNPLANT_SCRIPT, unplantRunKeys } from '../../utils/keyOnboarding/provision/plant';
import { offlineBlocker, pinLooksLikeAnId, uriNamesToken } from '../../utils/keyOnboarding/provision/preflight';
import { provisionKeyOnboarding, SETUP_LEDGER_SPEC, writeSummary } from '../../utils/keyOnboarding/provision/provision';
import type { KeyOnboardingSummary } from '../../utils/keyOnboarding/types';
import { guardApiWithSeams } from '../../utils/regression/guard/createGuard';
import type { GuardedApi } from '../../utils/regression/guard/types';
import { LedgerLine, readLedger } from '../../utils/regression/ledger/ledger';
import { OwnObjectViolation } from '../../utils/regression/ledger/ownership';
import { runId } from '../../utils/regression/ledger/runState';
import { tierIdentity } from '../../utils/regression/tier/kind';
import { localProofFile } from '../../utils/regression/tier/localProof';
import { SetupError } from '../../utils/timestamping/provision/transport';
import { withProcessEnv } from './helpers/guardRig';

type Json = Record<string, any>;

const U = (n: number) => `00000000-0000-4000-8000-${String(n).padStart(12, '0')}`;
const UUID = '[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}';
const C_PKCS11 = U(1);
const C_VAULT = U(2);
const I_CRYPTO = U(3);
const I_SECRET = U(4);
const PKCS11_URL = 'http://localhost:8290';
const VAULT_URL = 'http://localhost:8200';
const BASE_DATE = Date.parse('2026-10-23T10:00:00Z');
const NO_POLL_PAUSE = { secretIntervalMs: 0 };
const STAMP = 'ab12';
const SIDECAR = 'pkcs11-sidecar-softhsm';
const SIDECAR_IMAGE = 'harbor.example/pkcs11-sidecar:1.0.0';
const CERTIFICATE = 'MIIBszCCAVmgAwIBAgIUQ2VydGlmaWVk';
const PIN = `pin-${randomBytes(9).toString('hex')}`;
const RUN = 'qa-reg-20261023-101010-ab12';
/** The text a refused answer carries: it must stay in the log. */
const ECHO = 'ECHO-OF-THE-REQUEST-BODY';

const defaultConnectors = (): Json[] => [
    { uuid: U(9), name: 'software-cryptography-provider-v2', url: 'http://localhost:8230', version: 'v2', status: 'connected', interfaces: [{ uuid: U(10), code: 'cryptography' }] },
    { uuid: C_PKCS11, name: 'pkcs11-cryptography-provider', url: PKCS11_URL, version: 'v2', status: 'connected', interfaces: [{ uuid: I_CRYPTO, code: 'cryptography', features: ['keyList'] }] },
    { uuid: U(11), name: 'common-credential-provider', url: VAULT_URL, version: 'v1', status: 'connected', interfaces: [] },
    { uuid: C_VAULT, name: 'common-credential-provider-v2', url: VAULT_URL, version: 'v2', status: 'connected', interfaces: [{ uuid: I_SECRET, code: 'secret' }] },
];

interface FakeOptions {
    connectors?: Json[];
    tokenUris?: string[];
    /** `METHOD /path/{id}` → a status answered instead of the route's (with a body that must never reach a reason). */
    statusFor?: Record<string, number>;
    echoBody?: boolean;
    /** The secret never leaves `inactive`. */
    secretStuck?: boolean;
}

interface Sent {
    seq: number;
    method: string;
    path: string;
    body: unknown;
    ledgerLines: number;
    created?: string;
    date: string;
}

interface DockerCall {
    seq: number;
    args: string[];
    env: Record<string, string>;
}

interface DockerOptions {
    noDaemon?: boolean;
    sidecarStopped?: boolean;
    plantExit?: number;
    plantOutput?: string;
    unplantCount?: string;
}

let seq = 0;
let stateDir = '';
const ledgerPath = () => path.join(stateDir, 'created-objects.jsonl');
const ledgerCount = () => (fs.existsSync(ledgerPath()) ? fs.readFileSync(ledgerPath(), 'utf8').split('\n').filter(Boolean).length : 0);

function fakeCore(opts: FakeOptions = {}) {
    const sent: Sent[] = [];
    let n = 1000;
    const next = () => `aaaaaaaa-0000-4000-8000-${String(++n).padStart(12, '0')}`;
    const names = new Map<string, string>();
    const create = (body: Json = {}) => {
        const uuid = next();
        names.set(uuid, String(body.name ?? ''));
        return { uuid };
    };
    const named = (uuid: string): [number, unknown] => (names.has(uuid) ? [200, { uuid, name: names.get(uuid) }] : [404, { message: 'not found' }]);
    const secrets = new Map<string, { reads: number; enabled: boolean }>();
    const routes: Array<[string, RegExp, (m: RegExpMatchArray, body: Json) => [number, unknown]]> = [
        ['POST', /^\/v2\/connectors\/list$/, () => [200, { items: opts.connectors ?? defaultConnectors(), totalPages: 1 }]],
        ['GET', new RegExp(`^/v1/tokens/${UUID}/attributes$`), () => [200, [
            { uuid: U(20), name: 'profile', contentType: 'string', type: 'data' },
            { uuid: U(21), name: 'token', contentType: 'string', type: 'data' },
            { uuid: U(22), name: 'pin', contentType: 'resource', type: 'data' },
        ]]],
        ['POST', new RegExp(`^/v2/connectors/${UUID}/callback$`), () => [200, (opts.tokenUris ?? ['pkcs11:model=SoftHSM%20v2;token=softhsm;serial=1', 'pkcs11:token=other;serial=2'])
            .map((data, i) => ({ data, reference: `token ${i}` }))]],
        ['POST', /^\/v1\/vaults$/, (_m, b) => [200, create(b)]],
        ['GET', new RegExp(`^/v1/vaults/(${UUID})$`), (m) => named(m[1])],
        ['POST', new RegExp(`^/v1/vaults/${UUID}/vaultProfiles$`), (_m, b) => [200, create(b)]],
        ['GET', new RegExp(`^/v1/vaults/${UUID}/vaultProfiles/(${UUID})$`), (m) => named(m[1])],
        ['PATCH', new RegExp(`^/v1/vaults/${UUID}/vaultProfiles/${UUID}/enable$`), () => [204, undefined]],
        ['POST', new RegExp(`^/v1/vaults/${UUID}/vaultProfiles/${UUID}/secrets$`), (_m, b) => {
            const c = create(b);
            secrets.set(c.uuid, { reads: 0, enabled: false });
            return [200, c];
        }],
        ['GET', new RegExp(`^/v1/secrets/(${UUID})$`), (m) => {
            const s = secrets.get(m[1])!;
            s.reads += 1;
            const state = s.reads === 1 || opts.secretStuck ? 'inactive' : 'active';
            return [200, { uuid: m[1], name: names.get(m[1]), state, enabled: s.enabled }];
        }],
        ['PATCH', new RegExp(`^/v1/secrets/(${UUID})/enable$`), (m) => {
            secrets.get(m[1])!.enabled = true;
            return [204, undefined];
        }],
        ['POST', /^\/v1\/tokens$/, (_m, b) => [200, create(b)]],
        ['GET', new RegExp(`^/v1/tokens/(${UUID})$`), (m) => named(m[1])],
        ['POST', new RegExp(`^/v1/tokens/${UUID}/tokenProfiles$`), (_m, b) => [200, create(b)]],
        ['GET', new RegExp(`^/v1/tokens/${UUID}/tokenProfiles/(${UUID})$`), (m) => named(m[1])],
        ['PATCH', new RegExp(`^/v1/tokens/${UUID}/tokenProfiles/${UUID}/enable$`), () => [204, undefined]],
    ];
    const answer = (method: string, url: string, data: unknown) => {
        const apiPath = url.replace(/^\/api/, '').split('?')[0];
        const body = (typeof data === 'string' ? (data ? JSON.parse(data) : undefined) : Buffer.isBuffer(data) ? JSON.parse(data.toString('utf8')) : data) as Json | undefined;
        const date = new Date(BASE_DATE + sent.length * 1000).toUTCString();
        const entry: Sent = { seq: ++seq, method, path: apiPath, body, ledgerLines: ledgerCount(), date };
        sent.push(entry);
        let status = 404;
        let out: unknown = { message: `no route for ${method} ${apiPath}` };
        const forced = opts.statusFor?.[`${method} ${template(apiPath)}`];
        if (forced !== undefined) [status, out] = [forced, { message: opts.echoBody ? `${ECHO} ${JSON.stringify(body)}` : ECHO }];
        else {
            for (const [m, re, handle] of routes) {
                const hit = m === method ? apiPath.match(re) : null;
                if (hit) {
                    [status, out] = handle(hit, body ?? {});
                    break;
                }
            }
        }
        if (status < 300 && method === 'POST' && out && typeof out === 'object' && 'uuid' in (out as Json)) entry.created = String((out as Json).uuid);
        const text = out === undefined ? '' : JSON.stringify(out);
        return { status: () => status, ok: () => status < 300, text: async () => text, json: async () => out, headers: () => ({ date }) };
    };
    const api = {
        get: async (url: string) => answer('GET', url, undefined),
        head: async () => answer('HEAD', '/', undefined),
        fetch: async (url: string, o: { method?: string; data?: unknown } = {}) => answer((o.method ?? 'GET').toUpperCase(), url, o.data),
        dispose: async () => undefined,
        storageState: async () => ({ cookies: [], origins: [] }),
    } as unknown as APIRequestContext;
    return { api, sent };
}

function fakeDocker(opts: DockerOptions = {}) {
    const calls: DockerCall[] = [];
    const ok = (stdout: string): DockerResult => ({ code: 0, stdout, stderr: '' });
    const runner: DockerRunner = async (args, o = {}) => {
        calls.push({ seq: ++seq, args: [...args], env: { ...(o.env ?? {}) } });
        if (args[0] === 'version') return opts.noDaemon ? { code: 1, stdout: '', stderr: 'Cannot connect to the Docker daemon' } : ok('27.3.1\n');
        if (args[0] === 'inspect') {
            const format = args[2];
            if (format === '{{.State.Running}}') return ok(opts.sidecarStopped ? 'false\n' : 'true\n');
            if (format === '{{.Config.Image}}') return ok(`${SIDECAR_IMAGE}\n`);
            if (format === '{{.Config.User}}') return ok('\n');
            return ok('PATH=/usr/bin\nSOFTHSM2_CONF=/etc/softhsm/softhsm2.conf\n\n');
        }
        if (args[0] === 'run' && args.at(-1) === '/plant-keys.sh') {
            return { code: opts.plantExit ?? 0, stdout: opts.plantOutput ?? `${CERTIFICATE}\n`, stderr: opts.plantExit ? 'pkcs11-tool: login failed' : '' };
        }
        if (args[0] === 'run' && args.at(-1) === '/unplant-keys.sh') return ok(`${opts.unplantCount ?? '7'}\n`);
        return { code: 2, stdout: '', stderr: `unexpected docker ${args.join(' ')}` };
    };
    return { runner, calls };
}

function provenLocalEnv(dir: string, extra: NodeJS.ProcessEnv = {}): NodeJS.ProcessEnv {
    const env: NodeJS.ProcessEnv = { TIER_KIND: 'local', BASE_URL: 'http://localhost:3080', REG_STATE_DIR: dir, REG_RUN_ID: runId(), KO_TOKEN_PIN: PIN, ...extra };
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(localProofFile(env), JSON.stringify({ runId: runId(), tier: tierIdentity(env), at: new Date().toISOString() }));
    return env;
}

interface Run {
    summary: KeyOnboardingSummary;
    sent: Sent[];
    docker: DockerCall[];
    ledger: LedgerLine[];
    env: NodeJS.ProcessEnv;
}

async function runSetup(
    testInfo: { outputPath: (p: string) => string }, fake: FakeOptions = {}, dockerOpts: DockerOptions = {},
    envOf: (dir: string) => NodeJS.ProcessEnv = (d) => provenLocalEnv(d), kubectl?: KubectlRunner,
): Promise<Run> {
    stateDir = testInfo.outputPath('state');
    const env = envOf(stateDir);
    fs.rmSync(plantingMarkerFile(RUN, env), { force: true });
    const core = fakeCore(fake);
    const docker = fakeDocker(dockerOpts);
    return withProcessEnv({ REG_STATE_DIR: stateDir, BASE_URL: env.BASE_URL ?? 'http://localhost:3080' }, async () => {
        const api: GuardedApi = guardApiWithSeams(core.api, { env, runId: runId(), tier: null });
        const summary = await provisionKeyOnboarding(api, { cfg: keyOnboardingConfig(env), env, poll: NO_POLL_PAUSE, docker: docker.runner, ...(kubectl ? { kubectl } : {}), stamp: STAMP, runId: RUN });
        return { summary, sent: core.sent, docker: docker.calls, ledger: readLedger(ledgerPath()), env };
    });
}

const template = (p: string) => p.replace(new RegExp(UUID, 'g'), '{id}');
const mutations = (sent: Sent[]) => sent.filter((s) => s.method !== 'GET' && !/\/list$|\/callback$/.test(s.path));
const reasonOf = (s: KeyOnboardingSummary) => (s.status === 'unavailable' ? s.reason : `ready (${s.status})`);
const ready = (s: KeyOnboardingSummary) => {
    expect(s.status, reasonOf(s)).toBe('ready');
    return s as Extract<KeyOnboardingSummary, { status: 'ready' }>;
};
const scriptRuns = (calls: DockerCall[]) => calls.filter((c) => c.args[0] === 'run');

test('a shared tier without a pinned cluster, a missing local proof and a missing PIN are unavailable without a request and without docker', async ({}, testInfo) => {
    const shared = await runSetup(testInfo, {}, {}, (d) => ({ TIER_KIND: 'shared', BASE_URL: 'https://tier.example', REG_STATE_DIR: d, REG_RUN_ID: runId(), KO_TOKEN_PIN: PIN }));
    expect(reasonOf(shared.summary)).toBe('no cluster is pinned: the runner is not in a pod with a service account and KO_KUBE_CONTEXT is not set (no ambient kubectl context is used)');
    expect(shared.sent, 'no request on a shared tier').toEqual([]);
    expect(shared.docker, 'no docker on a shared tier').toEqual([]);

    const unproven = await runSetup(testInfo, {}, {}, (d) => ({ TIER_KIND: 'local', BASE_URL: 'http://localhost:3080', REG_STATE_DIR: d, REG_RUN_ID: runId(), KO_TOKEN_PIN: PIN }));
    expect(reasonOf(unproven.summary)).toMatch(/local-backend proof/);
    expect(unproven.sent).toEqual([]);
    expect(unproven.docker).toEqual([]);

    const noPin = await runSetup(testInfo, {}, {}, (d) => provenLocalEnv(d, { KO_TOKEN_PIN: '' }));
    expect(reasonOf(noPin.summary)).toBe('KO_TOKEN_PIN is not set: the token\'s user PIN has no default');
    expect(noPin.sent).toEqual([]);
    expect(noPin.docker).toEqual([]);
    expect(readLedger(ledgerPath()), 'nothing was created').toEqual([]);
});

test('no docker daemon and a stopped sidecar are unavailable after docker alone answered: no platform request', async ({}, testInfo) => {
    const noDaemon = await runSetup(testInfo, {}, { noDaemon: true });
    expect(reasonOf(noDaemon.summary)).toBe('docker is not available on the runner (planting key pairs on the token needs a docker daemon)');
    expect(noDaemon.sent).toEqual([]);
    expect(noDaemon.docker.map((c) => c.args[0])).toEqual(['version']);

    const stopped = await runSetup(testInfo, {}, { sidecarStopped: true });
    expect(reasonOf(stopped.summary)).toBe('the SoftHSM sidecar container KO_SIDECAR_CONTAINER names is not running');
    expect(stopped.sent).toEqual([]);
    expect(stopped.docker.map((c) => c.args.join(' '))).toEqual(['version --format {{.Server.Version}}', `inspect -f {{.State.Running}} ${SIDECAR}`]);
    expect(JSON.stringify(stopped.summary), 'a reason names the variable, not the container').not.toContain(SIDECAR);
});

test('control: the strict guard refuses the token-form callback the preflight did not register, and lets the setup through after it did', async ({}, testInfo) => {
    stateDir = testInfo.outputPath('state');
    const env = provenLocalEnv(stateDir);
    const core = fakeCore();
    await withProcessEnv({ REG_STATE_DIR: stateDir, BASE_URL: 'http://localhost:3080' }, async () => {
        const api = guardApiWithSeams(core.api, { env, runId: runId(), tier: null });
        const refused = await api.post(`/api/v2/connectors/${C_PKCS11}/callback`, { data: { name: 'token', uuid: U(21), interfaceUuid: I_CRYPTO, attributes: [] } }).then(() => 'sent', (e: unknown) => (e instanceof OwnObjectViolation ? e.kind : String(e)));
        expect(refused, 'an unregistered connector').toBe('request');
        expect(core.sent, 'nothing reached the core').toEqual([]);
        const summary = await provisionKeyOnboarding(api, { cfg: keyOnboardingConfig(env), env, poll: NO_POLL_PAUSE, docker: fakeDocker().runner, stamp: STAMP, runId: RUN });
        expect(reasonOf(summary)).toBe('ready (ready)');
        expect(core.sent.filter((x) => /\/callback$/.test(x.path)).map((x) => x.path), 'the callback went to the connector found').toEqual([`/v2/connectors/${C_PKCS11}/callback`]);
    });
});

test('preflight: a missing, a waiting, a v1-only connector, no keyList, no secret interface and no single token are named reasons; nothing is written', async ({}, testInfo) => {
    const cases: Array<[string, FakeOptions, string | RegExp]> = [
        ['missing PKCS#11 connector', { connectors: defaultConnectors().filter((c) => c.uuid !== C_PKCS11) },
            'no PKCS#11 cryptography-provider connector (v2) is registered at KO_PKCS11_CONNECTOR_URL (the setup never registers one)'],
        ['waiting PKCS#11 connector', { connectors: defaultConnectors().map((c) => (c.uuid === C_PKCS11 ? { ...c, status: 'waitingForApproval' } : c)) },
            'the PKCS#11 cryptography-provider connector at KO_PKCS11_CONNECTOR_URL is waiting for approval (the setup never approves a connector; approve it on the local stack and re-run)'],
        ['offline PKCS#11 connector', { connectors: defaultConnectors().map((c) => (c.uuid === C_PKCS11 ? { ...c, status: 'offline' } : c)) },
            'the PKCS#11 cryptography-provider connector at KO_PKCS11_CONNECTOR_URL is offline, not connected'],
        ['no keyList', { connectors: defaultConnectors().map((c) => (c.uuid === C_PKCS11 ? { ...c, interfaces: [{ uuid: I_CRYPTO, code: 'cryptography', features: [] }] } : c)) },
            'the PKCS#11 connector at KO_PKCS11_CONNECTOR_URL does not advertise the keyList feature on its cryptography interface'],
        ['vault connector v1 only', { connectors: defaultConnectors().filter((c) => c.uuid !== C_VAULT) },
            'no credential-provider connector (v2) is registered at KO_VAULT_CONNECTOR_URL (the setup never registers one)'],
        ['no secret interface', { connectors: defaultConnectors().map((c) => (c.uuid === C_VAULT ? { ...c, interfaces: [] } : c)) },
            'the credential-provider connector at KO_VAULT_CONNECTOR_URL exposes no secret interface'],
        ['token not offered', { tokenUris: ['pkcs11:token=other'] }, /offers 0 tokens labelled as KO_PKCS11_TOKEN says \(exactly one is needed/],
        ['token offered twice', { tokenUris: ['pkcs11:token=softhsm;serial=1', 'pkcs11:token=softhsm;serial=2'] }, /offers 2 tokens labelled as KO_PKCS11_TOKEN says/],
    ];
    for (const [what, fake, reason] of cases) {
        const run = await runSetup(testInfo, fake);
        expect(reasonOf(run.summary), what).toEqual(typeof reason === 'string' ? reason : expect.stringMatching(reason));
        expect(mutations(run.sent), `${what}: read-only`).toEqual([]);
        expect(run.sent.some((s) => /approve|\/v[12]\/connectors$/.test(s.path)), `${what}: never registered or approved`).toBe(false);
        expect(scriptRuns(run.docker), `${what}: nothing planted`).toEqual([]);
        expect(JSON.stringify(run.summary), `${what}: a reason names the variable, never the URL`).not.toMatch(/localhost:82/);
    }
    expect(readLedger(ledgerPath())).toEqual([]);
});

test('uriNamesToken reads the token label of a PKCS#11 URI path, percent-decoded, and nothing else', () => {
    expect(uriNamesToken('pkcs11:model=SoftHSM%20v2;token=softhsm;serial=1', 'softhsm')).toBe(true);
    expect(uriNamesToken('pkcs11:token=soft%20hsm', 'soft hsm')).toBe(true);
    expect(uriNamesToken('pkcs11:token=softhsm2', 'softhsm')).toBe(false);
    expect(uriNamesToken('pkcs11:model=token=softhsm', 'softhsm')).toBe(false);
    expect(uriNamesToken('pkcs11:serial=1?token=softhsm', 'softhsm'), 'a query attribute is not the token').toBe(false);
    expect(uriNamesToken('pkcs11:token=%ZZ', 'x'), 'a malformed escape is no match, not an error').toBe(false);
});

test('provisioning follows the source suite\'s order and records every object once, right after its create, with its parents', async ({}, testInfo) => {
    const run = await runSetup(testInfo);
    ready(run.summary);
    expect(mutations(run.sent).map((s) => `${s.method} ${template(s.path)}`)).toEqual([
        'POST /v1/vaults',
        'POST /v1/vaults/{id}/vaultProfiles', 'PATCH /v1/vaults/{id}/vaultProfiles/{id}/enable',
        'POST /v1/vaults/{id}/vaultProfiles/{id}/secrets', 'PATCH /v1/secrets/{id}/enable',
        'POST /v1/tokens',
        'POST /v1/tokens/{id}/tokenProfiles', 'PATCH /v1/tokens/{id}/tokenProfiles/{id}/enable',
    ]);
    expect(run.sent.filter((s) => s.method === 'GET' && /^\/v1\/secrets\//.test(s.path)).length, 'the secret is read until active and enabled').toBe(4);

    expect(run.ledger.map((l) => l.type)).toEqual(['vaultInstances', 'vaultProfiles', 'secrets', 'tokens', 'tokenProfiles']);
    expect(new Set(run.ledger.map((l) => l.uuid)).size, 'every uuid once').toBe(run.ledger.length);
    for (const l of run.ledger) {
        expect(l.spec, `${l.type} spec`).toBe(SETUP_LEDGER_SPEC);
        expect(l.name.startsWith(`${runId()}-ko-`), `${l.type} ${l.name} carries the run prefix`).toBe(true);
        expect(l.name.endsWith(`-${STAMP}`), `${l.type} ${l.name}: unique per setup attempt`).toBe(true);
        expect(l.event).toBe('created');
    }
    // Right after the create: not in the file when the create was sent, in the file when the next request was sent.
    for (const [i, line] of run.ledger.entries()) {
        const at = run.sent.findIndex((s) => s.created === line.uuid);
        expect(at, `the create of ${line.type}`).toBeGreaterThanOrEqual(0);
        expect(run.sent[at].ledgerLines, `${line.type}: no line before its create`).toBe(i);
        expect(run.sent[at + 1].ledgerLines, `${line.type}: recorded before the next request`).toBe(i + 1);
    }
    const byType = (t: string) => run.ledger.find((l) => l.type === t)!;
    expect(byType('vaultInstances').parents).toBeUndefined();
    expect(byType('vaultProfiles').parents).toEqual({ vault: byType('vaultInstances').uuid });
    expect(byType('secrets').parents).toEqual({ vaultProfile: byType('vaultProfiles').uuid });
    expect(byType('tokens').parents).toBeUndefined();
    expect(byType('tokenProfiles').parents).toEqual({ token: byType('tokens').uuid });

    const own = new Set(run.ledger.map((l) => l.uuid));
    for (const m of mutations(run.sent)) {
        for (const id of m.path.match(new RegExp(UUID, 'g')) ?? []) expect(own.has(id), `${m.method} ${template(m.path)} names own objects only`).toBe(true);
    }
    const lastRequest = Math.max(...run.sent.map((s) => s.seq));
    expect(scriptRuns(run.docker)).toHaveLength(1);
    expect(scriptRuns(run.docker)[0].seq).toBeGreaterThan(lastRequest);
});

test('request bodies follow the source suite: the vault on the secret interface, the PIN secret, the token form', async ({}, testInfo) => {
    const run = await runSetup(testInfo);
    ready(run.summary);
    const post = (re: RegExp) => run.sent.find((x) => x.method === 'POST' && re.test(x.path))!.body as Json;
    expect(post(/^\/v1\/vaults$/)).toEqual({ connectorUuid: C_VAULT, interfaceUuid: I_SECRET, name: `${runId()}-ko-vault-${STAMP}`, attributes: [], customAttributes: [] });
    const secret = post(/\/secrets$/);
    expect(secret.secret, 'the PIN goes to the vault as a generic secret').toEqual({ type: 'generic', content: PIN });
    expect(secret.name).toBe(`${runId()}-ko-token-pin-${STAMP}`);

    const callback = post(/\/callback$/);
    expect(callback).toEqual({ name: 'token', uuid: U(21), interfaceUuid: I_CRYPTO, attributes: [expect.objectContaining({ name: 'profile', content: [{ contentType: 'string', data: 'softhsm' }] })] });
    const token = post(/^\/v1\/tokens$/);
    expect(token.connectorUuid).toBe(C_PKCS11);
    expect(token.attributes.map((a: Json) => [a.name, a.version, a.content])).toEqual([
        ['profile', 'v3', [{ contentType: 'string', data: 'softhsm' }]],
        ['token', 'v3', [{ contentType: 'string', data: 'pkcs11:model=SoftHSM%20v2;token=softhsm;serial=1', reference: 'token 0' }]],
        ['pin', 'v3', [{ contentType: 'resource', data: { resource: 'secrets', uuid: run.ledger.find((l) => l.type === 'secrets')!.uuid, name: secret.name } }]],
    ]);
    expect(post(/tokenProfiles$/).usage).toEqual(['sign', 'verify', 'encrypt', 'decrypt']);
});

test('planting: every label starts with the run id, the source suite\'s IDs and variables, and the PIN in no argv', async ({}, testInfo) => {
    const run = await runSetup(testInfo);
    const s = ready(run.summary);
    const planted = s.provisioning.planted;
    const labels = [planted.rsa, planted.ec, planted.noIdEc, ...planted.idSharingEc, planted.orphan, planted.removable, ...planted.bulkRemovable, planted.compromised, planted.certified];
    expect(labels).toHaveLength(11);
    expect(new Set(labels).size, 'every label differs').toBe(11);
    for (const l of labels) expect(l, l).toMatch(new RegExp(`^${RUN}-ko-[a-z0-9-]+-${STAMP}$`));
    expect(planted.rsa).toBe(`${RUN}-ko-rsa-${STAMP}`);

    const [plant] = scriptRuns(run.docker);
    const env = plant.env;
    expect(plant.args).toEqual([
        'run', '--rm', '--user', '0', '--volumes-from', SIDECAR, '--entrypoint', 'sh', '-v', `${PLANT_SCRIPT}:/plant-keys.sh:ro`,
        ...Object.keys(env).flatMap((k) => ['-e', k]), SIDECAR_IMAGE, '/plant-keys.sh',
    ]);
    expect(fs.existsSync(PLANT_SCRIPT), 'the script the container mounts').toBe(true);
    expect(Object.keys(env).sort()).toEqual([
        'BULK_REMOVABLE_FIRST_ID', 'BULK_REMOVABLE_FIRST_LABEL', 'BULK_REMOVABLE_SECOND_ID', 'BULK_REMOVABLE_SECOND_LABEL', 'CERTIFIED_ID', 'CERTIFIED_LABEL',
        'COMPROMISED_ID', 'COMPROMISED_LABEL', 'EC_ID', 'EC_LABEL', 'NO_ID_EC_LABEL', 'ORPHAN_ID', 'ORPHAN_LABEL', 'REMOVABLE_ID', 'REMOVABLE_LABEL',
        'RSA_ID', 'RSA_LABEL', 'SHARED_ID', 'SHARED_ID_FIRST_LABEL', 'SHARED_ID_SECOND_LABEL', 'SOFTHSM2_CONF', 'TOKEN_LABEL', 'TOKEN_OWNER', 'TOKEN_PIN',
    ]);
    expect(env).toMatchObject({ TOKEN_PIN: PIN, TOKEN_LABEL: 'softhsm', TOKEN_OWNER: '10001:10001', SOFTHSM2_CONF: '/etc/softhsm/softhsm2.conf', RSA_LABEL: planted.rsa, SHARED_ID_SECOND_LABEL: planted.idSharingEc[1] });
    expect(env.RSA_ID, 'a SHA-1 sized ID').toMatch(/^[0-9a-f]{40}$/);
    const shortIds = Object.entries(env).filter(([k]) => k.endsWith('_ID') && k !== 'RSA_ID').map(([, v]) => v);
    expect(shortIds).toHaveLength(8);
    for (const id of shortIds) expect(id).toMatch(/^[0-9a-f]{16}$/);
    expect(new Set([env.RSA_ID, ...shortIds]).size, 'fresh random IDs').toBe(9);

    for (const c of run.docker) expect(c.args.join(' '), `docker ${c.args[0]}: the PIN is never on the command line`).not.toContain(PIN);
    expect(fs.readFileSync(ledgerPath(), 'utf8'), 'the ledger never holds the PIN').not.toContain(PIN);
    expect(JSON.stringify(s), 'the summary never holds the PIN').not.toContain(PIN);
    expect(s.provisioning.certifiedCertificate).toBe(CERTIFICATE);
});

test('the summary has the block\'s shape, the server date as provisionedAt, and mode 0600', async ({}, testInfo) => {
    const run = await runSetup(testInfo);
    const s = ready(run.summary);
    const firstCreate = run.sent.find((x) => x.method === 'POST' && x.path === '/v1/vaults')!;
    expect(s.provisionedAt, 'the Date header of the first provisioning answer').toBe(new Date(firstCreate.date).toISOString());
    expect(s.runId).toBe(runId());
    expect(Object.keys(s).sort()).toEqual(['provisionedAt', 'provisioning', 'runId', 'status']);
    expect(Object.keys(s.provisioning).sort()).toEqual(['certifiedCertificate', 'planted', 'token', 'tokenProfile']);
    const line = (t: string) => run.ledger.find((l) => l.type === t)!;
    expect(s.provisioning.token).toEqual({ name: line('tokens').name, uuid: line('tokens').uuid });
    expect(s.provisioning.tokenProfile).toEqual({ name: line('tokenProfiles').name, uuid: line('tokenProfiles').uuid });

    await withProcessEnv({ REG_STATE_DIR: stateDir, REG_RUN_ID: runId() }, async () => {
        const file = writeSummary(s);
        expect(file).toBe(summaryFile());
        expect(path.basename(file)).toBe(`${runId()}.key-onboarding.json`);
        expect(fs.statSync(file).mode & 0o777, 'mode 0600').toBe(0o600);
        expect(JSON.parse(fs.readFileSync(file, 'utf8'))).toEqual(s);
        expect(fs.readdirSync(path.dirname(file)).filter((f) => f.endsWith('.tmp')), 'no temp file left').toEqual([]);
    });
});

test('the provisioner holds no literal PIN or password, and no secret-like value on a command line', () => {
    const dir = path.join(__dirname, '..', '..', 'utils', 'keyOnboarding', 'provision');
    const literal = /\b\w*(pass(word|phrase)?|secret|pin|token_?code)\w*['"]?\s*[:=]\s*['"`][^'"`\s]/i;
    for (const f of [...fs.readdirSync(dir).map((x) => path.join(dir, x)), path.join(__dirname, '..', 'key-onboarding', 'key-onboarding.setup.ts')]) {
        const hit = fs.readFileSync(f, 'utf8').split('\n').find((l) => literal.test(l));
        expect(hit, `${path.basename(f)}: no secret literal`).toBeUndefined();
    }
});

test('a failing plant script or one that prints no certificate is unavailable with the step; the created objects stay recorded', async ({}, testInfo) => {
    const failed = await runSetup(testInfo, {}, { plantExit: 1 });
    expect(reasonOf(failed.summary)).toBe('provisioning stopped at planting: plant-keys.sh exited 1 (its output is in the setup log) '
        + '(the objects created so far are in the ledger and the key pairs planted so far carry the run prefix; the teardown removes both)');
    expect(failed.ledger.map((l) => l.type)).toEqual(['vaultInstances', 'vaultProfiles', 'secrets', 'tokens', 'tokenProfiles']);
    expect(reasonOf(failed.summary)).not.toContain('login failed');

    const silent = await runSetup(testInfo, {}, { plantOutput: 'apk: network unreachable\n' });
    expect(reasonOf(silent.summary)).toMatch(/^provisioning stopped at planting: plant-keys.sh printed no certificate for the certified pair/);
});

test('a 4xx on one of the setup\'s creates or a refused identity is a hard failure, never a tier reason; no answer text in it', async ({}, testInfo) => {
    const refusedBody = runSetup(testInfo, { statusFor: { 'POST /v1/tokens': 422 } });
    await expect(refusedBody).rejects.toThrow(SetupError);
    await expect(refusedBody).rejects.toThrow(/^token: POST \/v1\/tokens answered HTTP 422: core refuses the body the setup sent$/);
    const identity = runSetup(testInfo, { statusFor: { 'POST /v2/connectors/list': 401 } });
    await expect(identity).rejects.toThrow(/^POST \/v2\/connectors\/list answered HTTP 401: the admin identity is refused$/);
    const forbidden = runSetup(testInfo, { statusFor: { 'POST /v1/vaults/{id}/vaultProfiles/{id}/secrets': 403 } });
    await expect(forbidden).rejects.toThrow(SetupError);
    for (const p of [refusedBody, identity, forbidden]) await expect(p).rejects.not.toThrow(new RegExp(ECHO));
});

test('a step failing at the tier is unavailable with the step and status; a secret that never activates names its last state', async ({}, testInfo) => {
    const down = await runSetup(testInfo, { statusFor: { 'POST /v1/vaults': 500 } });
    expect(reasonOf(down.summary)).toMatch(/^provisioning stopped at vault instance: POST \/v1\/vaults answered HTTP 500 \(/);
    expect(reasonOf(down.summary)).not.toContain(ECHO);
    expect(down.ledger).toEqual([]);

    const stuck = await runSetup(testInfo, { secretStuck: true });
    expect(reasonOf(stuck.summary)).toMatch(/^provisioning stopped at PIN secret: the PIN secret is not active and enabled after 30 reads \(last state 'inactive', enabled false\)/);
    expect(stuck.ledger.map((l) => l.type), 'recorded before the wait').toEqual(['vaultInstances', 'vaultProfiles', 'secrets']);
    expect(mutations(stuck.sent).some((s) => s.path === '/v1/tokens'), 'no token without an active PIN').toBe(false);
    expect(scriptRuns(stuck.docker)).toEqual([]);
});

function certainMarker(env: NodeJS.ProcessEnv): void {
    fs.mkdirSync(path.dirname(plantingMarkerFile(RUN, env)), { recursive: true });
    fs.writeFileSync(plantingMarkerFile(RUN, env), JSON.stringify({ labelPrefix: `${RUN}-`, attempts: [{ stamp: STAMP, labels: [`${RUN}-ko-rsa-${STAMP}`], certain: true }] }));
}
test('unplantRunKeys passes the run prefix through the environment, mounts the removal script, and reports the count', async ({}, testInfo) => {
    const env = provenLocalEnv(testInfo.outputPath('state'));
    certainMarker(env);
    const docker = fakeDocker({ unplantCount: '7' });
    expect(await unplantRunKeys(env, RUN, { docker: docker.runner })).toBe('removed 7 token object(s) of this run');
    const [run] = scriptRuns(docker.calls);
    expect(run.env).toEqual({ SOFTHSM2_CONF: '/etc/softhsm/softhsm2.conf', TOKEN_OWNER: '10001:10001', TOKEN_LABEL: 'softhsm', TOKEN_PIN: PIN, LABEL_PREFIX: `${RUN}-` });
    expect(run.args).toEqual([
        'run', '--rm', '--user', '0', '--volumes-from', SIDECAR, '--entrypoint', 'sh', '-v', `${UNPLANT_SCRIPT}:/unplant-keys.sh:ro`,
        '-e', 'SOFTHSM2_CONF', '-e', 'TOKEN_OWNER', '-e', 'TOKEN_LABEL', '-e', 'TOKEN_PIN', '-e', 'LABEL_PREFIX', SIDECAR_IMAGE, '/unplant-keys.sh',
    ]);
    expect(fs.existsSync(UNPLANT_SCRIPT)).toBe(true);
    for (const c of docker.calls) expect(c.args.join(' ')).not.toContain(PIN);
    expect(fs.existsSync(plantingMarkerFile(RUN, env)), 'the marker goes once the removal succeeded').toBe(false);

    certainMarker(env);
    const noCount = fakeDocker({ unplantCount: 'pkcs11-tool: no token' });
    await expect(unplantRunKeys(env, RUN, { docker: noCount.runner, deadlineAt: Date.now() + 1000, retryDelayMs: 2000 })).rejects.toThrow(/printed no count/);
});

test('without a planting marker the removal does not log in to the token at all', async ({}, testInfo) => {
    const env = provenLocalEnv(testInfo.outputPath('state'));
    const docker = fakeDocker();
    expect(await unplantRunKeys(env, RUN, { docker: docker.runner })).toBe('no token objects removed: the run planted nothing (no planting marker)');
    expect(docker.calls, 'not even a docker check').toEqual([]);
});

test('a failed removal names the prefix and a 0600 file with the command that finishes it by hand; never the PIN, a container or a runner path', async ({}, testInfo) => {
    const env = provenLocalEnv(testInfo.outputPath('state'));
    certainMarker(env);
    const docker = fakeDocker();
    const failing: DockerRunner = async (args, o) => (args.at(-1) === '/unplant-keys.sh' ? { code: 1, stdout: '', stderr: `still there ${PIN}` } : docker.runner(args, o));
    const error = await unplantRunKeys(env, RUN, { docker: failing, deadlineAt: Date.now() + 1000, retryDelayMs: 2000 }).then(() => undefined, (e: Error) => e);
    expect(error?.message).toMatch(new RegExp(`^the run planted key pairs labelled ${RUN}-… but they cannot be removed: unplant-keys\\.sh exited 1 .*; key pairs labelled ${RUN}-… may still be on the token; `
        + `the command that removes them by hand is in \\$REG_STATE_DIR/${RUN}\\.key-onboarding\\.removal\\.sh `));
    for (const hidden of [PIN, SIDECAR, UNPLANT_SCRIPT, 'softhsm']) expect(error?.message, hidden).not.toContain(hidden);
    const file = path.join(env.REG_STATE_DIR!, `${RUN}.key-onboarding.removal.sh`);
    expect((fs.statSync(file).mode & 0o777).toString(8)).toBe('600');
    const command = fs.readFileSync(file, 'utf8');
    expect(command).toContain(`docker run --rm --user 0 --volumes-from '${SIDECAR}' --entrypoint sh -v "$PWD/utils/keyOnboarding/unplant-keys.sh":/unplant-keys.sh:ro`);
    expect(command).toContain(`LABEL_PREFIX='${RUN}-'`);
    expect(command, 'the PIN is never in the file either').not.toContain(PIN);
});

test('unplantRunKeys never removes under an empty or shared prefix: without a marker it reports, with one it fails; no docker either way', async ({}, testInfo) => {
    const env = provenLocalEnv(testInfo.outputPath('state'));
    for (const id of ['', 'qa-reg-adhoc', 'qa-api-adhoc', 'someone-else', 'qa-reg-1', 'qa-reg-20261023', `${RUN}x`, `${RUN}-x`, 'qa-reg-20261023-1010-ab12']) {
        const docker = fakeDocker();
        expect(await unplantRunKeys(env, id, { docker: docker.runner }), `run id '${id}'`).toMatch(/^no token objects removed: .*\(nothing was planted under it\)$/);
        fs.writeFileSync(plantingMarkerFile(id, env), '{}');
        await expect(unplantRunKeys(env, id, { docker: docker.runner }), `run id '${id}' with a marker`).rejects.toThrow(/^refusing to remove token objects: the run's planting marker exists, but its run id cannot key a removal \(.*\); no manual command is offered: a person must check the token by hand$/);
        expect(fs.readdirSync(env.REG_STATE_DIR!).filter((f) => f.endsWith('.removal.sh')), `run id '${id}': no manual file`).toEqual([]);
        expect(plantingLeftover(env, id), `run id '${id}': the probe names the reason`).toMatch(/cannot key a removal .*no manual command is offered/);
        fs.rmSync(plantingMarkerFile(id, env));
        expect(docker.calls, `run id '${id}': no docker`).toEqual([]);
    }
    certainMarker(env);
    const noPin = fakeDocker();
    await expect(unplantRunKeys({ ...env, KO_TOKEN_PIN: '' }, RUN, { docker: noPin.runner })).rejects.toThrow(/cannot be removed: KO_TOKEN_PIN is not set; /);
    expect(noPin.calls).toEqual([]);
    const stopped = fakeDocker({ sidecarStopped: true });
    await expect(unplantRunKeys(env, RUN, { docker: stopped.runner, deadlineAt: Date.now() + 1000, retryDelayMs: 2000 })).rejects.toThrow(/cannot be removed: the SoftHSM sidecar container KO_SIDECAR_CONTAINER names is not running \(still so after 1 tries, the teardown's time budget is spent\)/);
    expect(scriptRuns(stopped.calls)).toEqual([]);
});

function gate(prefix: string): { status: number | null; stderr: string } {
    const empty = path.join(stateDir || path.join(__dirname, '..', '..', 'test-results'), 'empty-path');
    fs.mkdirSync(empty, { recursive: true });
    const r = spawnSync('/bin/sh', [UNPLANT_SCRIPT], { env: { PATH: empty, LABEL_PREFIX: prefix }, encoding: 'utf8', timeout: 10_000 });
    return { status: r.status, stderr: r.stderr };
}

test('unplant-keys.sh accepts exactly one generated run id and its hyphen as the prefix, before any tool runs', () => {
    for (const bad of ['', 'qa-reg-', 'qa-reg-20261023-', `${RUN}`, `${RUN}x-`, `${RUN}-x-`, 'qa-reg-20261023-101010-AB12-', 'qa-reg-2026102-101010-ab12-', 'qa-reg-20261023-101010-ab1-', 'qa-api-20261023-101010-ab12-', '*', 'qa-reg-*-']) {
        const r = gate(bad);
        expect(r.status, `prefix '${bad}' is refused`).toBe(2);
        expect(r.stderr).toContain('LABEL_PREFIX must be one generated run id followed by \'-\'');
    }
    // The run's prefix passes the gate and the script goes on to its first tool, which this PATH does not have.
    const ok = gate(`${RUN}-`);
    expect(ok.status, ok.stderr).toBe(127);
    expect(ok.stderr).toMatch(/apk/);
});

test('unplant-keys.sh selects exactly the run\'s private keys, public keys and certificates from a pkcs11-tool listing', ({}, testInfo) => {
    const src = fs.readFileSync(UNPLANT_SCRIPT, 'utf8');
    // The awk program exactly as the script runs it.
    const program = /\n  awk '\n([\s\S]*?)' "\$work\/objects" >"\$work\/run-objects"\n/.exec(src)?.[1];
    expect(program, 'the selection program is found in the script').toBeTruthy();
    const own = `${RUN}-`;
    const listing = [
        'Using slot 0 with a present token (0x1a2b3c4d)',
        'Private Key Object; RSA',
        `  label:      ${own}ko-rsa-ab12`,
        '  ID:         0123456789abcdef',
        '  Usage:      decrypt, sign, signRecover, unwrap',
        '  Access:     sensitive, always sensitive, never extractable, local',
        'Public Key Object; RSA 2048 bits',
        `  label:      ${own}ko-rsa-ab12`,
        '  ID:         0123456789abcdef',
        '  Usage:      encrypt, verify, verifyRecover, wrap',
        'Private Key Object; EC',
        `  label:      ${own}ko-shell-$(touch x)\`id\`;*"'|&-ab12`,
        'Public Key Object; EC  EC_POINT 256 bits',
        `  label:      ${own}ko-with\ttab-ab12`,
        'Certificate Object; type = X.509 cert',
        `  label:      ${own}ko-certified-ab12`,
        `  subject:    DN: CN=${own}ko-certified-ab12`,
        'Private Key Object; EC',
        `  label:      ${RUN}x-ko-neighbour`,
        'Private Key Object; EC',
        `  label:      ${RUN.slice(0, -1)}x-ko-neighbour`,
        'Public Key Object; EC  EC_POINT 256 bits',
        `  label:      old-${own}ko-ec`,
        'Secret Key Object; AES length 32',
        `  label:      ${own}ko-aes`,
        'Data object 1234',
        `  label:      '${own}ko-data'`,
        `  application: '${own}ko-data'`,
        'Private Key Object; EC',
        '  label:      keep-me',
        'Certificate Object; type = X.509 cert',
        `  subject:    DN: CN=${own}no-label`,
        '',
    ].join('\n');
    const file = testInfo.outputPath('objects.txt');
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(file, listing);
    const r = spawnSync('awk', [program!, file], { env: { PATH: process.env.PATH ?? '/usr/bin:/bin', LABEL_PREFIX: own }, encoding: 'utf8' });
    expect(r.status, r.stderr).toBe(0);
    expect(r.stdout.split('\n').filter(Boolean)).toEqual([
        `privkey\t${own}ko-rsa-ab12`,
        `pubkey\t${own}ko-rsa-ab12`,
        `privkey\t${own}ko-shell-$(touch x)\`id\`;*"'|&-ab12`,
        `pubkey\t${own}ko-with\ttab-ab12`,
        `cert\t${own}ko-certified-ab12`,
        `secrkey\t${own}ko-aes`,
        `data\t${own}ko-data`,
    ]);
    // A backslash or a pattern character in the prefix stays
    // literal (awk -v would have read the backslash as an escape).
    const odd = 'qa-reg-a.b\\n*-';
    fs.writeFileSync(file, `Private Key Object; EC\n  label:      ${odd}x\nPrivate Key Object; EC\n  label:      qa-reg-aXb\\n*-x\n`);
    const lit = spawnSync('awk', [program!, file], { env: { PATH: process.env.PATH ?? '/usr/bin:/bin', LABEL_PREFIX: odd }, encoding: 'utf8' });
    expect(lit.stdout).toBe(`privkey\t${odd}x\n`);
    expect(src, 'one pkcs11-tool login for every call, with the PIN read from the environment').toContain('--login --pin env:TOKEN_PIN "$@"');
    expect(src, 'the second listing decides').toMatch(/after=\$\(run_objects\)\nif \[ "\$after" -ne 0 \]/);
});

test('plant-keys.sh reads the PIN from the environment, never puts it on the pkcs11-tool command line', () => {
    const src = fs.readFileSync(PLANT_SCRIPT, 'utf8');
    expect(src, 'pkcs11-tool login reads TOKEN_PIN from the environment').toContain('--login --pin env:TOKEN_PIN "$@"');
    expect(src, 'no expanded TOKEN_PIN on the command line').not.toMatch(/--pin\s+"\$TOKEN_PIN"/);
});




const NS = 'ilm';
const DEPLOYMENT = 'pkcs11-cryptography-provider';
const POD = `${DEPLOYMENT}-7d9f8c6b5-x2k4p`;
const CONTAINER = 'proxy-softhsm';
const CONTEXT = 'develop-01';
const CLUSTER_PKCS11_URL = `http://${DEPLOYMENT}.${NS}.svc.cluster.local:8080`;
const clusterConnectors = (): Json[] => defaultConnectors().map((c) => (c.url === PKCS11_URL ? { ...c, url: CLUSTER_PKCS11_URL } : c));

const pod = (name: string, over: { owner?: string; phase?: string; ready?: boolean; container?: string; deleting?: boolean; native?: boolean } = {}): Json => {
    const sidecar = { name: over.container ?? CONTAINER, ready: over.ready ?? true, state: { running: {} } };
    return {
        metadata: { name, ownerReferences: [{ kind: 'ReplicaSet', name: over.owner ?? name.replace(/-[a-z0-9]+$/, '') }], ...(over.deleting ? { deletionTimestamp: '2026-11-02T10:00:00Z' } : {}) },
        status: {
            phase: over.phase ?? 'Running',
            containerStatuses: [{ name: 'connector', ready: true, state: { running: {} } }, ...(over.native ? [] : [sidecar])],
            ...(over.native ? { initContainerStatuses: [sidecar] } : {}),
        },
    };
};

interface KubectlOptions {
    noClient?: boolean;
    canI?: Record<string, 'yes' | 'no'>;
    pods?: Json[];
    execAnswer?: { code: number; stdout: string; stderr: string };
    procDir?: string;
}

interface KubectlCall {
    args: string[];
    stdin?: string;
    env?: Record<string, string>;
    timeoutMs?: number;
}

function subcommand(args: string[]): string[] {
    const rest = [...args];
    while (rest[0]?.startsWith('--')) rest.splice(0, rest[0] === '--context' ? 2 : 1);
    return rest;
}

function fakePkcs11Tool(bin: string): void {
    fs.mkdirSync(bin, { recursive: true });
    fs.writeFileSync(path.join(bin, 'pkcs11-tool'), [
        '#!/bin/sh',
        'echo "Using slot 0 with a present token (0x1)"',
        'case " $* " in *" --login --pin env:TOKEN_PIN "*) ;; *) echo "fake pkcs11-tool: no --pin env:TOKEN_PIN" >&2; exit 3 ;; esac',
        '[ -n "${TOKEN_PIN:-}" ] || { echo "fake pkcs11-tool: TOKEN_PIN is empty" >&2; exit 4; }',
        '[ "$TOKEN_PIN" = "$FAKE_EXPECTED_PIN" ] || { echo "fake pkcs11-tool: wrong PIN" >&2; exit 5; }',
        'op=""; type=""; label=""',
        'while [ $# -gt 0 ]; do case "$1" in',
        '  --keypairgen) op=gen ;; --delete-object) op=del ;; --list-objects) op=list ;; --read-object) op=read ;;',
        '  --type) type="$2"; shift ;; --label) label="$2"; shift ;;',
        'esac; shift; done',
        'tab=$(printf "\\t")',
        'case "$op" in',
        '  gen) printf "privkey\\t%s\\npubkey\\t%s\\n" "$label" "$label" >>"$FAKE_TOKEN"; echo "Key pair generated:" ;;',
        '  del) grep -v -x -F "$type$tab$label" "$FAKE_TOKEN" >"$FAKE_TOKEN.next" || true; mv "$FAKE_TOKEN.next" "$FAKE_TOKEN" ;;',
        '  read) grep -q -x -F "$type$tab$label" "$FAKE_TOKEN" && cat "$FAKE_PUBKEY_DER" ;;',
        '  list) while IFS="$tab" read -r t l; do',
        '      case "$t" in privkey) echo "Private Key Object; EC" ;; pubkey) echo "Public Key Object; EC  EC_POINT 256 bits" ;; cert) echo "Certificate Object; type = X.509 cert" ;;',
        '        secrkey) echo "Secret Key Object; AES length 32" ;; data) echo "Data object 4711" ;; esac',
        '      if [ "$t" = data ]; then echo "  label:      \'$l\'"; else echo "  label:      $l"; fi; done <"$FAKE_TOKEN" ;;',
        'esac',
    ].join('\n'), { mode: 0o755 });
}

function fakeKubectl(dir: string, opts: KubectlOptions = {}) {
    const calls: KubectlCall[] = [];
    const bin = path.join(dir, 'bin');
    const token = path.join(dir, 'token.txt');
    fakePkcs11Tool(bin);
    if (!fs.existsSync(token)) fs.writeFileSync(token, '');
    const pubkey = path.join(dir, 'pubkey.der');
    if (!fs.existsSync(pubkey)) fs.writeFileSync(pubkey, generateKeyPairSync('ec', { namedCurve: 'P-256' }).publicKey.export({ type: 'spki', format: 'der' }));
    const ok = (stdout: string) => ({ code: 0, stdout, stderr: '' });
    const runner: KubectlRunner = async (args, o = {}) => {
        calls.push({ args: [...args], ...(o.stdin !== undefined ? { stdin: o.stdin } : {}), ...(o.env ? { env: o.env } : {}), ...(o.timeoutMs ? { timeoutMs: o.timeoutMs } : {}) });
        const sub = subcommand(args);
        if (sub[0] === 'version') return opts.noClient ? { code: 127, stdout: '', stderr: 'kubectl: not found' } : ok('Client Version: v1.34.1\n');
        if (sub[0] === 'auth') {
            // As kubectl does: `pods/exec` is pods named "exec", only --subresource names a subresource.
            if (sub[3].includes('/')) return { code: 1, stdout: 'no\n', stderr: '' };
            const subresource = sub.find((a) => a.startsWith('--subresource='))?.slice('--subresource='.length);
            const answer = opts.canI?.[`${sub[2]} ${sub[3]}${subresource ? `/${subresource}` : ''}`] ?? 'yes';
            return { code: answer === 'yes' ? 0 : 1, stdout: `${answer}\n`, stderr: '' };
        }
        if (sub[0] === 'get') return ok(JSON.stringify({ items: opts.pods ?? [pod(POD)] }));
        if (sub[0] === 'exec') {
            if (opts.execAnswer) return opts.execAnswer;
            const r = spawnSync('/bin/sh', ['-s'], {
                input: o.stdin ?? '', encoding: 'utf8', timeout: 20_000,
                env: { PATH: `${bin}:/usr/bin:/bin`, FAKE_TOKEN: token, FAKE_PUBKEY_DER: pubkey, FAKE_EXPECTED_PIN: PIN, ...(opts.procDir ? { KO_PROC_DIR: opts.procDir } : { KO_PROC_DIR: path.join(dir, 'no-proc') }) },
            });
            return { code: r.status ?? 1, stdout: r.stdout, stderr: r.stderr };
        }
        return { code: 2, stdout: '', stderr: `unexpected kubectl ${args.join(' ')}` };
    };
    const tokenObjects = () => fs.readFileSync(token, 'utf8').split('\n').filter(Boolean);
    return { runner, calls, token, bin, tokenObjects };
}

const sharedEnv = (dir: string, extra: NodeJS.ProcessEnv = {}): NodeJS.ProcessEnv => ({
    TIER_KIND: 'shared', BASE_URL: 'https://tier.example', REG_STATE_DIR: dir, REG_RUN_ID: runId(), KO_TOKEN_PIN: PIN,
    KO_KUBE_CONTEXT: CONTEXT, KO_PKCS11_CONNECTOR_URL: CLUSTER_PKCS11_URL, ...extra,
});

async function logged<T>(fn: () => Promise<T>): Promise<{ value: T; log: string }> {
    const lines: string[] = [];
    const saved = { warn: console.warn, log: console.log, error: console.error };
    const keep = (...a: unknown[]) => { lines.push(a.map(String).join(' ')); };
    console.warn = keep;
    console.log = keep;
    console.error = keep;
    try {
        const value = await fn();
        return { value, log: lines.join('\n') };
    } finally {
        Object.assign(console, saved);
    }
}

const markerOf = (env: NodeJS.ProcessEnv) => plantingMarkerFile(RUN, env);
function fakeProc(dir: string, planting: boolean): string {
    fs.rmSync(dir, { recursive: true, force: true });
    fs.mkdirSync(path.join(dir, 'self'), { recursive: true });
    fs.mkdirSync(path.join(dir, '4242'), { recursive: true });
    fs.writeFileSync(path.join(dir, '4242', 'environ'), `PATH=/usr/bin\0${planting ? `KO_PLANTING=${RUN}-${STAMP}\0` : 'HOME=/\0'}`);
    return dir;
}
const certainAttempt = { stamp: STAMP, labels: [`${RUN}-ko-rsa-${STAMP}`], certain: true };
const writeMarkerFile = (env: NodeJS.ProcessEnv, marker: Json = { labelPrefix: `${RUN}-`, attempts: [certainAttempt] }) => {
    fs.mkdirSync(path.dirname(markerOf(env)), { recursive: true });
    fs.writeFileSync(markerOf(env), JSON.stringify(marker));
};

test('clusterPin: a named context, else a pod with its service-account token and CA and the API address, else no cluster at all', ({}, testInfo) => {
    const sa = testInfo.outputPath('sa');
    fs.mkdirSync(sa, { recursive: true });
    const pod_ = { KUBERNETES_SERVICE_HOST: '10.43.0.1', KUBERNETES_SERVICE_PORT: '443' };
    expect(clusterPin({ KO_KUBE_CONTEXT: CONTEXT }, sa)).toEqual({ inCluster: false, context: CONTEXT });
    expect(clusterPin(pod_, sa), 'a pod without its token').toHaveProperty('reason');
    fs.writeFileSync(path.join(sa, 'token'), 'x');
    expect(clusterPin(pod_, sa), 'a pod without its CA').toHaveProperty('reason');
    fs.writeFileSync(path.join(sa, 'ca.crt'), 'x');
    expect(clusterPin(pod_, sa)).toEqual({ inCluster: true, server: 'https://10.43.0.1:443', caFile: path.join(sa, 'ca.crt'), tokenFile: path.join(sa, 'token') });
    expect(clusterPin({ KUBERNETES_SERVICE_HOST: 'fd00::1', KUBERNETES_SERVICE_PORT: '443' }, sa)).toMatchObject({ server: 'https://[fd00::1]:443' });
    expect(clusterPin({ KUBERNETES_SERVICE_HOST: '10.43.0.1' }, sa), 'no API port').toHaveProperty('reason');
    expect(clusterPin({}, sa), 'the files alone are no pod').toHaveProperty('reason');
    expect(clusterPin({ KO_KUBE_CONTEXT: '  ' }, sa), 'a blank context names none').toHaveProperty('reason');
    expect(clusterPin({ ...pod_, KO_KUBE_SA_TOKEN_FILE: path.join(sa, 'token') }), 'the real mount is checked').toHaveProperty('reason');
});

test('pinnedKubectl: --context on every call, --request-timeout on API calls, a kill timer on exec, KUBERNETES_MASTER emptied; a pod gets a kubeconfig of exactly its cluster', async ({}, testInfo) => {
    const k = fakeKubectl(testInfo.outputPath('k'));
    const byContext = pinnedKubectl(k.runner, { inCluster: false, context: CONTEXT }, { KO_KUBE_EXEC_TIMEOUT_MS: '5000' });
    await byContext(['get', 'pods', '-n', NS, '-o', 'json']);
    await byContext(['exec', '-i', '-n', NS, POD, '-c', CONTAINER, '--', 'sh', '-s'], { stdin: 'true' });
    expect(k.calls[0]).toEqual({ args: ['--context', CONTEXT, '--request-timeout=30s', 'get', 'pods', '-n', NS, '-o', 'json'], env: { KUBERNETES_MASTER: '' } });
    expect(k.calls[1]).toMatchObject({ args: ['--context', CONTEXT, 'exec', '-i', '-n', NS, POD, '-c', CONTAINER, '--', 'sh', '-s'], timeoutMs: 5000, env: { KUBERNETES_MASTER: '' } });
    const pin = { inCluster: true as const, server: 'https://10.43.0.1:443', caFile: '/var/run/secrets/kubernetes.io/serviceaccount/ca.crt', tokenFile: '/var/run/secrets/kubernetes.io/serviceaccount/token' };
    const inPod = pinnedKubectl(k.runner, pin, {});
    await inPod(['auth', 'can-i', 'get', 'pods', '-n', NS]);
    expect(k.calls[2].args).toEqual(['--request-timeout=30s', 'auth', 'can-i', 'get', 'pods', '-n', NS]);
    expect(await canIAnswer(k.runner, 'create', 'pods/exec', NS)).toBe('yes');
    expect(k.calls.at(-1)!.args).toEqual(['auth', 'can-i', 'create', 'pods', '--subresource=exec', '-n', NS]);
    expect(k.calls[2].env?.KUBERNETES_MASTER).toBe('');
    const config = fs.readFileSync(k.calls[2].env!.KUBECONFIG, 'utf8');
    expect(config).toContain('server: "https://10.43.0.1:443"');
    expect(config).toContain(`certificate-authority: "${pin.caFile}"`);
    expect(config).toContain(`tokenFile: "${pin.tokenFile}"`);
    expect(config).toContain('current-context: in-cluster');
    expect(config.match(/- name:/g), 'one cluster, one user, one context').toHaveLength(3);
    expect((fs.statSync(k.calls[2].env!.KUBECONFIG).mode & 0o777).toString(8)).toBe('600');
});

test('spawnTool: the kill timer stops a hanging command with exit 124', async () => {
    const r = await spawnTool('/bin/sh', ['-c', 'sleep 5'], { timeoutMs: 200 }, { PATH: '/usr/bin:/bin' });
    expect(r.code).toBe(KILLED_EXIT);
    expect(r.stderr).toContain('killed after 200 ms');
    expect((await spawnTool('/bin/sh', ['-c', 'cat'], { stdin: 'in' }, { PATH: '/usr/bin:/bin' })).stdout).toBe('in');
    expect((await spawnTool('/bin/sh', ['-c', 'printf %s "$KUBERNETES_MASTER"'], { env: { KUBERNETES_MASTER: '' } }, { PATH: '/usr/bin:/bin', KUBERNETES_MASTER: 'http://elsewhere' })).stdout, 'the pin empties it').toBe('');
});

test('connectorTargetProblem: the connector core reports must be the Service of the Deployment in KO_KUBE_NAMESPACE', () => {
    const target = keyOnboardingConfig(sharedEnv('/tmp/x')).kube;
    for (const ok of [CLUSTER_PKCS11_URL, `http://${DEPLOYMENT}.${NS}.svc:8080`, `http://${DEPLOYMENT}.${NS}:8080`]) expect(connectorTargetProblem(ok, target), ok).toBeUndefined();
    for (const bad of [`http://${DEPLOYMENT}:8080`, `http://${DEPLOYMENT}.other.svc.cluster.local:8080`, `http://other.${NS}.svc.cluster.local:8080`,
        `http://${DEPLOYMENT}.${NS}.example.com:8080`, 'http://localhost:8290', 'not a url']) {
        expect(connectorTargetProblem(bad, target), bad).toMatch(/KO_PKCS11_CONNECTOR_URL/);
    }
});

test('offlineBlocker: a run that could not remove its pairs plants none (a refused run id, API_DELETE_OWN off, a dry run), before any request', async ({}, testInfo) => {
    const cfgOf = (env: NodeJS.ProcessEnv) => keyOnboardingConfig(env);
    const env = sharedEnv('/tmp/x');
    expect(offlineBlocker(cfgOf(env), env, RUN)).toBeUndefined();
    expect(offlineBlocker(cfgOf(env), env, 'qa-reg-adhoc')).toMatch(/^the run could not remove the key pairs it plants: the run id is an adhoc default/);
    expect(offlineBlocker(cfgOf(env), env, 'qa-reg-20261102-my-run')).toMatch(/^the run could not remove the key pairs it plants: the run id 'qa-reg-20261102-my-run' is not a generated run id/);
    expect(offlineBlocker(cfgOf(env), { ...env, API_DELETE_OWN: '0' }, RUN)).toBe('the run could not remove the key pairs it plants: API_DELETE_OWN is off (a hand-set REG_RUN_ID turns it off unless API_DELETE_OWN=1)');
    expect(offlineBlocker(cfgOf(env), { ...env, API_TEARDOWN_DRY_RUN: '1' }, RUN)).toBe('the run could not remove the key pairs it plants: API_TEARDOWN_DRY_RUN is on');
    for (const extra of [{ API_DELETE_OWN: '0' }, { API_TEARDOWN_DRY_RUN: '1' }]) {
        const kubectl = fakeKubectl(testInfo.outputPath(`k-${Object.keys(extra)[0]}`));
        const run = await runSetup(testInfo, { connectors: clusterConnectors() }, {}, (d) => sharedEnv(d, extra), kubectl.runner);
        expect(reasonOf(run.summary)).toMatch(/^the run could not remove the key pairs it plants/);
        expect(run.sent, 'not one platform request').toEqual([]);
        expect(kubectl.calls, 'not one kubectl call').toEqual([]);
    }
});

test('a shared tier: no pinned cluster, a connector of another Deployment, no client, no rights, no pod and two pods are unavailable before any platform request', async ({}, testInfo) => {
    const exec = 'the runner may not exec into pods in the namespace KO_KUBE_NAMESPACE names (kubectl auth can-i create / get pods/exec: no)';
    const pods = 'the runner may not get and list pods in the namespace KO_KUBE_NAMESPACE names';
    const cases: Array<[string, KubectlOptions, NodeJS.ProcessEnv, string | RegExp]> = [
        ['no pin', {}, { KO_KUBE_CONTEXT: '' }, /^no cluster is pinned/],
        ['other deployment', {}, { KO_PKCS11_CONNECTOR_URL: `http://other.${NS}.svc.cluster.local:8080` }, /^the connector KO_PKCS11_CONNECTOR_URL names is not the Service of the Deployment/],
        ['no client', { noClient: true }, {}, 'kubectl is not available on the runner (planting key pairs on a shared tier execs into the SoftHSM sidecar)'],
        ['no get', { canI: { 'get pods': 'no' } }, {}, pods],
        ['no list', { canI: { 'list pods': 'no' } }, {}, pods],
        ['no exec', { canI: { 'create pods/exec': 'no' } }, {}, exec],
        ['no websocket exec', { canI: { 'get pods/exec': 'no' } }, {}, exec],
        ['no pod', { pods: [] }, {}, 'no running pod of the Deployment KO_KUBE_DEPLOYMENT names has a ready KO_KUBE_CONTAINER sidecar'],
        ['two pods', { pods: [pod(POD), pod(`${DEPLOYMENT}-7d9f8c6b5-q9w8e`)] }, {}, '2 running pods of the Deployment KO_KUBE_DEPLOYMENT names: the SoftHSM token is per pod, so the planted keys could be on another pod than the one core lists'],
    ];
    for (const [what, opts, extra, reason] of cases) {
        const kubectl = fakeKubectl(testInfo.outputPath(`k-${what.replace(/\s/g, '-')}`), opts);
        const run = await runSetup(testInfo, { connectors: clusterConnectors() }, {}, (d) => sharedEnv(d, extra), kubectl.runner);
        if (typeof reason === 'string') expect(reasonOf(run.summary), what).toBe(reason);
        else expect(reasonOf(run.summary), what).toMatch(reason);
        expect(run.sent, `${what}: no platform request`).toEqual([]);
        expect(run.docker, `${what}: no docker`).toEqual([]);
        expect(kubectl.calls.filter((c) => subcommand(c.args)[0] === 'exec'), `${what}: no exec`).toEqual([]);
        expect(JSON.stringify(run.summary), `${what}: no namespace or pod name in the reason`).not.toMatch(new RegExp(`\\b${NS}\\b|${POD}`));
        for (const c of kubectl.calls) expect(c.args.slice(0, 2), `${what}: every call names the context`).toEqual(['--context', CONTEXT]);
        expect(fs.existsSync(markerOf(run.env)), `${what}: no marker`).toBe(false);
    }
    expect(readLedger(ledgerPath()), 'nothing was created').toEqual([]);
});

test('sidecarPods: only running, ready sidecars of a ReplicaSet of the Deployment (a native sidecar too), not a deleting pod or a look-alike', () => {
    const target = keyOnboardingConfig(sharedEnv('/tmp/x')).kube;
    expect(target).toEqual({ namespace: NS, deployment: DEPLOYMENT, container: CONTAINER, module: '/usr/lib/softhsm/libsofthsm2.so' });
    const native = `${DEPLOYMENT}-7d9f8c6b5-natv1`;
    const list = { items: [
        pod(POD),
        pod(native, { native: true }),
        pod(`${DEPLOYMENT}-7d9f8c6b5-pend1`, { phase: 'Pending' }),
        pod(`${DEPLOYMENT}-7d9f8c6b5-notrd`, { ready: false }),
        pod(`${DEPLOYMENT}-7d9f8c6b5-natnr`, { native: true, ready: false }),
        pod(`${DEPLOYMENT}-7d9f8c6b5-gone1`, { deleting: true }),
        pod(`${DEPLOYMENT}-v2-6c5b4-a1b2c`, { owner: `${DEPLOYMENT}-v2-6c5b4` }),
        pod('other-7d9f8c6b5-zz9yy'),
        pod(`${DEPLOYMENT}-7d9f8c6b5-nosdc`, { container: 'proxy-securosys' }),
        { metadata: { name: `${DEPLOYMENT}-bare` }, status: { phase: 'Running' } },
    ] };
    expect(sidecarPods(list, target)).toEqual([POD, native]);
});

test('scriptStdin exports every value as one quoted word before the script, and refuses a name that is no shell variable', () => {
    expect(shellQuote(`a'b c$(x)`)).toBe(`'a'\\''b c$(x)'`);
    expect(scriptStdin('echo hi\n', { A: 'x', B_2: `it's` })).toBe(`export A='x'\nexport B_2='it'\\''s'\necho hi\n`);
    expect(() => scriptStdin('', { 'A;rm': 'x' })).toThrow(/no shell variable name/);
    const odd = `p'q"r$(touch x)\`id\`\\n;*`;
    const r = spawnSync('/bin/sh', ['-s'], { input: scriptStdin('printf %s "$V"', { V: odd }), encoding: 'utf8', env: { PATH: '/usr/bin:/bin' } });
    expect(r.stdout).toBe(odd);
});

test('a shared tier: the setup plants through kubectl exec into the one sidecar, the PIN only on stdin, the marker right before the exec', async ({}, testInfo) => {
    const kubectl = fakeKubectl(testInfo.outputPath('k'));
    const run = await runSetup(testInfo, { connectors: clusterConnectors() }, {}, (d) => sharedEnv(d), kubectl.runner);
    const s = ready(run.summary);
    expect(run.docker, 'no docker on a shared tier').toEqual([]);
    expect(run.ledger.map((l) => l.type)).toEqual(['vaultInstances', 'vaultProfiles', 'secrets', 'tokens', 'tokenProfiles']);
    const certified = new X509Certificate(Buffer.from(s.provisioning.certifiedCertificate, 'base64'));
    expect(certified.subject, 'the runner certified the pair the exec planted').toBe(`CN=${s.provisioning.planted.certified}`);
    expect(certified.publicKey.export({ type: 'spki', format: 'der' }).equals(fs.readFileSync(testInfo.outputPath('k', 'pubkey.der'))),
        'the certificate carries the public key the token dumped (past the slot line)').toBe(true);

    const execs = kubectl.calls.filter((c) => subcommand(c.args)[0] === 'exec');
    expect(execs).toHaveLength(1);
    expect(execs[0].args).toEqual(['--context', CONTEXT, 'exec', '-i', '-n', NS, POD, '-c', CONTAINER, '--', 'sh', '-s']);
    expect(execs[0].timeoutMs, 'the exec has a kill timer').toBe(180_000);
    expect(execs[0].stdin!.endsWith(fs.readFileSync(PLANT_EXEC_SCRIPT, 'utf8')), 'the script follows its exports').toBe(true);
    expect(execs[0].stdin).toContain(`export TOKEN_PIN=${shellQuote(PIN)}\n`);
    expect(execs[0].stdin).toContain(`export PKCS11_MODULE='/usr/lib/softhsm/libsofthsm2.so'\n`);
    for (const c of kubectl.calls) expect(c.args.join(' '), `kubectl ${subcommand(c.args)[0]}: the PIN is never on the command line`).not.toContain(PIN);

    const planted = s.provisioning.planted;
    const labels = [planted.rsa, planted.ec, planted.noIdEc, ...planted.idSharingEc, planted.orphan, planted.removable, ...planted.bulkRemovable, planted.compromised, planted.certified];
    for (const l of labels) expect(l, l).toMatch(new RegExp(`^${RUN}-ko-[a-z0-9-]+-${STAMP}$`));
    expect(kubectl.tokenObjects()).toHaveLength(21);
    for (const l of labels) expect(kubectl.tokenObjects(), l).toContain(`privkey\t${l}`);
    expect(kubectl.tokenObjects()).not.toContain(`pubkey\t${planted.orphan}`);
    expect(JSON.parse(fs.readFileSync(markerOf(run.env), 'utf8')), 'certain once the script reported PLANTED').toMatchObject({
        attempts: [{ stamp: STAMP, labels, certain: true }],
    });
    expect(fs.readFileSync(ledgerPath(), 'utf8'), 'the ledger never holds the PIN').not.toContain(PIN);
    expect(JSON.stringify(s), 'the summary never holds the PIN').not.toContain(PIN);
});

test('planting: the marker is written only once the pod is found, right before the exec; a refused run id touches nothing', async ({}, testInfo) => {
    const env = sharedEnv(testInfo.outputPath('state'));
    const noPod = fakeKubectl(testInfo.outputPath('k1'), { pods: [] });
    await expect(plantKeys({ cfg: keyOnboardingConfig(env), env, runners: { kubectl: noPod.runner }, pin: PIN, stamp: STAMP, runId: RUN })).rejects.toThrow(TierError);
    expect(fs.existsSync(markerOf(env)), 'no pod: nothing delivered, no marker').toBe(false);
    const kubectl = fakeKubectl(testInfo.outputPath('k2'));
    for (const id of ['qa-reg-adhoc', 'qa-reg-20261023', 'qa-reg-my-run', '']) {
        const attempt = plantKeys({ cfg: keyOnboardingConfig(env), env, runners: { kubectl: kubectl.runner }, pin: PIN, stamp: STAMP, runId: id });
        await expect(attempt, `run id '${id}'`).rejects.toThrow(/^refusing to plant key pairs: .*\(the teardown would refuse to remove them\)$/);
    }
    expect(kubectl.calls, 'kubectl was never asked').toEqual([]);
});

test('a shared tier: a failing, killed or unfinished exec is unavailable at the planting step, the PIN scrubbed before the cut; the marker stays', async ({}, testInfo) => {
    // The PIN straddles the cut: scrubbing after slicing would leave part of it in the log.
    const long = `${'x'.repeat(1498)}${PIN}`;
    const failing = fakeKubectl(testInfo.outputPath('k1'), { execAnswer: { code: 1, stdout: `PIN was ${PIN}`, stderr: `${PIN} pkcs11-tool: login failed with ${PIN}\n${long}` } });
    const { value: run, log } = await logged(() => runSetup(testInfo, { connectors: clusterConnectors() }, {}, (d) => sharedEnv(d), failing.runner));
    expect(reasonOf(run.summary)).toMatch(/^provisioning stopped at planting: plant-keys\.exec\.sh exited 1 \(its output is in the setup log\)/);
    expect(log).toContain('<secret>');
    expect(log, 'the log never holds the PIN').not.toContain(PIN);
    expect(log, 'nor a piece of it').not.toContain(PIN.slice(0, 8));
    expect(run.ledger).toHaveLength(5);
    expect(JSON.parse(fs.readFileSync(markerOf(run.env), 'utf8')).attempts, 'a failed plant: the marker stays uncertain').toMatchObject([{ stamp: STAMP, certain: false }]);

    const killed = fakeKubectl(testInfo.outputPath('k2'), { execAnswer: { code: KILLED_EXIT, stdout: '', stderr: 'killed after 180000 ms' } });
    const killedRun = await runSetup(testInfo, { connectors: clusterConnectors() }, {}, (d) => sharedEnv(d), killed.runner);
    expect(reasonOf(killedRun.summary)).toMatch(/planting: plant-keys\.exec\.sh exited 124/);
    expect(JSON.parse(fs.readFileSync(markerOf(killedRun.env), 'utf8')).attempts, 'a killed plant stays uncertain').toMatchObject([{ certain: false }]);
    const unfinished = fakeKubectl(testInfo.outputPath('k3'), { execAnswer: { code: 0, stdout: `Using slot 0 ${PIN}\n`, stderr: '' } });
    const silent = await logged(() => runSetup(testInfo, { connectors: clusterConnectors() }, {}, (d) => sharedEnv(d), unfinished.runner));
    expect(reasonOf(silent.value.summary)).toMatch(/planting: plant-keys\.exec\.sh did not report that it planted every pair/);
    expect(silent.log).not.toContain(PIN);
});

test('the transport scrubs the PIN from an echoed failure answer before it logs it', async ({}, testInfo) => {
    const kubectl = fakeKubectl(testInfo.outputPath('k'));
    const { value: run, log } = await logged(() => runSetup(testInfo, { connectors: clusterConnectors(), statusFor: { 'POST /v1/vaults/{id}/vaultProfiles/{id}/secrets': 500 }, echoBody: true },
        {}, (d) => sharedEnv(d), kubectl.runner));
    expect(reasonOf(run.summary)).toMatch(/^provisioning stopped at PIN secret/);
    expect(log, 'the echoed body was logged, the PIN replaced').toMatch(/content\\?":\\?"<secret>/);
    expect(log).not.toContain(PIN);
});

test('a shared tier: unplantRunKeys removes exactly this run\'s objects through kubectl exec, leaves every other object, and drops the marker', async ({}, testInfo) => {
    stateDir = testInfo.outputPath('state');
    const dir = testInfo.outputPath('k');
    fs.mkdirSync(dir, { recursive: true });
    const own = `${RUN}-`;
    fs.writeFileSync(path.join(dir, 'token.txt'), [
        `privkey\t${own}ko-rsa-ab12`, `pubkey\t${own}ko-rsa-ab12`, `privkey\t${own}ko-orphan-ab12`, `cert\t${own}ko-certified-ab12`,
        `privkey\t${RUN}x-ko-neighbour`, `pubkey\told-${own}ko-ec`, 'privkey\tkeep-me', `privkey\t${own}ko-shell-$(touch x);*"'|&`, `pubkey\t${own}ko-with\ttab`, '',
    ].join('\n'));
    const kubectl = fakeKubectl(dir);
    const env = sharedEnv(stateDir);
    writeMarkerFile(env);
    expect(await unplantRunKeys(env, RUN, { kubectl: kubectl.runner })).toBe('removed 6 token object(s) of this run');
    expect(kubectl.tokenObjects()).toEqual([`privkey\t${RUN}x-ko-neighbour`, `pubkey\told-${own}ko-ec`, 'privkey\tkeep-me']);
    expect(fs.existsSync(markerOf(env)), 'the marker goes once the removal succeeded').toBe(false);
    const [exec] = kubectl.calls.filter((c) => subcommand(c.args)[0] === 'exec');
    expect(exec.stdin).toContain(`export LABEL_PREFIX='${own}'\n`);
    expect(exec.stdin!.endsWith(fs.readFileSync(UNPLANT_EXEC_SCRIPT, 'utf8'))).toBe(true);
    for (const c of kubectl.calls) expect(c.args.join(' ')).not.toContain(PIN);
    const execsBefore = kubectl.calls.length;
    expect(await unplantRunKeys(env, RUN, { kubectl: kubectl.runner }), 'no marker left: nothing to remove').toBe('no token objects removed: the run planted nothing (no planting marker)');
    expect(kubectl.calls.length, 'and no login to the token').toBe(execsBefore);
});

test('a shared tier: with the marker a permanent block fails at once, transient ones (no pod, can-i without an answer, a pod that rolled) are retried until the deadline', async ({}, testInfo) => {
    stateDir = testInfo.outputPath('state');
    const env = sharedEnv(stateDir);
    fs.mkdirSync(stateDir, { recursive: true });
    const execChecks = (k: ReturnType<typeof fakeKubectl>) => k.calls.filter((c) => subcommand(c.args)[0] === 'auth' && c.args.includes('create') && c.args.includes('--subresource=exec')).length;
    writeMarkerFile(env);
    const noExec = fakeKubectl(testInfo.outputPath('k1'), { canI: { 'create pods/exec': 'no' } });
    const error = await unplantRunKeys(env, RUN, { kubectl: noExec.runner, retryDelayMs: 0 }).then(() => undefined, (e: Error) => e);
    expect(error?.message).toMatch(new RegExp(`^the run planted key pairs labelled ${RUN}-… but they cannot be removed: the runner may not create pods/exec .*; key pairs labelled ${RUN}-… may still be on the token; the command that removes them by hand is in `));
    expect(execChecks(noExec), 'a definite no: checked once').toBe(1);
    expect(error?.message, 'no PIN, no context, no namespace, no runner path').not.toMatch(new RegExp(`${PIN}|${CONTEXT}|\\b${NS}\\b|${path.resolve(__dirname, '..', '..')}`));

    let t = 0;
    const clock = () => (t += 1_000);
    const noPod = fakeKubectl(testInfo.outputPath('k2'), { pods: [] });
    const { value: transient, log } = await logged(() => unplantRunKeys(env, RUN, { kubectl: noPod.runner, retryDelayMs: 0, deadlineAt: 60_000, now: clock }).then(() => undefined, (e: Error) => e));
    expect(transient?.message).toMatch(/cannot be removed: (no running pod .*\(still so after \d+ tries, the teardown's time budget is spent\)|the teardown's time budget is spent \(\d+ tries\))/);
    expect(log).toMatch(/trying again/);
    expect(fs.existsSync(markerOf(env)), 'the marker stays').toBe(true);

    let flaky = 0;
    const ok = fakeKubectl(testInfo.outputPath('k3'));
    const timeoutOnce: KubectlRunner = async (args, o) => (subcommand(args)[0] === 'auth' && ++flaky === 1 ? { code: 1, stdout: '', stderr: 'Unable to connect to the server: net/http: request canceled (Client.Timeout exceeded)' } : ok.runner(args, o));
    expect(await unplantRunKeys(env, RUN, { kubectl: timeoutOnce, retryDelayMs: 0 })).toBe('removed 0 token object(s) of this run');

    writeMarkerFile(env);
    let gets = 0;
    const rolling = fakeKubectl(testInfo.outputPath('k4'));
    const rolled: KubectlRunner = async (args, o) => (subcommand(args)[0] === 'get' && ++gets === 2 ? { code: 0, stdout: JSON.stringify({ items: [] }), stderr: '' } : rolling.runner(args, o));
    expect(await unplantRunKeys(env, RUN, { kubectl: rolled, retryDelayMs: 0 })).toBe('removed 0 token object(s) of this run');
    expect(gets, 'check, failed pass, check, pass').toBe(4);
    expect(fs.existsSync(markerOf(env))).toBe(false);
});

test('a shared tier: with an uncertain attempt the removal still runs, then the teardown is RED and names the manual file; the marker stays', async ({}, testInfo) => {
    stateDir = testInfo.outputPath('state');
    const env = sharedEnv(stateDir);
    const labels = [`${RUN}-ko-rsa-${STAMP}`, `${RUN}-ko-ec-${STAMP}`];
    writeMarkerFile(env, { labelPrefix: `${RUN}-`, attempts: [certainAttempt, { stamp: 'zz99', labels, certain: false }] });
    const k = fakeKubectl(testInfo.outputPath('k'));
    fs.writeFileSync(k.token, `privkey\t${labels[0]}\npubkey\t${labels[0]}\nprivkey\tkeep-me\n`);
    const error = await unplantRunKeys(env, RUN, { kubectl: k.runner, retryDelayMs: 0 }).then(() => undefined, (e: Error) => e);
    expect(error?.message).toBe(`planting did not finish cleanly (an attempt of the run never reported its end); removed 2 of this run's objects; ` +
        `a person must re-check the token later with $REG_STATE_DIR/${RUN}.key-onboarding.removal.sh (export TOKEN_PIN with the value of KO_TOKEN_PIN, then run it with sh from czertainly-e2e)`);
    expect(k.tokenObjects(), 'the removal ran').toEqual(['privkey\tkeep-me']);
    expect(fs.existsSync(markerOf(env)), 'the marker stays: a later teardown or a person re-checks').toBe(true);
    expect(fs.existsSync(path.join(stateDir, `${RUN}.key-onboarding.removal.sh`)), 'the manual file').toBe(true);
    await expect(unplantRunKeys(env, RUN, { kubectl: k.runner, retryDelayMs: 0 })).rejects.toThrow(/^planting did not finish cleanly .*removed 0 of this run's objects/);
});

test('readMarker: an unreadable, old-format, empty, label-less or not-certain marker counts as uncertain, and the teardown is RED for each', async ({}, testInfo) => {
    const shapes: Record<string, Json | string> = {
        unreadableJson: `{"labelPrefix":"${RUN}-","attempts":[{"stamp":"rg01","labels":["a"],"cer`,
        oldFormatKilled: { labelPrefix: `${RUN}-`, killed: true },
        attemptNoLabels: { labelPrefix: `${RUN}-`, attempts: [{ stamp: STAMP, certain: true }] },
        attemptsEmpty: { labelPrefix: `${RUN}-`, attempts: [] },
        attemptsNotArray: { labelPrefix: `${RUN}-`, attempts: 'x' },
        certainNotBoolean: { labelPrefix: `${RUN}-`, attempts: [{ stamp: STAMP, labels: ['a'], certain: 'true' }] },
        noStamp: { labelPrefix: `${RUN}-`, attempts: [{ labels: ['a'], certain: true }] },
        emptyObject: {},
        nullJson: 'null',
        emptyFile: '',
    };
    for (const [name, shape] of Object.entries(shapes)) {
        const env = sharedEnv(testInfo.outputPath(`state-${name}`));
        fs.mkdirSync(path.dirname(markerOf(env)), { recursive: true });
        fs.writeFileSync(markerOf(env), typeof shape === 'string' ? shape : JSON.stringify(shape));
        expect(readMarker(markerOf(env))!.attempts.some((a) => !a.certain), name).toBe(true);
        const k = fakeKubectl(testInfo.outputPath(`k-${name}`));
        fs.writeFileSync(k.token, `privkey\t${RUN}-ko-rsa-${STAMP}\n`);
        await expect(unplantRunKeys(env, RUN, { kubectl: k.runner, retryDelayMs: 0 }), name).rejects.toThrow(/^planting did not finish cleanly/);
        expect(fs.existsSync(markerOf(env)), `${name}: the marker stays`).toBe(true);
    }
    const env = sharedEnv(testInfo.outputPath('state-certain'));
    writeMarkerFile(env);
    expect(readMarker(markerOf(env))).toEqual({ attempts: [certainAttempt] });
    expect(await unplantRunKeys(env, RUN, { kubectl: fakeKubectl(testInfo.outputPath('k-certain')).runner, retryDelayMs: 0 })).toBe('removed 0 token object(s) of this run');
    expect(fs.existsSync(markerOf(env))).toBe(false);
    expect(fs.existsSync(path.join(env.REG_STATE_DIR!, `${RUN}.key-onboarding.removal.sh`)), 'no manual file after a green removal').toBe(false);
});

test('the marker is written atomically with mode 0600, also over an existing file', async ({}, testInfo) => {
    const env = sharedEnv(testInfo.outputPath('state'));
    fs.mkdirSync(env.REG_STATE_DIR!, { recursive: true });
    fs.writeFileSync(markerOf(env), 'junk', { mode: 0o644 });
    fs.chmodSync(markerOf(env), 0o644);
    await plantKeys({ cfg: keyOnboardingConfig(env), env, runners: { kubectl: fakeKubectl(testInfo.outputPath('k')).runner }, pin: PIN, stamp: STAMP, runId: RUN });
    expect((fs.statSync(markerOf(env)).mode & 0o777).toString(8)).toBe('600');
    expect(fs.readdirSync(env.REG_STATE_DIR!).filter((f) => f.includes('.tmp-')), 'no temp file left').toEqual([]);
    expect(readMarker(markerOf(env))!.attempts.map((a) => a.certain)).toEqual([false, true]);
});

test('the teardown budget: an exhausted budget fails with the manual file before any stage; the exec timeout is capped to what is left', async ({}, testInfo) => {
    stateDir = testInfo.outputPath('state');
    const env = sharedEnv(stateDir);
    writeMarkerFile(env);
    const k = fakeKubectl(testInfo.outputPath('k'));
    let t = 1_000;
    const spent = await unplantRunKeys(env, RUN, { kubectl: k.runner, deadlineAt: 1_000, now: () => t }).then(() => undefined, (e: Error) => e);
    expect(spent?.message).toMatch(/cannot be removed: the teardown's time budget is spent \(1 tries\); .* the command that removes them by hand is in \$REG_STATE_DIR\//);
    expect(k.calls, 'nothing was even checked').toEqual([]);
    t = 0;
    expect(await unplantRunKeys(env, RUN, { kubectl: k.runner, deadlineAt: 50_000, now: () => t })).toBe('removed 0 token object(s) of this run');
    expect(k.calls.find((c) => subcommand(c.args)[0] === 'exec')?.timeoutMs).toBe(50_000);
    writeMarkerFile(env);
    const seen: number[] = [];
    const watch: KubectlRunner = async (args, o) => { if (subcommand(args)[0] === 'exec') seen.push(o?.timeoutMs ?? -1); return k.runner(args, o); };
    const block = keyOnboardingBlock({ kubectl: watch, now: () => 0 }, 0);
    expect(await block.after!(env, RUN)).toBe('removed 0 token object(s) of this run');
    expect(seen, 'min(180 s, 600 s - 30 s)').toEqual([180_000]);
    const late = keyOnboardingBlock({ kubectl: k.runner, now: () => 580_000 }, 0);
    writeMarkerFile(env);
    await expect(late.after!(env, RUN)).rejects.toThrow(/the teardown's time budget is spent/);
});

test('a second plant of the same run adds its attempt and never drops the uncertainty of an earlier one', async ({}, testInfo) => {
    const env = sharedEnv(testInfo.outputPath('state'));
    const killed = fakeKubectl(testInfo.outputPath('k1'), { execAnswer: { code: KILLED_EXIT, stdout: '', stderr: 'killed' } });
    await expect(plantKeys({ cfg: keyOnboardingConfig(env), env, runners: { kubectl: killed.runner }, pin: PIN, stamp: 'aa11', runId: RUN })).rejects.toThrow(TierError);
    const ok = fakeKubectl(testInfo.outputPath('k2'));
    await plantKeys({ cfg: keyOnboardingConfig(env), env, runners: { kubectl: ok.runner }, pin: PIN, stamp: 'bb22', runId: RUN });
    const marker = JSON.parse(fs.readFileSync(markerOf(env), 'utf8'));
    expect(marker.attempts.map((a: Json) => [a.stamp, a.certain, a.labels.length])).toEqual([['aa11', false, 11], ['bb22', true, 11]]);
    expect(marker.attempts[0].labels[0]).toBe(`${RUN}-ko-rsa-aa11`);
});

test('a shared tier: a failed removal names a 0600 file whose paste-safe command finds the pod and rebuilds the PIN; run by a real sh it removes the pairs', async ({}, testInfo) => {
    stateDir = testInfo.outputPath('state');
    const env = sharedEnv(stateDir);
    writeMarkerFile(env);
    const failing = fakeKubectl(testInfo.outputPath('k1'), { execAnswer: { code: 1, stdout: '', stderr: `still there ${PIN}` } });
    const { value: error, log } = await logged(() => unplantRunKeys(env, RUN, { kubectl: failing.runner, deadlineAt: Date.now() + 1000, retryDelayMs: 2000 }).then(() => undefined, (e: Error) => e));
    expect(error?.message).toContain(`cannot be removed: unplant-keys.exec.sh exited 1 (the output is in the log)`);
    expect(error?.message).toContain(`the command that removes them by hand is in $REG_STATE_DIR/${RUN}.key-onboarding.removal.sh`);
    for (const hidden of [PIN, CONTEXT, path.resolve(__dirname, '..', '..'), 'softhsm', DEPLOYMENT]) expect(error?.message, hidden).not.toContain(hidden);
    expect(log).toContain('still there <secret>');
    expect(log).not.toContain(PIN);
    const file = path.join(stateDir, `${RUN}.key-onboarding.removal.sh`);
    expect((fs.statSync(file).mode & 0o777).toString(8)).toBe('600');
    const command = fs.readFileSync(file, 'utf8').split('\n').filter((l) => l && !l.startsWith('#')).join('\n');
    expect(command, 'no placeholder a shell would read as a redirection').not.toMatch(/<the one/);
    expect(command).toContain(`--context '${CONTEXT}' `);

    const work = testInfo.outputPath('paste');
    const bin = path.join(work, 'bin');
    fakePkcs11Tool(bin);
    const token = path.join(work, 'token.txt');
    fs.writeFileSync(token, `privkey\t${RUN}-ko-rsa-ab12\npubkey\t${RUN}-ko-rsa-ab12\nprivkey\tkeep-me\n`);
    fs.writeFileSync(path.join(bin, 'kubectl'), [
        '#!/bin/sh',
        '[ "$1" = --context ] && shift 2',
        `case "$1" in get) printf '${POD} <none>\\nother-1-x <none>\\n${DEPLOYMENT}-7d9f8c6b5-term1 2026-11-03T00:00:00Z\\n' ;; exec) exec /bin/sh -s ;; *) exit 9 ;; esac`,
    ].join('\n'), { mode: 0o755 });
    const odd = `it's a "pin" $x \\ ;`;
    const pasted = spawnSync('/bin/sh', [file], {
        cwd: path.resolve(__dirname, '..', '..'), encoding: 'utf8', timeout: 20_000,
        env: { PATH: `${bin}:/usr/bin:/bin`, TOKEN_PIN: odd, FAKE_TOKEN: token, FAKE_EXPECTED_PIN: odd, KO_PROC_DIR: path.join(work, 'no-proc') },
    });
    expect(pasted.status, pasted.stderr).toBe(0);
    expect(pasted.stdout.trim().split('\n').pop()).toBe('2');
    fs.writeFileSync(path.join(bin, 'kubectl'), ['#!/bin/sh', '[ "$1" = --context ] && shift 2', 'case "$1" in get) printf \'\' ;; exec) echo EXECUTED ;; esac'].join('\n'), { mode: 0o755 });
    const none = spawnSync('/bin/sh', [file], { cwd: path.resolve(__dirname, '..', '..'), encoding: 'utf8', env: { PATH: `${bin}:/usr/bin:/bin`, TOKEN_PIN: odd } });
    expect(none.status).not.toBe(0);
    expect(none.stdout).not.toContain('EXECUTED');
    expect(fs.readFileSync(token, 'utf8')).toBe('privkey\tkeep-me\n');
});

test('the block teardown: with the marker, a dry run, API_DELETE_OWN off or a kept object FAIL with the manual command; without it they stay green', async ({}, testInfo) => {
    stateDir = testInfo.outputPath('state');
    const env = sharedEnv(stateDir, { REG_RUN_ID: RUN, BASE_URL: undefined });
    fs.mkdirSync(stateDir, { recursive: true });
    const authenticate = async () => ({ api: { dispose: async () => undefined } as unknown as APIRequestContext, dispose: async () => undefined });
    const key: LedgerLine = { at: '2026-11-02T12:00:00.000Z', runId: RUN, type: 'keys', name: `${RUN}-ko-rsa`, uuid: U(6001), spec: 'key-onboarding/setup', event: 'created' };
    const keep = (): TeardownHandler => ({ action: 'keep', remove: async () => 'kept' });
    const k = fakeKubectl(testInfo.outputPath('k'));
    const block = keyOnboardingBlock({ kubectl: k.runner });
    const run = (extra: NodeJS.ProcessEnv, handler?: (t: string) => TeardownHandler) => withProcessEnv({ REG_STATE_DIR: stateDir, CLEANUP_LEDGER_FILE: path.join(stateDir, 'cleanup.jsonl') }, () =>
        teardownBlock(block, { env: { ...env, ...extra }, readLines: () => [key], authenticate, ...(handler ? { handler } : {}), retryDelayMs: 1 }));
    expect(await run({ API_TEARDOWN_DRY_RUN: '1' })).toEqual({ status: 'skipped', reason: 'API_TEARDOWN_DRY_RUN is on' });
    expect(await run({ API_DELETE_OWN: '0' })).toEqual({ status: 'skipped', reason: 'API_DELETE_OWN is off' });
    expect(await run({}, keep)).toMatchObject({ status: 'done', kept: 1, after: expect.stringMatching(/^skipped: 1 object\(s\) kept/) });
    writeMarkerFile(env);
    for (const [extra, handler, why] of [
        [{ API_TEARDOWN_DRY_RUN: '1' }, undefined, 'API_TEARDOWN_DRY_RUN is on'],
        [{ API_DELETE_OWN: '0' }, undefined, 'API_DELETE_OWN is off'],
        [{}, keep, `1 object(s) kept: keys ${key.uuid}`],
    ] as Array<[NodeJS.ProcessEnv, ((t: string) => TeardownHandler) | undefined, string]>) {
        const failed = await run(extra, handler).then(() => undefined, (e: Error) => e);
        expect(failed?.message, why).toContain(`The key-onboarding/ block's teardown did not remove what it made outside the platform (${why}): key pairs labelled ${RUN}-… may still be on the token; `);
        expect(failed?.message, why).toContain(`the command that removes them by hand is in $REG_STATE_DIR/${RUN}.key-onboarding.removal.sh`);
    }
    expect(k.calls.filter((c) => subcommand(c.args)[0] === 'exec'), 'nothing was removed under those switches').toEqual([]);
    expect(fs.existsSync(markerOf(env))).toBe(true);
    const signInFails = async () => { throw new Error('the token grant answered 503'); };
    const noSignIn = await withProcessEnv({ REG_STATE_DIR: stateDir, CLEANUP_LEDGER_FILE: path.join(stateDir, 'cleanup.jsonl') }, () =>
        teardownBlock(block, { env, readLines: () => [key], authenticate: signInFails, retryDelayMs: 1 })).then(() => undefined, (e: Error) => e);
    expect(noSignIn?.message).toMatch(new RegExp(`^the token grant answered 503; the key-onboarding/ block's teardown did not remove what it made outside the platform: key pairs labelled ${RUN}-… may still be on the token; `));
    const echoing = async () => { throw new Error(`grant refused for pin ${PIN} / '${PIN}'`); };
    const scrubbedError = await withProcessEnv({ REG_STATE_DIR: stateDir, CLEANUP_LEDGER_FILE: path.join(stateDir, 'cleanup.jsonl') }, () =>
        koTeardownBlock({ env, readLines: () => [key], authenticate: echoing, retryDelayMs: 1 }, block)).then(() => undefined, (e: Error) => e);
    expect(scrubbedError?.message).toContain('grant refused for pin <secret> / <secret>');
    expect(scrubbedError?.stack).not.toContain(PIN);
});

test('the global teardown runs the block teardown on a shared tier with no ledger line when the planting marker exists', async ({}, testInfo) => {
    const calls: string[] = [];
    const base = { DEV_BLOCK: 'key-onboarding', REG_RUN_ID: RUN, REG_STATE_DIR: testInfo.outputPath('state') };
    await devBlockGlobalTeardown(undefined, { env: base, teardown: async () => { calls.push('teardown'); }, liveLines: () => 0, leftover: () => false, removeProof: () => undefined });
    expect(calls, 'nothing in the ledger, nothing outside the platform').toEqual([]);
    await devBlockGlobalTeardown(undefined, { env: base, teardown: async () => { calls.push('teardown'); }, liveLines: () => 0, leftover: () => true, removeProof: () => undefined });
    expect(calls).toEqual(['teardown']);
    const env = sharedEnv(base.REG_STATE_DIR, { REG_RUN_ID: RUN });
    expect(plantingLeftover(env, RUN)).toBeUndefined();
    writeMarkerFile(env);
    calls.length = 0;
    await devBlockGlobalTeardown(undefined, { env: { ...env, DEV_BLOCK: 'key-onboarding' }, teardown: async () => { calls.push('teardown'); }, liveLines: () => 0, removeProof: () => undefined });
    expect(calls).toEqual(['teardown']);
});

test('a shared tier: the block teardown ends with the token step, which removes the run\'s pairs', async ({}, testInfo) => {
    stateDir = testInfo.outputPath('state');
    const dir = testInfo.outputPath('k');
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(path.join(dir, 'token.txt'), `privkey\t${RUN}-ko-rsa-ab12\npubkey\t${RUN}-ko-rsa-ab12\nprivkey\tkeep-me\n`);
    const kubectl = fakeKubectl(dir);
    const env = sharedEnv(stateDir, { REG_RUN_ID: RUN, BASE_URL: undefined });
    writeMarkerFile(env);
    let n = 0;
    const own = (type: string, parents?: LedgerLine['parents']): LedgerLine => ({ at: '2026-11-02T12:00:00.000Z', runId: RUN, type, name: `${RUN}-${type}`, uuid: U(5000 + ++n), spec: 'key-onboarding/setup', event: 'created', ...(parents ? { parents } : {}) });
    const key = own('keys');
    const lines = [own('vaultInstances'), own('tokens'), key, own('keyItems', { key: key.uuid }), own('customAttributes')];
    const removed: string[] = [];
    const handler = (type: string): TeardownHandler => ({ action: `remove ${type}`, remove: async (_ctx, l) => { removed.push(l.type); } });
    const authenticate = async () => ({ api: { dispose: async () => undefined } as unknown as APIRequestContext, dispose: async () => undefined });
    const outcome = await withProcessEnv({ REG_STATE_DIR: stateDir, CLEANUP_LEDGER_FILE: path.join(stateDir, 'cleanup.jsonl') }, () =>
        teardownBlock(keyOnboardingBlock({ kubectl: kubectl.runner }), { env, readLines: () => lines, authenticate, handler, retryDelayMs: 1 }));
    expect(outcome).toMatchObject({ status: 'done', kept: 0, after: 'removed 2 token object(s) of this run' });
    expect(removed.length, 'every platform object first').toBe(lines.length);
    expect(kubectl.tokenObjects()).toEqual(['privkey\tkeep-me']);
    expect(fs.existsSync(markerOf(env))).toBe(false);
});

test('the in-sidecar scripts install nothing, write no file outside the token, read the PIN from the environment only, and use POSIX awk classes', () => {
    for (const file of [PLANT_EXEC_SCRIPT, UNPLANT_EXEC_SCRIPT]) {
        const src = fs.readFileSync(file, 'utf8');
        const code = src.split('\n').filter((l) => !/^\s*#/.test(l)).join('\n');
        expect(code, `${path.basename(file)}: nothing installed`).not.toMatch(/\bapk\b|\bsu-exec\b|apt-get/);
        expect(code, `${path.basename(file)}: no temp file`).not.toMatch(/mktemp|>\s*"?\$work|\/tmp\//);
        expect(src, `${path.basename(file)}: the PIN from the environment`).toContain('--login --pin env:TOKEN_PIN "$@"');
        expect(src).not.toMatch(/--pin\s+"\$TOKEN_PIN"/);
        expect(code, `${path.basename(file)}: no bracket \\t (busybox awk)`).not.toMatch(/\[\^? \\t\]/);
    }
    expect(fs.readFileSync(PLANT_EXEC_SCRIPT, 'utf8').trim().split('\n').pop(), 'the end line comes last (set -e)').toBe('echo PLANTED');
    const gateOf = (f: string) => /case "\$\{LABEL_PREFIX:-\}" in[\s\S]*?esac/.exec(fs.readFileSync(f, 'utf8'))?.[0];
    expect(gateOf(UNPLANT_EXEC_SCRIPT)).toBe(gateOf(UNPLANT_SCRIPT));
});

test('scrubSecrets: the raw, the sh-quoted and the JSON-escaped forms of every secret, longest first', () => {
    const odd = `a'b"c\\d`;
    expect(secretForms(odd)).toEqual([odd, `'a'\\''b"c\\d'`, `a'\\''b"c\\d`, `a'b\\"c\\\\d`]);
    const text = `raw ${odd} quoted '${odd.replace(/'/g, `'\\''`)}' json ${JSON.stringify(odd)} other`;
    expect(scrubSecrets(text, [odd])).toBe('raw <secret> quoted <secret> json "<secret>" other');
    // A secret inside a longer one: the longer goes first, nothing of it survives.
    expect(scrubSecrets('xx-abc-123-yy', ['abc', 'abc-123'])).toBe('xx-<secret>-yy');
    expect(scrubSecrets('nothing', [undefined, ''])).toBe('nothing');
    const e = scrubError(new Error(`pin=${odd}`), [odd]);
    expect(e.message).toBe('pin=<secret>');
    expect(e.stack).not.toContain(odd);
});

test('uuidOf scrubs the Admin\'s secrets from the answer it logs', async () => {
    const { log } = await logged(async () => {
        try {
            uuidOfShared({ echoed: { content: PIN } }, 'PIN secret', 'KeyOnboardingSetup', [PIN]);
        } catch {
        }
    });
    expect(log).toContain('"content":"<secret>"');
    expect(log).not.toContain(PIN);
});

test('a PIN the guard would read as an object id is refused before anything is created', async ({}, testInfo) => {
    for (const bad of ['6f1c2b3a-9d8e-4f70-a1b2-c3d4e5f60718', '6F1C2B3A-9D8E-4F70-A1B2-C3D4E5F60718', 'urn:uuid:6f1c2b3a-9d8e-4f70-a1b2-c3d4e5f60718', 'AAAAAAAAAAAAAAAAAAAAAA==', `x 6f1c2b3a-9d8e-4f70-a1b2-c3d4e5f60718 y`]) {
        expect(pinLooksLikeAnId(bad), bad).toBe(true);
        const env = sharedEnv('/tmp/x', { KO_TOKEN_PIN: bad });
        const reason = offlineBlocker(keyOnboardingConfig(env), env, RUN);
        expect(reason).toMatch(/^KO_TOKEN_PIN has a shape the guard reads as an object id/);
        expect(reason).not.toContain(bad);
    }
    for (const fine of ['1234', PIN, 'correct horse battery staple']) expect(pinLooksLikeAnId(fine), fine).toBe(false);
    const kubectl = fakeKubectl(testInfo.outputPath('k'));
    const run = await runSetup(testInfo, { connectors: clusterConnectors() }, {}, (d) => sharedEnv(d, { KO_TOKEN_PIN: '6f1c2b3a-9d8e-4f70-a1b2-c3d4e5f60718' }), kubectl.runner);
    expect(run.sent).toEqual([]);
    expect(kubectl.calls).toEqual([]);
});

test('the in-cluster kubeconfig goes with the process (removeKubeconfigs)', async ({}, testInfo) => {
    const k = fakeKubectl(testInfo.outputPath('k'));
    const pin = { inCluster: true as const, server: 'https://10.43.0.9:443', caFile: '/x/ca.crt', tokenFile: '/x/token' };
    await pinnedKubectl(k.runner, pin, {})(['version', '--client']);
    const file = k.calls[0].env!.KUBECONFIG;
    expect(fs.existsSync(file)).toBe(true);
    removeKubeconfigs();
    expect(fs.existsSync(path.dirname(file))).toBe(false);
});

test('10 / 20 / 30 record no derived object, so a shared-tier teardown has nothing it would keep (kept comes only from derived lines)', () => {
    const dir = path.join(__dirname, '..', 'key-onboarding');
    for (const f of ['10-listing.spec.ts', '20-onboarding.spec.ts', '30-removal.spec.ts']) {
        const src = fs.readFileSync(path.join(dir, f), 'utf8');
        expect(src, `${f}: no derived line`).not.toMatch(/recordDerived|uploadCertificate|uploadOwn/);
    }
    const handlers = fs.readFileSync(path.join(__dirname, '..', '..', 'utils', 'regression', 'teardown', 'teardownHandlers.ts'), 'utf8');
    for (const m of handlers.matchAll(/return 'kept';/g)) {
        const before = handlers.slice(Math.max(0, m.index! - 1500), m.index);
        expect(/derived/.test(before), `a kept branch near offset ${m.index} is about derived lines`).toBe(true);
    }
});

test('the manual file without a named context (the runner\'s in-cluster account) makes the person name one: a guard first, --context "$KO_KUBE_CONTEXT" on every kubectl', async ({}, testInfo) => {
    stateDir = testInfo.outputPath('state');
    const env = sharedEnv(stateDir, { KO_KUBE_CONTEXT: '' });
    writeMarkerFile(env);
    expect(plantingLeftover(env, RUN)).toContain(`$REG_STATE_DIR/${RUN}.key-onboarding.removal.sh`);
    const text = fs.readFileSync(path.join(stateDir, `${RUN}.key-onboarding.removal.sh`), 'utf8');
    const code = text.split('\n').filter((l) => l && !l.startsWith('#'));
    expect(code[0]).toBe(': "${KO_KUBE_CONTEXT:?set KO_KUBE_CONTEXT to your kubectl context of that cluster}"');
    expect(text).toMatch(/^# Planted through the API server .* with the runner pod's service account\.$/m);
    const kubectls = code.slice(1).join('\n').match(/kubectl [^|;&]*/g) ?? [];
    expect(kubectls.length).toBe(2);
    for (const k of kubectls) expect(k).toMatch(/^kubectl --context "\$KO_KUBE_CONTEXT" /);
    const bin = testInfo.outputPath('bin');
    fs.mkdirSync(bin, { recursive: true });
    fs.writeFileSync(path.join(bin, 'kubectl'), '#!/bin/sh\necho CALLED\n', { mode: 0o755 });
    const r = spawnSync('/bin/sh', [path.join(stateDir, `${RUN}.key-onboarding.removal.sh`)], { cwd: path.resolve(__dirname, '..', '..'), encoding: 'utf8', env: { PATH: `${bin}:/usr/bin:/bin`, TOKEN_PIN: 'x' } });
    expect(r.status).not.toBe(0);
    expect(r.stderr).toContain('set KO_KUBE_CONTEXT');
    expect(r.stdout).not.toContain('CALLED');
});

test('probes write nothing: plantingMarkerExists and the global teardown\'s check never create the manual file; it is 0600 even over an existing one', async ({}, testInfo) => {
    stateDir = testInfo.outputPath('state');
    const env = sharedEnv(stateDir);
    writeMarkerFile(env);
    const file = path.join(stateDir, `${RUN}.key-onboarding.removal.sh`);
    expect(plantingMarkerExists(env, RUN)).toBe(true);
    const calls: string[] = [];
    await devBlockGlobalTeardown(undefined, { env: { ...env, DEV_BLOCK: 'key-onboarding', REG_RUN_ID: RUN }, teardown: async () => { calls.push('teardown'); }, liveLines: () => 0, removeProof: () => undefined });
    expect(calls).toEqual(['teardown']);
    expect(fs.existsSync(file), 'no file from a probe').toBe(false);
    fs.writeFileSync(file, 'old', { mode: 0o644 });
    fs.chmodSync(file, 0o644);
    plantingLeftover(env, RUN);
    expect((fs.statSync(file).mode & 0o777).toString(8)).toBe('600');
    expect(fs.readFileSync(file, 'utf8')).toContain('kubectl');
});

test('scrubError walks cause and AggregateError errors, once each', () => {
    const inner = new Error(`inner ${PIN}`);
    const cause = new Error(`cause ${PIN}`, { cause: inner });
    const agg = new AggregateError([new Error(`one ${PIN}`), cause], `agg '${PIN}'`);
    const loop = new Error(`loop ${PIN}`);
    (loop as { cause?: unknown }).cause = loop;
    scrubError(agg, [PIN]);
    scrubError(loop, [PIN]);
    for (const e of [agg, ...agg.errors, inner, loop]) {
        expect(e.message).not.toContain(PIN);
        expect(e.stack ?? '').not.toContain(PIN);
    }
    expect(agg.message).toBe('agg <secret>');
    const stringCause = new Error('x', { cause: `pin ${PIN}` });
    scrubError(stringCause, [PIN]);
    expect((stringCause as { cause?: unknown }).cause).toBe('pin <secret>');
});

test('a PIN outside printable ASCII is refused before anything is created (the scrubber\'s forms cover printable ASCII)', async ({}, testInfo) => {
    for (const bad of ['piné', 'tab\there', 'line\nbreak', 'emoji\u{1F511}', '\u0000']) {
        const env = sharedEnv('/tmp/x', { KO_TOKEN_PIN: bad });
        const reason = offlineBlocker(keyOnboardingConfig(env), env, RUN);
        expect(reason, JSON.stringify(bad)).toMatch(/^KO_TOKEN_PIN has a character outside printable ASCII/);
        expect(reason).not.toContain(bad);
    }
    expect(offlineBlocker(keyOnboardingConfig(sharedEnv('/tmp/x', { KO_TOKEN_PIN: `ok ~!@#$%^&*()'"\\` })), sharedEnv('/tmp/x'), RUN)).toBeUndefined();
    const kubectl = fakeKubectl(testInfo.outputPath('k'));
    const run = await runSetup(testInfo, { connectors: clusterConnectors() }, {}, (d) => sharedEnv(d, { KO_TOKEN_PIN: 'piné' }), kubectl.runner);
    expect(run.sent).toEqual([]);
    expect(kubectl.calls).toEqual([]);
});

test('no process scan is left: the removal script reads no /proc and no KO_PROC_DIR, the plant exec is a plain sh -s', () => {
    const unplant = fs.readFileSync(UNPLANT_EXEC_SCRIPT, 'utf8');
    for (const gone of ['/proc', 'KO_PROC_DIR', 'KO_PLANTING', 'planting=']) expect(unplant, gone).not.toContain(gone);
    const target = keyOnboardingConfig(sharedEnv('/tmp/x')).kube;
    expect(execArgsOf(target, POD)).toEqual(['exec', '-i', '-n', NS, POD, '-c', CONTAINER, '--', 'sh', '-s']);
});

test('a re-plant with a stamp the marker already holds is refused before the exec; the earlier uncertain attempt stays and the teardown stays RED', async ({}, testInfo) => {
    const env = sharedEnv(testInfo.outputPath('state'));
    const cfg = keyOnboardingConfig(env);
    const killed = fakeKubectl(testInfo.outputPath('k1'), { execAnswer: { code: KILLED_EXIT, stdout: '', stderr: 'killed after 180000 ms' } });
    await expect(plantKeys({ cfg, env, runners: { kubectl: killed.runner }, pin: PIN, stamp: STAMP, runId: RUN })).rejects.toThrow(TierError);
    const fine = fakeKubectl(testInfo.outputPath('k2'));
    await expect(plantKeys({ cfg, env, runners: { kubectl: fine.runner }, pin: PIN, stamp: STAMP, runId: RUN })).rejects.toThrow(`a plant attempt with the stamp ${STAMP} is already in the run's planting marker`);
    expect(fine.calls.filter((c) => subcommand(c.args)[0] === 'exec'), 'nothing was delivered').toEqual([]);
    expect(readMarker(markerOf(env))!.attempts.map((a) => [a.stamp, a.certain])).toEqual([[STAMP, false]]);
    await expect(unplantRunKeys(env, RUN, { kubectl: fine.runner, retryDelayMs: 0 })).rejects.toThrow(/^planting did not finish cleanly/);
});

test('markCertain: a marker that vanished during the plant (state dir wiped) is an error, never a silent success', async ({}, testInfo) => {
    const env = sharedEnv(testInfo.outputPath('state'));
    const k = fakeKubectl(testInfo.outputPath('k'));
    const wiping: KubectlRunner = async (args, o) => {
        const r = await k.runner(args, o);
        if (subcommand(args)[0] === 'exec') fs.rmSync(markerOf(env), { force: true });
        return r;
    };
    const attempt = plantKeys({ cfg: keyOnboardingConfig(env), env, runners: { kubectl: wiping }, pin: PIN, stamp: STAMP, runId: RUN });
    await expect(attempt).rejects.toThrow(`the planting marker of attempt ${STAMP} is gone`);
    await expect(attempt).rejects.not.toBeInstanceOf(TierError);
});

test('a CLI that never started takes its attempt back out (nothing was delivered); every other failure stays uncertain', async ({}, testInfo) => {
    const env = sharedEnv(testInfo.outputPath('state'));
    const cfg = keyOnboardingConfig(env);
    const k = fakeKubectl(testInfo.outputPath('k'));
    const enoent: KubectlRunner = async (args, o) => (subcommand(args)[0] === 'exec' ? { code: 127, stdout: '', stderr: 'spawn kubectl ENOENT', notStarted: true } : k.runner(args, o));
    await expect(plantKeys({ cfg, env, runners: { kubectl: enoent }, pin: PIN, stamp: 'aa11', runId: RUN })).rejects.toThrow(/^kubectl did not start: nothing was planted \(the reason is in the setup log\)$/);
    expect(fs.existsSync(markerOf(env)), 'the only attempt: no marker left').toBe(false);
    const killed = fakeKubectl(testInfo.outputPath('k2'), { execAnswer: { code: 1, stdout: '', stderr: 'error: unable to upgrade connection' } });
    await expect(plantKeys({ cfg, env, runners: { kubectl: killed.runner }, pin: PIN, stamp: 'bb22', runId: RUN })).rejects.toThrow(TierError);
    await expect(plantKeys({ cfg, env, runners: { kubectl: enoent }, pin: PIN, stamp: 'cc33', runId: RUN })).rejects.toThrow(/did not start/);
    expect(readMarker(markerOf(env))!.attempts.map((a) => [a.stamp, a.certain])).toEqual([['bb22', false]]);
    expect(await spawnTool('/nonexistent/kubectl', ['version'], {}, { PATH: '/usr/bin:/bin' })).toMatchObject({ code: 127, notStarted: true });
    expect((await spawnTool('/bin/sh', ['-c', 'exit 3'], {}, { PATH: '/usr/bin:/bin' })).notStarted).toBeUndefined();
    const missingDocker = path.join(testInfo.outputPath('bin'), 'docker');
    fs.mkdirSync(path.dirname(missingDocker), { recursive: true });
    expect(await defaultDockerRunner({ ...process.env, REG_DOCKER_BIN: missingDocker })(['version'])).toMatchObject({ code: 127, notStarted: true });
});

test('the budget is checked before every kubectl call of the removal and caps each --request-timeout to what is left', async ({}, testInfo) => {
    stateDir = testInfo.outputPath('state');
    const env = sharedEnv(stateDir);
    writeMarkerFile(env);
    const k = fakeKubectl(testInfo.outputPath('k'));
    let t = 0;
    const error = await unplantRunKeys(env, RUN, { kubectl: k.runner, deadlineAt: 7_000, now: () => (t += 2_000), retryDelayMs: 0 }).then(() => undefined, (e: Error) => e);
    expect(error?.message).toMatch(/cannot be removed: the teardown's time budget is spent \(1 tries\); .*the command that removes them by hand is in \$REG_STATE_DIR\//);
    expect(k.calls.length, 'stopped between calls').toBeGreaterThan(0);
    expect(k.calls.filter((c) => subcommand(c.args)[0] === 'exec'), 'no exec once the budget is gone').toEqual([]);
    for (const c of k.calls) {
        const flag = c.args.find((a) => a.startsWith('--request-timeout='));
        if (flag) expect(Number(/=(\d+)s$/.exec(flag)![1]), flag).toBeLessThanOrEqual(5);
    }
});

test('with the marker every error of the removal names the manual file (a docker inspect that fails, a refused prefix)', async ({}, testInfo) => {
    const env = provenLocalEnv(testInfo.outputPath('state'));
    certainMarker(env);
    const docker = fakeDocker();
    const noImage: DockerRunner = async (args, o) => (args[0] === 'inspect' && args[2] === '{{.Config.Image}}' ? { code: 1, stdout: '', stderr: 'No such object' } : docker.runner(args, o));
    const error = await unplantRunKeys(env, RUN, { docker: noImage, retryDelayMs: 0 }).then(() => undefined, (e: Error) => e);
    expect(error?.message).toMatch(new RegExp(`^the run planted key pairs labelled ${RUN}-… but they cannot be removed: docker inspect of the sidecar container answered exit 1; .*the command that removes them by hand is in \\$REG_STATE_DIR/${RUN}\\.key-onboarding\\.removal\\.sh`));
});

test('the removal also deletes and counts secret keys and data objects of the run prefix (pkcs11-tool quotes a data label); foreign ones stay', async ({}, testInfo) => {
    stateDir = testInfo.outputPath('state');
    const env = sharedEnv(stateDir);
    writeMarkerFile(env);
    const k = fakeKubectl(testInfo.outputPath('k'));
    fs.writeFileSync(k.token, [
        `privkey\t${RUN}-ko-rsa-${STAMP}`, `pubkey\t${RUN}-ko-rsa-${STAMP}`, `cert\t${RUN}-ko-certified-${STAMP}`,
        `secrkey\t${RUN}-ko-aes-${STAMP}`, `data\t${RUN}-ko-data-${STAMP}`, `secrkey\tforeign-aes`, `data\tforeign-data`, '',
    ].join('\n'));
    expect(await unplantRunKeys(env, RUN, { kubectl: k.runner, retryDelayMs: 0 })).toBe('removed 5 token object(s) of this run');
    expect(k.tokenObjects()).toEqual(['secrkey\tforeign-aes', 'data\tforeign-data']);
});

test('scrubError: a thrown string, a plain-object cause and arrays inside it are scrubbed too', () => {
    expect(scrubError(`thrown ${PIN}`, [PIN])).toBe('thrown <secret>');
    const e = new Error('x', { cause: { body: { content: PIN, list: [`a ${PIN}`, 1] }, code: 7 } });
    scrubError(e, [PIN]);
    expect((e as { cause?: unknown }).cause).toEqual({ body: { content: '<secret>', list: ['a <secret>', 1] }, code: 7 });
    const obj = { message: `pin ${PIN}`, self: undefined as unknown };
    obj.self = obj;
    scrubError(obj, [PIN]);
    expect(obj.message).toBe('pin <secret>');
});

test('spawnTool, real processes: only a spawn failure (ENOENT, EACCES, a directory) is notStarted; a wrapper that reached a missing tool, a killed, a failing and a clean process all started', async ({}, testInfo) => {
    const dir = testInfo.outputPath('bin');
    fs.mkdirSync(dir, { recursive: true });
    const sink = path.join(dir, 'stdin-seen.txt');
    const noexec = path.join(dir, 'noexec');
    fs.writeFileSync(noexec, '#!/bin/sh\ncat >/dev/null\n', { mode: 0o644 });
    const wrapper = path.join(dir, 'wrapper');
    fs.writeFileSync(wrapper, `#!/bin/sh\ncat >"${sink}"\nexec /nonexistent/kubectl "$@"\n`, { mode: 0o755 });
    const sleeper = path.join(dir, 'sleeper');
    fs.writeFileSync(sleeper, `#!/bin/sh\ncat >>"${sink}"\nsleep 5\n`, { mode: 0o755 });
    const stdin = 'export TOKEN_PIN=x\necho PLANTED\n';
    const env_ = { PATH: '/usr/bin:/bin' };
    expect((await spawnTool('/nonexistent/kubectl', ['exec'], { stdin }, env_)).notStarted).toBe(true);
    expect((await spawnTool(noexec, ['exec'], { stdin }, env_)).notStarted).toBe(true);
    expect((await spawnTool(dir, ['exec'], { stdin }, env_)).notStarted).toBe(true);
    expect((await spawnTool(wrapper, ['exec'], { stdin }, env_)).notStarted, 'the wrapper started and got stdin').toBeUndefined();
    expect(fs.readFileSync(sink, 'utf8')).toContain('PLANTED');
    const killed = await spawnTool(sleeper, ['exec'], { stdin, timeoutMs: 300 }, env_);
    expect(killed).toMatchObject({ code: KILLED_EXIT });
    expect(killed.notStarted).toBeUndefined();
    expect((await spawnTool('/bin/sh', ['-c', 'cat >/dev/null; exit 3'], { stdin }, env_)).notStarted).toBeUndefined();
    const clean = await spawnTool('/bin/sh', ['-c', 'cat'], { stdin }, env_);
    expect(clean).toMatchObject({ code: 0, stdout: stdin });
    expect(clean.notStarted).toBeUndefined();
});

test('the marker is read again before a green end: an attempt a concurrent plant appended during the pass makes the teardown RED', async ({}, testInfo) => {
    stateDir = testInfo.outputPath('state');
    const env = sharedEnv(stateDir);
    writeMarkerFile(env);
    const k = fakeKubectl(testInfo.outputPath('k'));
    fs.writeFileSync(k.token, `privkey\t${RUN}-ko-rsa-${STAMP}\n`);
    for (const [name, appended] of [['uncertain', { stamp: 'rg02', labels: ['x'], certain: false }], ['certain', { stamp: 'rg03', labels: ['y'], certain: true }]] as const) {
        writeMarkerFile(env);
        const concurrent: KubectlRunner = async (args, o) => {
            const r = await k.runner(args, o);
            if (subcommand(args)[0] === 'exec') writeMarkerFile(env, { attempts: [certainAttempt, appended] });
            return r;
        };
        await expect(unplantRunKeys(env, RUN, { kubectl: concurrent, retryDelayMs: 0 }), name).rejects.toThrow(/^the run's planting marker changed during the removal .*a person must re-check the token later with \$REG_STATE_DIR\//);
        expect(fs.existsSync(markerOf(env)), `${name}: the marker stays`).toBe(true);
    }
    writeMarkerFile(env);
    const wiping: KubectlRunner = async (args, o) => { const r = await k.runner(args, o); if (subcommand(args)[0] === 'exec') fs.rmSync(markerOf(env)); return r; };
    await expect(unplantRunKeys(env, RUN, { kubectl: wiping, retryDelayMs: 0 })).rejects.toThrow(/planting marker changed during the removal/);
});

test('scrubError never throws: a frozen Error is rebuilt scrubbed (message, stack, cause), a hostile getter is replaced by a plain error', () => {
    const frozen = Object.freeze(new Error(`frozen ${PIN}`, { cause: `cause ${PIN}` }));
    const out = scrubError(frozen, [PIN]) as Error;
    expect(out).not.toBe(frozen);
    expect(out.message).toBe('frozen <secret>');
    expect(out.stack ?? '').not.toContain(PIN);
    expect((out as { cause?: unknown }).cause).toBe('cause <secret>');
    const frozenAgg = Object.freeze(new AggregateError([new Error(`one ${PIN}`)], `agg ${PIN}`));
    const agg = scrubError(frozenAgg, [PIN]) as AggregateError;
    expect(agg).toBeInstanceOf(AggregateError);
    expect(agg.message).toBe('agg <secret>');
    expect(agg.errors[0].message).toBe('one <secret>');
    const hostile = new Error('x');
    Object.defineProperty(hostile, 'message', { get() { throw new Error(`boom ${PIN}`); } });
    const safe = scrubError(hostile, [PIN]) as Error;
    expect(() => scrubError(hostile, [PIN])).not.toThrow();
    expect(safe.message).not.toContain(PIN);
});
