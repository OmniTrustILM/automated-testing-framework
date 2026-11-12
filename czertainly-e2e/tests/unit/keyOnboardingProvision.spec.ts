/**
 * keyOnboardingProvision — the key onboarding setup (utils/keyOnboarding/provision) against an in-process fake core,
 * through the REAL guard (`guardApiWithSeams`, `localStack` on a proven local stack), and a fake docker runner: what
 * the preflight refuses and why, the creation order of the source suite, one ledger line per created object right
 * after its create (run-prefixed name, spec `key-onboarding/setup`, the parents the teardown handlers read), the
 * planted labels and the docker command lines (the PIN in no argv), the summary's shape and mode, and the removal of
 * the run's token objects. No network, no tier, no docker: the fakes record what they were sent and answer canned data.
 */
import { APIRequestContext, expect, test } from '@playwright/test';
import { spawnSync } from 'child_process';
import { randomBytes } from 'crypto';
import * as fs from 'fs';
import * as path from 'path';
import { keyOnboardingConfig, summaryFile } from '../../utils/keyOnboarding/config';
import type { DockerResult, DockerRunner } from '../../utils/keyOnboarding/provision/docker';
import { PLANT_SCRIPT, UNPLANT_SCRIPT, unplantRunKeys } from '../../utils/keyOnboarding/provision/plant';
import { uriNamesToken } from '../../utils/keyOnboarding/provision/preflight';
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
/** A PIN made per test run: no literal PIN in this file either. */
const PIN = `pin-${randomBytes(9).toString('hex')}`;
/** A run id of the generated shape (the unit tests themselves run under the adhoc default, which the removal refuses). */
const RUN = 'qa-reg-20261023-101010-ab12';
/** The text a refused answer carries: it must stay in the log. */
const ECHO = 'ECHO-OF-THE-REQUEST-BODY';

const defaultConnectors = (): Json[] => [
    { uuid: U(9), name: 'software-cryptography-provider-v2', url: 'http://localhost:8230', version: 'v2', status: 'connected', interfaces: [{ uuid: U(10), code: 'cryptography' }] },
    { uuid: C_PKCS11, name: 'pkcs11-cryptography-provider', url: PKCS11_URL, version: 'v2', status: 'connected', interfaces: [{ uuid: I_CRYPTO, code: 'cryptography', features: ['keyList'] }] },
    // The same URL registered as v1 too: only the v2 registration counts.
    { uuid: U(11), name: 'common-credential-provider', url: VAULT_URL, version: 'v1', status: 'connected', interfaces: [] },
    { uuid: C_VAULT, name: 'common-credential-provider-v2', url: VAULT_URL, version: 'v2', status: 'connected', interfaces: [{ uuid: I_SECRET, code: 'secret' }] },
];

interface FakeOptions {
    connectors?: Json[];
    /** The token URIs the connector's profile offers. */
    tokenUris?: string[];
    /** `METHOD /path/{id}` → a status answered instead of the route's (with a body that must never reach a reason). */
    statusFor?: Record<string, number>;
    /** The secret never leaves `inactive`. */
    secretStuck?: boolean;
}

interface Sent {
    seq: number;
    method: string;
    path: string;
    body: unknown;
    /** Ledger lines in the file when the request was sent. */
    ledgerLines: number;
    /** The uuid the answer created, when it was a create. */
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

/** A fake core: canned answers for every route the setup uses; creates answer fresh uuids; every request is recorded. */
function fakeCore(opts: FakeOptions = {}) {
    const sent: Sent[] = [];
    let n = 1000;
    const next = () => `aaaaaaaa-0000-4000-8000-${String(++n).padStart(12, '0')}`;
    const create = () => ({ uuid: next() });
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
        ['POST', /^\/v1\/vaults$/, () => [200, create()]],
        ['POST', new RegExp(`^/v1/vaults/${UUID}/vaultProfiles$`), () => [200, create()]],
        ['PATCH', new RegExp(`^/v1/vaults/${UUID}/vaultProfiles/${UUID}/enable$`), () => [204, undefined]],
        ['POST', new RegExp(`^/v1/vaults/${UUID}/vaultProfiles/${UUID}/secrets$`), () => {
            const c = create();
            secrets.set(c.uuid, { reads: 0, enabled: false });
            return [200, c];
        }],
        ['GET', new RegExp(`^/v1/secrets/(${UUID})$`), (m) => {
            const s = secrets.get(m[1])!;
            s.reads += 1;
            // The first read still sees the vault write in flight.
            const state = s.reads === 1 || opts.secretStuck ? 'inactive' : 'active';
            return [200, { uuid: m[1], state, enabled: s.enabled }];
        }],
        ['PATCH', new RegExp(`^/v1/secrets/(${UUID})/enable$`), (m) => {
            secrets.get(m[1])!.enabled = true;
            return [204, undefined];
        }],
        ['POST', /^\/v1\/tokens$/, () => [200, create()]],
        ['POST', new RegExp(`^/v1/tokens/${UUID}/tokenProfiles$`), () => [200, create()]],
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

/** A fake docker CLI: answers the inspects and the two script runs; records argv and the added environment. */
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

/** A local env with this run's local-backend proof written (the guard's localStack needs it, and so does the preflight). */
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

/** Runs the setup against a fake core through the real guard (localStack) judging against `env`, with a fake docker. */
async function runSetup(testInfo: { outputPath: (p: string) => string }, fake: FakeOptions = {}, dockerOpts: DockerOptions = {}, envOf: (dir: string) => NodeJS.ProcessEnv = (d) => provenLocalEnv(d)): Promise<Run> {
    stateDir = testInfo.outputPath('state');
    const env = envOf(stateDir);
    const core = fakeCore(fake);
    const docker = fakeDocker(dockerOpts);
    return withProcessEnv({ REG_STATE_DIR: stateDir, BASE_URL: env.BASE_URL ?? 'http://localhost:3080' }, async () => {
        const api: GuardedApi = guardApiWithSeams(core.api, { localStack: true, env, lines: [], runId: runId(), tier: null });
        const summary = await provisionKeyOnboarding(api, { cfg: keyOnboardingConfig(env), env, poll: NO_POLL_PAUSE, docker: docker.runner, stamp: STAMP });
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

// ------------------------------------------------------------------ the blockers before any request: no request, no docker

test('a shared tier, a missing local proof and a missing PIN are unavailable without a request and without docker', async ({}, testInfo) => {
    const shared = await runSetup(testInfo, {}, {}, (d) => ({ TIER_KIND: 'shared', BASE_URL: 'https://tier.example', REG_STATE_DIR: d, REG_RUN_ID: runId(), KO_TOKEN_PIN: PIN }));
    expect(reasonOf(shared.summary)).toMatch(/^not a local stack/);
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

// The control: the same run through the same guard WITHOUT localStack is refused at its first request that needs it, so the full-run
// tests below prove the guard lets every request of the setup through on a proven local stack.
test('control: without localStack the guard refuses the setup (it is the real guard judging every request)', async ({}, testInfo) => {
    stateDir = testInfo.outputPath('state');
    const env = provenLocalEnv(stateDir);
    const core = fakeCore();
    const docker = fakeDocker();
    await withProcessEnv({ REG_STATE_DIR: stateDir, BASE_URL: 'http://localhost:3080' }, async () => {
        const api = guardApiWithSeams(core.api, { env, lines: [], runId: runId(), tier: null });
        await expect(provisionKeyOnboarding(api, { cfg: keyOnboardingConfig(env), env, poll: NO_POLL_PAUSE, docker: docker.runner, stamp: STAMP })).rejects.toThrow(OwnObjectViolation);
    });
    // The lists, the form callbacks and the creates of an own vault are allowed for the guard now (the timestamping block needs them on a
    // shared tier), so the setup goes on until its first request that needs localStack; that one never reached the core.
    expect(core.sent.some((s) => s.method === 'PATCH' && /\/certificates\//.test(s.path)), 'the request localStack lifts was not sent').toBe(false);
    expect(scriptRuns(docker.calls), 'nothing planted').toEqual([]);
});

// ------------------------------------------------------------------ the preflight's reasons: read-only

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

// ------------------------------------------------------------------ the full run

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
    expect(run.sent.filter((s) => s.method === 'GET' && /^\/v1\/secrets\//.test(s.path)).length, 'the secret is read until active and enabled').toBe(3);

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

    // Every write after a create targets an own object; the creates go under own parents or the read-only connectors.
    const own = new Set(run.ledger.map((l) => l.uuid));
    for (const m of mutations(run.sent)) {
        for (const id of m.path.match(new RegExp(UUID, 'g')) ?? []) expect(own.has(id), `${m.method} ${template(m.path)} names own objects only`).toBe(true);
    }
    // The planting comes after the last platform request.
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
    for (const l of labels) expect(l, l).toMatch(new RegExp(`^${runId()}-ko-[a-z0-9-]+-${STAMP}$`));
    expect(planted.rsa).toBe(`${runId()}-ko-rsa-${STAMP}`);

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

// ------------------------------------------------------------------ failures: the tier's answer, or the setup's own error

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

// ------------------------------------------------------------------ the removal of the run's token objects

test('unplantRunKeys passes the run prefix through the environment, mounts the removal script, and reports the count', async ({}, testInfo) => {
    const env = provenLocalEnv(testInfo.outputPath('state'));
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

    const noCount = fakeDocker({ unplantCount: 'pkcs11-tool: no token' });
    await expect(unplantRunKeys(env, RUN, { docker: noCount.runner })).rejects.toThrow(/printed no count/);
});

test('a failed removal names the prefix and the command that finishes it by hand, never the PIN', async ({}, testInfo) => {
    const env = provenLocalEnv(testInfo.outputPath('state'));
    const docker = fakeDocker();
    const failing: DockerRunner = async (args, o) => (args.at(-1) === '/unplant-keys.sh' ? { code: 1, stdout: '', stderr: `still there ${PIN}` } : docker.runner(args, o));
    const error = await unplantRunKeys(env, RUN, { docker: failing }).then(() => undefined, (e: Error) => e);
    expect(error?.message).toContain(`token objects labelled ${RUN}-… may still be on the token`);
    expect(error?.message).toContain(`export TOKEN_PIN with the value of KO_TOKEN_PIN and run: SOFTHSM2_CONF='/etc/softhsm/softhsm2.conf' TOKEN_OWNER='10001:10001' TOKEN_LABEL='softhsm' LABEL_PREFIX='${RUN}-' `
        + `docker run --rm --user 0 --volumes-from ${SIDECAR} --entrypoint sh -v ${UNPLANT_SCRIPT}:/unplant-keys.sh:ro `
        + `-e SOFTHSM2_CONF -e TOKEN_OWNER -e TOKEN_LABEL -e TOKEN_PIN -e LABEL_PREFIX ${SIDECAR_IMAGE} /unplant-keys.sh`);
    expect(error?.message, 'neither the PIN nor the script output').not.toContain(PIN);
});

test('unplantRunKeys refuses an empty or shared prefix before docker, and removes nothing where nothing was planted', async ({}, testInfo) => {
    const env = provenLocalEnv(testInfo.outputPath('state'));
    for (const id of ['', 'qa-reg-adhoc', 'qa-api-adhoc', 'someone-else', 'qa-reg-1', 'qa-reg-20261023', `${RUN}x`, `${RUN}-x`, 'qa-reg-20261023-1010-ab12']) {
        const docker = fakeDocker();
        await expect(unplantRunKeys(env, id, { docker: docker.runner }), `run id '${id}'`).rejects.toThrow(/^refusing to remove token objects: /);
        expect(docker.calls, `run id '${id}': no docker`).toEqual([]);
    }
    const shared = fakeDocker();
    expect(await unplantRunKeys({ ...env, TIER_KIND: 'shared' }, RUN, { docker: shared.runner })).toMatch(/^no token objects removed: not a local stack/);
    expect(shared.calls).toEqual([]);
    const noPin = fakeDocker();
    expect(await unplantRunKeys({ ...env, KO_TOKEN_PIN: '' }, RUN, { docker: noPin.runner })).toMatch(/^no token objects removed: KO_TOKEN_PIN is not set/);
    expect(noPin.calls).toEqual([]);
    const stopped = fakeDocker({ sidecarStopped: true });
    expect(await unplantRunKeys(env, RUN, { docker: stopped.runner })).toBe('no token objects removed: the SoftHSM sidecar container KO_SIDECAR_CONTAINER names is not running');
    expect(scriptRuns(stopped.calls)).toEqual([]);
});

/** Runs the removal script with no tool on PATH: only its shell-only prefix gate can run, so nothing reaches a token. */
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
    ]);
    // A backslash or a pattern character in the prefix stays literal (awk -v would have read the backslash as an escape).
    const odd = 'qa-reg-a.b\\n*-';
    fs.writeFileSync(file, `Private Key Object; EC\n  label:      ${odd}x\nPrivate Key Object; EC\n  label:      qa-reg-aXb\\n*-x\n`);
    const lit = spawnSync('awk', [program!, file], { env: { PATH: process.env.PATH ?? '/usr/bin:/bin', LABEL_PREFIX: odd }, encoding: 'utf8' });
    expect(lit.stdout).toBe(`privkey\t${odd}x\n`);
    expect(src, 'one pkcs11-tool login for every call, with the PIN read from the environment').toContain('--login --pin env:TOKEN_PIN "$@"');
    expect(src, 'the second listing decides').toMatch(/after=\$\(run_objects\)\nif \[ "\$after" -ne 0 \]/);
});
