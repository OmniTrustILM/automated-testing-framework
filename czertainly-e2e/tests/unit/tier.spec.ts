/**
 * tier — unit tests for the TIER_KIND guard.
 *
 * An unset or unknown kind is a shared tier. TIER_KIND=local needs positive proof of a local backend: a local BASE_URL
 * (loopback, or a TIER_LOCAL_HOSTS entry that is or resolves to a private address), a local REG_LOCAL_CORE_URL, the core's
 * /api/v1/info build marker, a container publishing the core port, and in the setup BASE_URL's authenticated /api/v1/info
 * naming the same build. The probe, resolver and container proof are injected, so a dev proxy, tunnel or port-forward cannot
 * switch on destructive @local rows against a shared tier. Also: header auth only on a local BASE_URL, the instance round
 * trip, the proof file's expiry and removal, and `*.localhost` resolved like any other name.
 */
import { test, expect } from '@playwright/test';
import * as fs from 'fs';
import {
    assertAuthModeAllowed,
    assertLocalAllowed,
    assertLocalBackend,
    assertRunTier,
    buildMarker,
    describeLocalOnly,
    hasLocalProof,
    InfoReader,
    LOCAL_PROOF_MAX_AGE_MS,
    localProofFile,
    HttpProbe,
    HttpProbeResult,
    proveLocalInstance,
    removeLocalProof,
} from '../../utils/regression/tier/localProof';
import { ContainerProof, containerPublishes, dockerHostName, publishedHostPorts } from '../../utils/regression/tier/docker';
import { freezeTierEnv, isLocalTier, tierIdentity, tierKind } from '../../utils/regression/tier/kind';
import { isLocalHost, isLoopbackHost, isPrivateAddress, Resolver, resetResolvedHostsForTests } from '../../utils/regression/tier/dns';

// Each test resolves its hosts afresh (the resolver is injected per test).
test.afterEach(() => resetResolvedHostsForTests());

const INFO = { app: { name: 'core', version: '2.15.0' }, build: { branch: 'main', commitId: 'abc', timestamp: 't' }, db: {} };

/** A probe answering per URL prefix; records the URLs it was asked for. */
function probe(answers: Record<string, HttpProbeResult>): { probe: HttpProbe; urls: string[] } {
    const urls: string[] = [];
    return {
        urls,
        probe: (url) => {
            urls.push(url);
            const key = Object.keys(answers).find((k) => url.startsWith(k));
            return key ? answers[key] : { ok: false, error: 'ECONNREFUSED' };
        },
    };
}

const LOCAL = { TIER_KIND: 'local', BASE_URL: 'http://localhost:3080/', REG_LOCAL_CORE_URL: 'http://localhost:8280' };
const coreUp = () => probe({ 'http://localhost:8280/api/v1/info': { ok: true, status: 200, body: INFO }, 'http://localhost:3080/api/v1/info': { ok: true, status: 200, body: INFO } });
/** A container proof that always passes / never runs (unit tests never call docker). */
const containersOk: ContainerProof = () => ({ ok: true });
/** A resolver from a fixed table; unknown names do not resolve. */
const resolver = (table: Record<string, string[]>): Resolver => (host) => (table[host] ? { addresses: table[host] } : { error: 'ENOTFOUND' });
/** The current docker context: the local socket (unit tests never run `docker context inspect`). */
const localSocket = () => ({ host: 'unix:///var/run/docker.sock' });
const proofOk = (extra: { probe?: HttpProbe; resolve?: Resolver } = {}) => ({ probe: coreUp().probe, containers: containersOk, resolve: resolver({}), dockerContext: localSocket, ...extra });

test('unset, empty and unknown TIER_KIND mean a shared tier', () => {
    expect(tierKind({})).toBe('shared');
    expect(tierKind({ TIER_KIND: '' })).toBe('shared');
    expect(tierKind({ TIER_KIND: 'Local' }), 'case matters: only the exact value switches').toBe('shared');
    expect(tierKind({ TIER_KIND: 'shared' })).toBe('shared');
    expect(tierKind({ TIER_KIND: 'local' })).toBe('local');
    expect(isLocalTier({ TIER_KIND: 'local' })).toBe(true);
});

test('loopback hosts are recognised, everything else is not', () => {
    for (const host of ['localhost', 'LOCALHOST', '127.0.0.1', '127.3.2.1', '::1', '[::1]']) {
        expect(isLoopbackHost(host), host).toBe(true);
    }
    for (const host of ['example.com', '10.0.0.5', '192.168.1.10', 'localhost.example.com', '128.0.0.1', '::2', 'fe.localhost']) {
        expect(isLoopbackHost(host), host).toBe(false);
    }
});

test('*.localhost is resolved like any other name: loopback addresses only', () => {
    const table = resolver({ 'fe.localhost': ['127.0.0.1', '::1'], 'evil.localhost': ['203.0.113.7'], 'mixed.localhost': ['127.0.0.1', '10.0.0.1'] });
    expect(isLocalHost('fe.localhost', {}, { resolve: table })).toBe(true);
    expect(isLocalHost('evil.localhost', {}, { resolve: table }), 'mapped to a public address').toBe(false);
    expect(isLocalHost('mixed.localhost', {}, { resolve: table }), 'one non-loopback address').toBe(false);
    expect(isLocalHost('unknown.localhost', {}, { resolve: table }), 'does not resolve').toBe(false);
});

test('the build marker needs the commit id or the build time next to the version', () => {
    expect(buildMarker(INFO)).toBe(JSON.stringify(['2.15.0', 'abc', 't']));
    expect(buildMarker({ app: { version: '2.15.0' }, build: { timestamp: 't' } })).toBe(JSON.stringify(['2.15.0', '', 't']));
    expect(buildMarker({ app: { version: '2.15.0' } }), 'a version alone matches every stack of a release').toBeUndefined();
    expect(buildMarker({ app: { version: '2.15.0' }, build: { commitId: '', timestamp: '' } })).toBeUndefined();
    const versionOnly = probe({ 'http://localhost:8280/api/v1/info': { ok: true, status: 200, body: { app: { version: '2.15.0' } } } });
    expect(() => assertLocalAllowed({ ...LOCAL }, proofOk({ probe: versionOnly.probe }))).toThrow(/did not answer \/api\/v1\/info with a build marker/);
});

// the container proof must read the daemon of the core's machine: this machine, or DOCKER_HOST pointing at the core host
test('the container proof must read the docker daemon of the core machine, local or via DOCKER_HOST', () => {
    const lan = resolver({ 'compose-box.lan': ['192.168.1.20'], 'other-box.lan': ['192.168.1.30'] });
    const remote = { TIER_KIND: 'local', TIER_LOCAL_HOSTS: 'compose-box.lan', BASE_URL: 'http://compose-box.lan:3080', REG_LOCAL_CORE_URL: 'http://compose-box.lan:8280' };
    const ok = probe({ 'http://compose-box.lan:8280/api/v1/info': { ok: true, status: 200, body: INFO }, 'http://compose-box.lan:3080/api/v1/info': { ok: false, status: 401 } });
    const notMine = () => ['127.0.0.1', '::1', '192.168.1.99'];
    const opts = { probe: ok.probe, resolve: lan, containers: containersOk, interfaces: notMine, dockerContext: localSocket };
    // A private core on another machine with the local daemon: an unrelated local container on the same port proves nothing.
    expect(() => assertLocalAllowed({ ...remote }, opts)).toThrow(/not an address of this machine, and DOCKER_HOST does not point at that host/);
    expect(() => assertLocalAllowed({ ...remote, DOCKER_HOST: 'tcp://other-box.lan:2376' }, opts), 'a daemon on a third machine').toThrow(/DOCKER_HOST does not point/);
    expect(() => assertLocalAllowed({ ...remote, DOCKER_HOST: 'tcp://compose-box.lan:2376' }, opts)).not.toThrow();
    expect(() => assertLocalAllowed({ ...remote, DOCKER_HOST: 'ssh://qa@192.168.1.20' }, opts), 'by address').not.toThrow();
    expect(() => assertLocalAllowed({ ...remote }, { ...opts, interfaces: () => ['192.168.1.20'] }), 'the core host is this machine').not.toThrow();
    // A loopback core needs a local daemon: DOCKER_HOST pointing elsewhere is refused, a socket is fine.
    expect(() => assertLocalAllowed({ ...LOCAL, DOCKER_HOST: 'tcp://other-box.lan:2376' }, { ...proofOk(), resolve: lan, interfaces: notMine })).toThrow(/points at another daemon/);
    expect(() => assertLocalAllowed({ ...LOCAL, DOCKER_HOST: 'unix:///var/run/docker.sock' }, { ...proofOk(), interfaces: notMine })).not.toThrow();
    expect(() => assertLocalAllowed({ ...LOCAL, DOCKER_HOST: '::not a url' }, { ...proofOk(), interfaces: notMine })).toThrow(/DOCKER_HOST is not a readable URL/);
    expect([dockerHostName(undefined), dockerHostName('unix:///x.sock'), dockerHostName('npipe:////./pipe/docker_engine'), dockerHostName('tcp://Box.lan:2376')])
        .toEqual([undefined, undefined, undefined, 'box.lan']);
});

test('a shared tier never trips the local guard', () => {
    expect(() => assertLocalAllowed({ BASE_URL: 'https://qa.example.com' })).not.toThrow();
    expect(() => assertLocalAllowed({})).not.toThrow();
});

test('TIER_KIND=local needs a loopback BASE_URL', () => {
    expect(() => assertLocalAllowed({ ...LOCAL }, proofOk())).not.toThrow();
    expect(() => assertLocalAllowed({ ...LOCAL, BASE_URL: 'https://127.0.0.1:8443/administrator' }, proofOk())).not.toThrow();
    expect(() => assertLocalAllowed({ ...LOCAL, BASE_URL: 'https://qa.example.com' }, proofOk())).toThrow(/loopback/);
    expect(() => assertLocalAllowed({ TIER_KIND: 'local' })).toThrow(/needs BASE_URL/);
    expect(() => assertLocalAllowed({ TIER_KIND: 'local', BASE_URL: 'not a url' })).toThrow(/not a valid URL/);
});

// a loopback BASE_URL is not enough: REG_LOCAL_CORE_URL must be local and answer /api/v1/info with a marker
test('a loopback BASE_URL is not enough: REG_LOCAL_CORE_URL must be local and answer with a marker', () => {
    expect(() => assertLocalAllowed({ TIER_KIND: 'local', BASE_URL: 'http://localhost:3080' }, proofOk())).toThrow(/needs REG_LOCAL_CORE_URL/);
    expect(() => assertLocalAllowed({ ...LOCAL, REG_LOCAL_CORE_URL: 'https://core.example.com' }, proofOk())).toThrow(/REG_LOCAL_CORE_URL is not a loopback/);
    const down = probe({});
    expect(() => assertLocalAllowed({ ...LOCAL }, proofOk({ probe: down.probe }))).toThrow(/did not answer \/api\/v1\/info with a build marker \(ECONNREFUSED\)/);
    expect(down.urls).toEqual(['http://localhost:8280/api/v1/info']);
    // A 200 that is not a core info answer (a dev server's index.html) proves nothing.
    const html = probe({ 'http://localhost:8280/api/v1/info': { ok: true, status: 200, body: undefined } });
    expect(() => assertLocalAllowed({ ...LOCAL }, proofOk({ probe: html.probe }))).toThrow(/did not answer/);
});

test('liveness alone is no longer a proof: the build marker is required', () => {
    const live = probe({ 'http://localhost:8280/api/v1/health/liveness': { ok: true, status: 200, body: { status: 'UP' } } });
    expect(() => assertLocalAllowed({ ...LOCAL }, proofOk({ probe: live.probe }))).toThrow(/build marker/);
    expect(live.urls, 'liveness is never asked').toEqual(['http://localhost:8280/api/v1/info']);
});

// BASE_URL served by a different core build than REG_LOCAL_CORE_URL is refused (a proxy to a shared core)
test('BASE_URL served by a different core build than REG_LOCAL_CORE_URL is refused as a proxy', () => {
    const shared = { ...INFO, app: { name: 'core', version: '2.14.1' }, build: { branch: 'main', commitId: 'zzz', timestamp: 'u' } };
    const p = probe({ 'http://localhost:8280/api/v1/info': { ok: true, status: 200, body: INFO }, 'http://localhost:3080/api/v1/info': { ok: true, status: 200, body: shared } });
    expect(() => assertLocalAllowed({ ...LOCAL }, proofOk({ probe: p.probe }))).toThrow(/different core build/);
    // Not readable anonymously through BASE_URL (an IdP in front): the config load passes; the setup's authenticated
    // read decides (assertLocalBackend below).
    const p2 = probe({ 'http://localhost:8280/api/v1/info': { ok: true, status: 200, body: INFO }, 'http://localhost:3080/api/v1/info': { ok: false, status: 401 } });
    const env: NodeJS.ProcessEnv = { ...LOCAL };
    expect(() => assertLocalAllowed(env, proofOk({ probe: p2.probe }))).not.toThrow();
    expect(env.REG_LOCAL_CORE_MARKER, 'the core marker is kept for the run').toBe(JSON.stringify(['2.15.0', 'abc', 't']));
});

// the container proof: a running container must publish the core port (and carry the compose label when asked); no docker ⇒ refused
test('the container proof: a running container must publish the core port; no docker is refused', () => {
    const calls: Array<[number, string | undefined]> = [];
    const none: ContainerProof = (port, compose) => {
        calls.push([port, compose]);
        return { ok: false, error: 'no running container publishes the core port' };
    };
    expect(() => assertLocalAllowed({ ...LOCAL, REG_LOCAL_COMPOSE_PROJECT: 'ilm' }, { probe: coreUp().probe, containers: none, dockerContext: localSocket })).toThrow(/no container proof/);
    expect(calls).toEqual([[8280, 'ilm']]);
    const noDocker: ContainerProof = () => ({ ok: false, error: 'the docker CLI is not usable (ENOENT); set REG_DOCKER_BIN or install docker' });
    expect(() => assertLocalAllowed({ ...LOCAL }, { probe: coreUp().probe, containers: noDocker, dockerContext: localSocket })).toThrow(/docker CLI is not usable/);
    // The pure parts of the default proof.
    expect(publishedHostPorts('0.0.0.0:8280->8080/tcp, [::]:8280->8080/tcp, 5432/tcp')).toEqual([8280, 8280]);
    expect(publishedHostPorts('127.0.0.1:8000-8002->8000-8002/tcp')).toEqual([8000, 8001, 8002]);
    const rows = [{ Ports: '0.0.0.0:8280->8080/tcp', Labels: 'com.docker.compose.project=ilm,com.docker.compose.service=core' }, { Ports: '5432/tcp' }];
    expect(containerPublishes(rows, 8280)).toBe(true);
    expect(containerPublishes(rows, 8280, 'ilm')).toBe(true);
    expect(containerPublishes(rows, 8280, 'other')).toBe(false);
    expect(containerPublishes(rows, 5432), 'exposed but not published').toBe(false);
});

const reader = (status: number, body?: unknown): InfoReader => ({ get: async () => ({ ok: () => status < 300, status: () => status, json: async () => body }) });

// tunnel: BASE_URL info unreadable with authentication ⇒ refused; the marker check alone writes no proof
test('tunnel: BASE_URL info unreadable with authentication is refused; the marker alone writes no proof', async ({}, testInfo) => {
    const env: NodeJS.ProcessEnv = { ...LOCAL, REG_STATE_DIR: testInfo.outputPath('state'), REG_RUN_ID: 'qa-reg-20261014-100000-ab12' };
    await expect(assertLocalBackend(reader(401), env, { probe: coreUp().probe })).rejects.toThrow(/answered 401 with the run's authentication/);
    await expect(assertLocalBackend(reader(200, { html: true }), env, { probe: coreUp().probe })).rejects.toThrow(/carries no core build marker/);
    const shared = { ...INFO, app: { name: 'core', version: '2.14.1' } };
    await expect(assertLocalBackend(reader(200, shared), env, { probe: coreUp().probe })).rejects.toThrow(/different core build/);
    expect(await assertLocalBackend(reader(200, INFO), env, { probe: coreUp().probe })).toBe(JSON.stringify(['2.15.0', 'abc', 't']));
    expect(hasLocalProof(env), 'the same build is not the same instance: no proof without the round trip').toBe(false);
    // A shared tier sends nothing.
    await assertLocalBackend({ get: async () => { throw new Error('no request expected'); } }, { BASE_URL: 'https://qa.example.com' });
});

// instance identity: a role created through BASE_URL must be read back through REG_LOCAL_CORE_URL before the proof is written
test('instance identity: a role created through BASE_URL must be read back via REG_LOCAL_CORE_URL', async ({}, testInfo) => {
    const env: NodeJS.ProcessEnv = { ...LOCAL, REG_STATE_DIR: testInfo.outputPath('state'), REG_RUN_ID: 'qa-reg-20261014-100000-ab12', AUTH_CLIENT_CERT: 'cert%2B' };
    const role = { uuid: '00000000-0000-4000-8000-0000000000aa', name: 'qa-reg-20261014-100000-ab12-instance-x' };
    let created = 0;
    const createRole = async () => {
        created++;
        return role;
    };
    const headers: Array<Record<string, string> | undefined> = [];
    const core = (roleAnswer: HttpProbeResult): HttpProbe => (url, h) => {
        if (url.endsWith('/api/v1/info')) return { ok: true, status: 200, body: INFO };
        headers.push(h);
        return url === `http://localhost:8280/api/v1/roles/${role.uuid}` ? roleAnswer : { ok: false, status: 404 };
    };
    // The container publishing the core port and the in-container read are injected (never the real docker).
    const docker = { containers: (() => ({ ok: true, container: 'c0ffee', containerPort: 8080 })) as ContainerProof, inContainer: () => ({ ok: true, status: 200, body: role }) };
    // A tunnel to a shared core of the same build: the role is not there.
    await expect(proveLocalInstance(reader(200, INFO), env, { probe: core({ ok: false, status: 404 }), createRole, ...docker })).rejects.toThrow(/not the same instance/);
    expect(hasLocalProof(env)).toBe(false);
    // Another object behind the uuid (or another name): refused too.
    await expect(proveLocalInstance(reader(200, INFO), env, { probe: core({ ok: true, status: 200, body: { uuid: role.uuid, name: 'other' } }), createRole, ...docker })).rejects.toThrow(/not the same instance/);
    // Found with the header-mode admin certificate: the proof is written.
    await proveLocalInstance(reader(200, INFO), env, { probe: core({ ok: true, status: 200, body: { uuid: role.uuid, name: role.name } }), createRole, ...docker });
    expect(hasLocalProof(env)).toBe(true);
    expect(JSON.parse(fs.readFileSync(localProofFile(env), 'utf8'))).toMatchObject({ runId: env.REG_RUN_ID, tier: tierIdentity(env), instanceRole: role.uuid });
    expect(headers.every((h) => h?.['ssl-client-cert'] === 'cert%2B'), 'the core is read with the admin certificate').toBe(true);
    expect(created).toBe(3);
    expect(hasLocalProof({ ...env, REG_RUN_ID: 'qa-reg-20261014-100000-zz99' }), 'another run id has no proof').toBe(false);
    expect(hasLocalProof({ ...env, BASE_URL: 'http://localhost:3999/' }), 'another tier has no proof').toBe(false);
    // Without the certificate the core cannot be read: refused before anything is created.
    const { AUTH_CLIENT_CERT: _c, ...noCert } = env;
    await expect(proveLocalInstance(reader(200, INFO), noCert, { probe: core({ ok: true, status: 200 }), createRole, ...docker })).rejects.toThrow(/AUTH_CLIENT_CERT is unset/);
    expect(created).toBe(3);
    expect(hasLocalProof(env), 'a refused attempt removes the earlier proof').toBe(false);
    // A shared tier: nothing is created or read.
    await proveLocalInstance(reader(200, INFO), { BASE_URL: 'https://qa.example.com' }, { createRole });
    expect(created).toBe(3);
});

test('the local-backend proof expires and is removed', ({}, testInfo) => {
    const env: NodeJS.ProcessEnv = { ...LOCAL, REG_STATE_DIR: testInfo.outputPath('state'), REG_RUN_ID: 'qa-reg-20261014-100000-ab12' };
    fs.mkdirSync(testInfo.outputPath('state'), { recursive: true });
    const write = (at: string | undefined) => fs.writeFileSync(localProofFile(env), JSON.stringify({ runId: env.REG_RUN_ID, tier: tierIdentity(env), ...(at ? { at } : {}) }));
    const now = Date.parse('2026-10-14T12:00:00.000Z');
    write(new Date(now - 60_000).toISOString());
    expect(hasLocalProof(env, now)).toBe(true);
    expect(hasLocalProof(env, now + LOCAL_PROOF_MAX_AGE_MS), 'expired').toBe(false);
    write(undefined);
    expect(hasLocalProof(env, now), 'no time: not a proof').toBe(false);
    write(new Date(now + 60 * 60_000).toISOString());
    expect(hasLocalProof(env, now), 'from the future').toBe(false);
    write(new Date(now).toISOString());
    removeLocalProof(env);
    expect(fs.existsSync(localProofFile(env))).toBe(false);
    expect(() => removeLocalProof(env), 'removing a missing proof is fine').not.toThrow();
});

test('a shared tier sends no probe', () => {
    const p = probe({});
    assertLocalAllowed({ BASE_URL: 'https://qa.example.com' }, { probe: p.probe });
    expect(p.urls).toEqual([]);
});

// TIER_LOCAL_HOSTS admits a private compose host on another machine (its daemon through DOCKER_HOST), and nothing else
test('TIER_LOCAL_HOSTS admits a private compose host on another machine through DOCKER_HOST only', () => {
    const env = { TIER_KIND: 'local', TIER_LOCAL_HOSTS: ' compose-box.lan , other.lan ', REG_LOCAL_CORE_URL: 'http://compose-box.lan:8280', DOCKER_HOST: 'tcp://compose-box.lan:2376' };
    const ok = probe({ 'http://compose-box.lan:8280/api/v1/info': { ok: true, status: 200, body: INFO } });
    const lan = resolver({ 'compose-box.lan': ['192.168.1.20'], 'other.lan': ['10.1.2.3'] });
    const opts = { probe: ok.probe, resolve: lan, containers: containersOk, interfaces: () => ['127.0.0.1'], dockerContext: localSocket };
    expect(() => assertLocalAllowed({ ...env, BASE_URL: 'http://compose-box.lan:3080' }, opts)).not.toThrow();
    expect(() => assertLocalAllowed({ ...env, BASE_URL: 'https://qa.example.com' }, opts)).toThrow(/loopback/);
});

// TIER_LOCAL_HOSTS with a public name is refused; only RFC 1918 / link-local / loopback literals or names resolving to them count
test('TIER_LOCAL_HOSTS with a public name is refused; only private, link-local or loopback count', () => {
    const table = resolver({ 'shared.example.com': ['203.0.113.10'], 'mixed.lan': ['192.168.1.5', '198.51.100.7'], 'box.lan': ['192.168.1.5'], 'v6.lan': ['fe80::1'] });
    const listed = (h: string) => ({ TIER_LOCAL_HOSTS: h });
    expect(isLocalHost('shared.example.com', listed('shared.example.com'), { resolve: table }), 'a public name').toBe(false);
    expect(isLocalHost('mixed.lan', listed('mixed.lan'), { resolve: table }), 'one public address is enough to refuse').toBe(false);
    expect(isLocalHost('unknown.lan', listed('unknown.lan'), { resolve: table }), 'a name that does not resolve').toBe(false);
    expect(isLocalHost('203.0.113.10', listed('203.0.113.10'), { resolve: table }), 'a public literal').toBe(false);
    expect(isLocalHost('box.lan', listed('box.lan'), { resolve: table })).toBe(true);
    expect(isLocalHost('v6.lan', listed('v6.lan'), { resolve: table })).toBe(true);
    expect(isLocalHost('10.0.0.5', listed('10.0.0.5'), { resolve: table })).toBe(true);
    expect(isLocalHost('box.lan', {}, { resolve: table }), 'a private name still has to be listed').toBe(false);
    const env = { ...LOCAL, TIER_LOCAL_HOSTS: 'shared.example.com', BASE_URL: 'https://shared.example.com', REG_LOCAL_CORE_URL: 'https://shared.example.com' };
    expect(() => assertLocalAllowed(env, { probe: coreUp().probe, resolve: table, containers: containersOk, dockerContext: localSocket })).toThrow(/private \(RFC 1918 \/ link-local\) host/);
    expect(() => assertAuthModeAllowed({ AUTH_MODE: 'header', BASE_URL: 'https://shared.example.com', TIER_LOCAL_HOSTS: 'shared.example.com' }, { resolve: table })).toThrow(/AUTH_MODE=header/);
    for (const a of ['10.1.1.1', '172.16.0.1', '172.31.255.255', '192.168.0.1', '169.254.1.1', '127.0.0.2', '::1', 'fe80::abcd', '::ffff:192.168.1.1']) expect(isPrivateAddress(a), a).toBe(true);
    for (const a of ['172.32.0.1', '100.64.0.1', '203.0.113.10', 'fd00::1', '2001:db8::1', '::ffff:192.0.2.1']) expect(isPrivateAddress(a), a).toBe(false);
});

test('the guard messages never echo BASE_URL, REG_LOCAL_CORE_URL or a TIER_LOCAL_HOSTS entry', () => {
    expect(() => assertLocalAllowed({ TIER_KIND: 'local', BASE_URL: 'https://secret-host.example.com' }, proofOk())).toThrow(/^(?!.*secret-host).*$/s);
    expect(() => assertLocalAllowed({ ...LOCAL, REG_LOCAL_CORE_URL: 'https://secret-core.example.com' }, proofOk())).toThrow(/^(?!.*secret-core).*$/s);
    expect(() => assertLocalAllowed({ ...LOCAL }, proofOk({ probe: probe({}).probe }))).toThrow(/^(?!.*localhost:8280).*$/s);
    expect(() => assertLocalAllowed({ ...LOCAL, TIER_LOCAL_HOSTS: 'secret-lan.example', BASE_URL: 'http://secret-lan.example' }, proofOk())).toThrow(/^(?!.*secret-lan).*$/s);
});

test('AUTH_MODE=header only for a loopback / private TIER_LOCAL_HOSTS BASE_URL', () => {
    const lan = resolver({ 'box.lan': ['192.168.1.9'] });
    expect(() => assertAuthModeAllowed({ AUTH_MODE: 'header', BASE_URL: 'http://localhost:3000' })).not.toThrow();
    expect(() => assertAuthModeAllowed({ AUTH_MODE: 'header', BASE_URL: 'http://box.lan:3000', TIER_LOCAL_HOSTS: 'box.lan' }, { resolve: lan })).not.toThrow();
    expect(() => assertAuthModeAllowed({ AUTH_MODE: 'header', BASE_URL: 'https://qa.example.com' })).toThrow(/AUTH_MODE=header/);
    expect(() => assertAuthModeAllowed({ AUTH_MODE: 'header' })).toThrow(/AUTH_MODE=header/);
    expect(() => assertAuthModeAllowed({ AUTH_MODE: 'local', BASE_URL: 'https://qa.example.com' })).not.toThrow();
    expect(() => assertAuthModeAllowed({ BASE_URL: 'https://qa.example.com' })).not.toThrow();
});

test('freezeTierEnv always sets TIER_KIND, AUTH_MODE and REG_RA_PROFILE_NAME', () => {
    const env: NodeJS.ProcessEnv = {};
    freezeTierEnv(env);
    expect(env).toEqual({ TIER_KIND: 'shared', AUTH_MODE: 'local', REG_RA_PROFILE_NAME: '' });
    const odd: NodeJS.ProcessEnv = { TIER_KIND: 'Local', AUTH_MODE: 'oidc', REG_RA_PROFILE_NAME: 'EJBCA RA' };
    freezeTierEnv(odd);
    expect(odd).toEqual({ TIER_KIND: 'shared', AUTH_MODE: 'oidc', REG_RA_PROFILE_NAME: 'EJBCA RA' });
});

test('assertRunTier: TIER_KIND must be frozen, BASE_URL unchanged since the config loaded', () => {
    expect(() => assertRunTier({ BASE_URL: 'https://qa.example.com' })).toThrow(/not frozen/);
    const env = { TIER_KIND: 'shared', BASE_URL: 'https://qa.example.com', REG_TIER_ID: tierIdentity({ BASE_URL: 'https://qa.example.com' }) };
    expect(() => assertRunTier(env)).not.toThrow();
    expect(() => assertRunTier({ ...env, BASE_URL: 'https://other.example.com' })).toThrow(/BASE_URL changed/);
    expect(() => assertRunTier({ ...LOCAL }, proofOk({ probe: probe({}).probe }))).toThrow(/did not answer/);
});

test('the tier identity is a short hash of the host (with port), never the host itself', () => {
    const a = tierIdentity({ BASE_URL: 'https://qa.example.com/administrator/' })!;
    expect(a).toMatch(/^[0-9a-f]{12}$/);
    expect(tierIdentity({ BASE_URL: 'https://QA.example.com' })).toBe(a);
    expect(tierIdentity({ BASE_URL: 'https://qa.example.com:8443' })).not.toBe(a);
    expect(tierIdentity({})).toBeUndefined();
    expect(tierIdentity({ BASE_URL: 'nonsense' })).toBeUndefined();
});

test('describeLocalOnly skips on a shared tier, and on a local one without this run\'s local-backend proof', ({}, testInfo) => {
    const calls: Array<[boolean, string | undefined]> = [];
    const fake = {
        skip: (condition: boolean | (() => boolean), description?: string) => void calls.push([typeof condition === 'function' ? condition() : condition, description]),
    };
    const local: NodeJS.ProcessEnv = { ...LOCAL, REG_STATE_DIR: testInfo.outputPath('state'), REG_RUN_ID: 'qa-reg-20261014-100000-cd34' };
    describeLocalOnly(fake, {});
    describeLocalOnly(fake, local);
    fs.mkdirSync(testInfo.outputPath('state'), { recursive: true });
    fs.writeFileSync(localProofFile(local), JSON.stringify({ runId: local.REG_RUN_ID, tier: tierIdentity(local), at: new Date().toISOString() }));
    describeLocalOnly(fake, local);
    expect(calls).toEqual([
        [true, 'local stack only (TIER_KIND=local)'],
        [true, expect.stringMatching(/no authenticated local-backend proof/)],
        [false, 'local stack only (TIER_KIND=local)'],
        [true, expect.stringMatching(/no authenticated local-backend proof/)],
        [false, 'local stack only (TIER_KIND=local)'],
        [false, expect.stringMatching(/no authenticated local-backend proof/)],
    ]);
});
