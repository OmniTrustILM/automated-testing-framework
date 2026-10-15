/**
 * B0 fix pass 4 — the container proof binds the INSTANCE, not just a port (round-4 minor), and the rev4/tier probes:
 * - the bind address of the published port is parsed: a loopback core only counts 0.0.0.0, [::], 127.x, ::1;
 * - the docker endpoint is DOCKER_HOST, else the current docker context (`docker context inspect`), and the host rule
 *   applies to it; a TCP / SSH endpoint on loopback (`tcp://localhost:2375`, indistinguishable from an `ssh -L`
 *   tunnel) counts only when its daemon ID equals the local socket's;
 * - the instance proof ends with an in-container round trip: the container that publishes the core port reads the
 *   proof role through ITS OWN port (`docker exec`), injectable; the default command line is checked with a fake
 *   REG_DOCKER_BIN (the admin certificate travels in the exec environment, never in argv);
 * - unit tests never run the real docker (REG_UNIT_NO_DOCKER, set by playwright.unit.config.ts);
 * - `node -e` gets `--` before its arguments (a host / URL starting with `-` is never a node option).
 * Every seam is injected or a fake: no docker, no ILM environment.
 */
import { expect, request, test } from '@playwright/test';
import * as fs from 'fs';
import * as path from 'path';
import { guardApiForUnitTests } from '../../utils/regression/guardedApi';
import { OwnObjectViolation } from '../../utils/regression/ownObjects';
import {
    assertLocalAllowed, bindRule, ContainerProof, containerPublishes, DaemonIdReader, dockerContainerProof, dockerContextEndpoint, dockerDaemonId,
    dockerExecProbe, hasLocalProof, httpProbeSync, InContainerProbe, isLoopbackHost, localProofFile, LocalProofOptions, Probe, ProbeResult,
    proveLocalInstance, publishedBindings, tierIdentity, tierKind,
} from '../../utils/regression/tier';
import { loopbackServer } from './helpers/loopbackServer';

const RUN = 'qa-reg-20261014-120000-zz99';
const MARKER = { app: { version: '3.0.0' }, build: { commitId: 'abc123', timestamp: '2026-10-14T00:00:00Z' } };
const okProbe: Probe = () => ({ ok: true, status: 200, body: MARKER });
const localSocket = () => ({ host: 'unix:///var/run/docker.sock' });
const containerOk: ContainerProof = () => ({ ok: true, container: 'c0ffee', containerPort: 8080 });
const env = (extra: Record<string, string> = {}): NodeJS.ProcessEnv => ({
    TIER_KIND: 'local', BASE_URL: 'http://localhost:3080', REG_LOCAL_CORE_URL: 'http://localhost:8280', AUTH_CLIENT_CERT: 'CERT', REG_RUN_ID: RUN, ...extra,
});
const verdict = (f: () => unknown): string => {
    try {
        f();
        return 'pass';
    } catch (e) {
        return `refused: ${(e as Error).message}`;
    }
};

test('bind addresses: a loopback core counts 0.0.0.0, [::], 127.x and ::1 only; a private core its own address or every interface', () => {
    expect(publishedBindings('0.0.0.0:8280->8080/tcp, [::]:8280->8080/tcp, :::8281->8080/tcp, 192.168.1.10:8282->8080/tcp, 127.0.0.1:8000-8001->9000-9001/tcp, 5432/tcp')).toEqual([
        { address: '0.0.0.0', hostPort: 8280, containerPort: 8080 }, { address: '::', hostPort: 8280, containerPort: 8080 },
        { address: '::', hostPort: 8281, containerPort: 8080 }, { address: '192.168.1.10', hostPort: 8282, containerPort: 8080 },
        { address: '127.0.0.1', hostPort: 8000, containerPort: 9000 }, { address: '127.0.0.1', hostPort: 8001, containerPort: 9001 },
    ]);
    const loop = bindRule('localhost');
    expect(['0.0.0.0', '::', '[::]', '127.0.0.1', '127.3.2.1', '::1'].map(loop)).toEqual([true, true, true, true, true, true]);
    expect(['192.168.1.10', '10.0.0.5', 'fe80::1'].map(loop)).toEqual([false, false, false]);
    const lan = bindRule('192.168.1.20', ['192.168.1.20']);
    expect(['0.0.0.0', '192.168.1.20', '127.0.0.1', '192.168.1.21'].map(lan)).toEqual([true, true, false, false]);
    const rows = [{ ID: 'aaa', Ports: '192.168.1.10:8280->8080/tcp' }, { ID: 'bbb', Ports: '127.0.0.1:8280->8080/tcp' }];
    expect(containerPublishes(rows, 8280, undefined, loop)).toBe(true);
    expect(containerPublishes([rows[0]], 8280, undefined, loop), 'bound to a LAN interface only: loopback is not served').toBe(false);
});

test('rev4/tier: the config-level probes T0–T15 (seams injected, never docker)', () => {
    const base: LocalProofOptions = { probe: okProbe, containers: containerOk, interfaces: () => [], resolve: () => ({ addresses: ['127.0.0.1'] }), dockerContext: localSocket };
    const sameDaemon: DaemonIdReader = () => ({ id: 'DAEMON-1' });
    const otherDaemon: DaemonIdReader = (endpoint) => ({ id: endpoint.startsWith('unix:') ? 'LOCAL' : 'REMOTE' });
    const rows: Array<[string, () => unknown, RegExp | 'pass']> = [
        ['T0 loopback + same build + container', () => assertLocalAllowed(env(), base), 'pass'],
        ['T1 no container', () => assertLocalAllowed(env(), { ...base, containers: () => ({ ok: false, error: 'none' }) }), /no container proof/],
        ['T2 version-only marker', () => assertLocalAllowed(env(), { ...base, probe: () => ({ ok: true, status: 200, body: { app: { version: '3.0.0' } } }) }), /build marker/],
        ['T3 BASE_URL build differs', () => assertLocalAllowed(env(), { ...base, probe: (u) => ({ ok: true, status: 200, body: u.includes('3080') ? { app: { version: '3.0.0' }, build: { commitId: 'OTHER' } } : MARKER }) }),
            /different core build/],
        ['T4 remote private core + an unrelated local container (the context is the local socket)',
            () => assertLocalAllowed(env({ REG_LOCAL_CORE_URL: 'http://192.168.1.50:8280', TIER_LOCAL_HOSTS: '192.168.1.50' }), { ...base, interfaces: () => ['192.168.1.10'] }),
            /not an address of this machine/],
        ['T4b the same through a docker CONTEXT pointing at another machine',
            () => assertLocalAllowed(env({ REG_LOCAL_CORE_URL: 'http://192.168.1.50:8280', TIER_LOCAL_HOSTS: '192.168.1.50' }),
                { ...base, interfaces: () => ['192.168.1.10'], dockerContext: () => ({ host: 'tcp://192.168.1.99:2376' }) }), /not point at that host/],
        ['T5 remote private core, DOCKER_HOST at that host',
            () => assertLocalAllowed(env({ REG_LOCAL_CORE_URL: 'http://192.168.1.50:8280', TIER_LOCAL_HOSTS: '192.168.1.50', DOCKER_HOST: 'tcp://192.168.1.50:2375' }),
                { ...base, interfaces: () => ['192.168.1.10'] }), 'pass'],
        ['T5b remote private core, the docker CONTEXT at that host',
            () => assertLocalAllowed(env({ REG_LOCAL_CORE_URL: 'http://192.168.1.50:8280', TIER_LOCAL_HOSTS: '192.168.1.50' }),
                { ...base, interfaces: () => ['192.168.1.10'], dockerContext: () => ({ host: 'ssh://qa@192.168.1.50' }) }), 'pass'],
        ['T6 remote private core, DOCKER_HOST at another host',
            () => assertLocalAllowed(env({ REG_LOCAL_CORE_URL: 'http://192.168.1.50:8280', TIER_LOCAL_HOSTS: '192.168.1.50', DOCKER_HOST: 'tcp://192.168.1.99:2375' }),
                { ...base, interfaces: () => ['192.168.1.10'] }), /DOCKER_HOST does not point/],
        ['T7 loopback core, DOCKER_HOST=ssh://remote', () => assertLocalAllowed(env({ DOCKER_HOST: 'ssh://qa@10.0.0.7' }), { ...base, resolve: () => ({ addresses: ['10.0.0.7'] }) }),
            /DOCKER_HOST points at another daemon/],
        ['T7c loopback core, a docker CONTEXT at a remote ssh daemon', () => assertLocalAllowed(env(), { ...base, dockerContext: () => ({ host: 'ssh://qa@10.0.0.7' }), resolve: () => ({ addresses: ['10.0.0.7'] }) }),
            /current docker context points at another daemon/],
        ['T7b DOCKER_HOST=tcp://localhost:2375 (an ssh -L tunnel looks the same), daemon not proven local',
            () => assertLocalAllowed(env({ DOCKER_HOST: 'tcp://localhost:2375' }), { ...base, daemonId: otherDaemon }), /TCP \/ SSH endpoint on loopback/],
        ['T7b\' the same with an unreadable daemon ID', () => assertLocalAllowed(env({ DOCKER_HOST: 'tcp://127.0.0.1:2375' }), { ...base, daemonId: () => ({ error: 'docker info exited 1' }) }),
            /docker info exited 1/],
        ['T7b\'\' DOCKER_HOST=tcp://localhost:2375 whose daemon IS the local socket\'s', () => assertLocalAllowed(env({ DOCKER_HOST: 'tcp://localhost:2375' }), { ...base, daemonId: sameDaemon }), 'pass'],
        ['T7d a CONTEXT at ssh://localhost:2222, daemon not proven local', () => assertLocalAllowed(env(), { ...base, dockerContext: () => ({ host: 'ssh://qa@localhost:2222' }), daemonId: otherDaemon }),
            /current docker context is a TCP \/ SSH endpoint on loopback/],
        ['T7e the docker context cannot be read', () => assertLocalAllowed(env(), { ...base, dockerContext: () => ({ error: 'docker context inspect exited 1' }) }), /current docker context could not be read/],
        ['T8 private core on THIS machine\'s address', () => assertLocalAllowed(env({ REG_LOCAL_CORE_URL: 'http://192.168.1.10:8280', TIER_LOCAL_HOSTS: '192.168.1.10' }),
            { ...base, interfaces: () => ['192.168.1.10'] }), 'pass'],
        ['T9 a public core host listed in TIER_LOCAL_HOSTS', () => assertLocalAllowed(env({ REG_LOCAL_CORE_URL: 'http://203.0.113.8:8280', TIER_LOCAL_HOSTS: '203.0.113.8' }), { ...base, interfaces: () => ['203.0.113.8'] }),
            /REG_LOCAL_CORE_URL is not a loopback/],
        ['T10 a core name resolving private + public', () => assertLocalAllowed(env({ REG_LOCAL_CORE_URL: 'http://core.corp.example:8280', TIER_LOCAL_HOSTS: 'core.corp.example' }),
            { ...base, resolve: () => ({ addresses: ['10.0.0.5', '198.51.100.34'] }) }), /REG_LOCAL_CORE_URL is not a loopback/],
        ['T11 BASE_URL foo.localhost resolving to 10.0.0.9', () => assertLocalAllowed(env({ BASE_URL: 'http://foo.localhost:3080' }), { ...base, resolve: () => ({ addresses: ['10.0.0.9'] }) }), /loopback/],
        ['T12 BASE_URL foo.localhost resolving to 127.0.0.1', () => assertLocalAllowed(env({ BASE_URL: 'http://foo.localhost:3080' }), base), 'pass'],
        ['T13 TIER_KIND=shared: nothing is checked', () => assertLocalAllowed({ ...env(), TIER_KIND: 'shared' }, {}), 'pass'],
    ];
    const wrong: string[] = [];
    for (const [name, f, want] of rows) {
        const got = verdict(f);
        if (want === 'pass' ? got !== 'pass' : !(got.startsWith('refused') && want.test(got))) wrong.push(`${name}: ${got.slice(0, 220)}`);
    }
    expect(wrong).toEqual([]);
    // T14 / T15: only the exact value switches; loopback spellings are judged strictly (an odd spelling is refused, never trusted).
    expect([tierKind({ TIER_KIND: 'LOCAL' }), tierKind({ TIER_KIND: ' local' }), tierKind({ TIER_KIND: 'local' })]).toEqual(['shared', 'shared', 'local']);
    expect(['http://localhost.:3080', 'http://0.0.0.0:3080', 'http://[::ffff:7f00:1]:3080', 'http://127.1:3080', 'http://[::1]:3080'].map((u) => isLoopbackHost(new URL(u).hostname)))
        .toEqual([false, false, false, true, true]);
});

test('rev4/tier: the instance proof P1–P8, ending with the in-container round trip (seams injected)', async ({}, testInfo) => {
    const e = env({ REG_STATE_DIR: testInfo.outputPath('state') });
    const role = { uuid: '11111111-2222-4333-8444-555555555555', name: `${RUN}-instance-x` };
    const reader = (marker: unknown) => ({ get: async () => ({ ok: () => true, status: () => 200, json: async () => marker }) });
    let created = 0;
    const createRole = async () => {
        created++;
        return role;
    };
    const roleUrl = (u: string) => u.includes('/api/v1/roles/');
    const coreWith = (answer: ProbeResult): Probe => (u) => (roleUrl(u) ? answer : { ok: true, status: 200, body: MARKER });
    const insideCalls: Array<[string, string, Record<string, string>]> = [];
    const inside = (answer: ProbeResult): InContainerProbe => (c, u, h) => {
        insideCalls.push([c, u, h]);
        return answer;
    };
    const found = { ok: true, status: 200, body: role };
    const prove = (e2: NodeJS.ProcessEnv, probe: Probe, extra: Partial<LocalProofOptions> = {}, marker: unknown = MARKER) =>
        proveLocalInstance(reader(marker), e2, { probe, createRole, containers: containerOk, inContainer: inside(found), ...extra });
    const rows: Array<[string, () => Promise<unknown>, RegExp | 'proven']> = [
        ['P1 a tunnel to a shared core, another local core: the role is not at the core', () => prove(e, coreWith({ ok: false, status: 404 })), /not the same instance/],
        ['P3 found, another name', () => prove(e, coreWith({ ok: true, status: 200, body: { uuid: role.uuid, name: 'other' } })), /not the same instance/],
        ['P4 200 with another uuid', () => prove(e, coreWith({ ok: true, status: 200, body: { uuid: 'x', name: role.name } })), /not the same instance/],
        ['P5 AUTH_CLIENT_CERT unset', () => prove({ ...e, AUTH_CLIENT_CERT: '' }, coreWith(found)), /AUTH_CLIENT_CERT is unset/],
        ['P6 BASE_URL\'s marker differs from the core\'s', () => prove(e, coreWith(found), {}, { app: { version: '3.0.0' }, build: { commitId: 'OTHER' } }), /different core build/],
        ['P8a the core answers, but the container does not serve the role through its own port', () => prove(e, coreWith(found), { inContainer: inside({ ok: false, status: 404 }) }),
            /does not serve the role through its own port/],
        ['P8b the container answers another object', () => prove(e, coreWith(found), { inContainer: inside({ ok: true, status: 200, body: { uuid: role.uuid, name: 'other' } }) }),
            /does not serve the role/],
        ['P8c no container can be named', () => prove(e, coreWith(found), { containers: () => ({ ok: true }) }), /could not be named/],
        ['P8d no curl / wget in the container', () => prove(e, coreWith(found), { inContainer: inside({ ok: false, error: 'docker exec exited 127 (no curl or wget in the core container)' }) }),
            /no curl or wget/],
        ['P2 the same instance: core and container both serve the role', () => prove(e, coreWith(found)), 'proven'],
    ];
    const wrong: string[] = [];
    for (const [name, f, want] of rows) {
        let got = 'proven';
        try {
            await f();
        } catch (err) {
            got = `refused: ${(err as Error).message}`;
        }
        const ok = want === 'proven' ? got === 'proven' && hasLocalProof(e) : got.startsWith('refused') && want.test(got) && !hasLocalProof(e);
        if (!ok) wrong.push(`${name}: ${got.slice(0, 200)}`);
    }
    expect(wrong).toEqual([]);
    // The last in-container read: the container's own port on 127.0.0.1, the admin certificate as a header.
    expect(insideCalls.at(-1)).toEqual(['c0ffee', `http://127.0.0.1:8080/api/v1/roles/${role.uuid}`, { 'ssl-client-cert': 'CERT' }]);
    // A core URL with a path prefix and https keeps both inside the container.
    insideCalls.length = 0;
    await prove({ ...e, REG_LOCAL_CORE_URL: 'https://localhost:8443/core/' }, coreWith(found));
    expect(insideCalls[0][1]).toBe(`https://127.0.0.1:8080/core/api/v1/roles/${role.uuid}`);
    // P7 a shared tier: nothing is created or read.
    const before = created;
    await proveLocalInstance(reader(MARKER), { ...e, TIER_KIND: 'shared' }, { createRole, probe: () => { throw new Error('no probe expected'); } });
    expect(created).toBe(before);
});

test('rev4/tier: stale, foreign and corrupt proofs never count', ({}, testInfo) => {
    const e = env({ REG_STATE_DIR: testInfo.outputPath('state') });
    fs.mkdirSync(testInfo.outputPath('state'), { recursive: true });
    const now = Date.now();
    const tier = tierIdentity(e);
    const write = (p: unknown) => fs.writeFileSync(localProofFile(e), typeof p === 'string' ? p : JSON.stringify(p));
    const cases: Array<[string, unknown, boolean, NodeJS.ProcessEnv?]> = [
        ['fresh', { runId: RUN, tier, at: new Date(now).toISOString() }, true],
        ['7 h old', { runId: RUN, tier, at: new Date(now - 7 * 3600e3).toISOString() }, false],
        ['5 h 59 min old', { runId: RUN, tier, at: new Date(now - (6 * 3600e3 - 60e3)).toISOString() }, true],
        ['from the future (+1 h)', { runId: RUN, tier, at: new Date(now + 3600e3).toISOString() }, false],
        ['another run id inside', { runId: 'qa-reg-20261014-120000-aaaa', tier, at: new Date(now).toISOString() }, false],
        ['another tier inside', { runId: RUN, tier: 'deadbeef0000', at: new Date(now).toISOString() }, false],
        ['no tier', { runId: RUN, at: new Date(now).toISOString() }, false],
        ['no time', { runId: RUN, tier }, false],
        ['garbage time', { runId: RUN, tier, at: 'yesterday' }, false],
        ['corrupt file', '{not json', false],
        ['fresh, but another BASE_URL host', { runId: RUN, tier, at: new Date(now).toISOString() }, false, { ...e, BASE_URL: 'http://localhost:9999' }],
        ['fresh, but BASE_URL unset', { runId: RUN, tier, at: new Date(now).toISOString() }, false, { ...e, BASE_URL: undefined }],
    ];
    for (const [name, proof, want, e2] of cases) {
        write(proof);
        expect(hasLocalProof(e2 ?? e, now), name).toBe(want);
    }
});

test('rev4/tier: localStack lifts the platform deny-list only on TIER_KIND=local exactly, with this run\'s proof (wire)', async ({}, testInfo) => {
    const core = await loopbackServer();
    const raw = await request.newContext({ baseURL: core.origin });
    try {
        const e = env({ BASE_URL: core.origin, REG_STATE_DIR: testInfo.outputPath('state') });
        fs.mkdirSync(testInfo.outputPath('state'), { recursive: true });
        fs.writeFileSync(localProofFile(e), JSON.stringify({ runId: RUN, tier: tierIdentity(e), at: new Date().toISOString() }));
        const attempt = async (e2: NodeJS.ProcessEnv) => {
            core.reset();
            const g = guardApiForUnitTests(raw, { localStack: true, env: e2, lines: [], runId: RUN, tier: null });
            try {
                await g.put('/api/v1/settings/platform', { data: {} });
            } catch (err) {
                return `refused ${(err as OwnObjectViolation).kind}`;
            }
            return core.mutations().map((a) => `${a.method} ${a.url}`).join(',');
        };
        expect(await attempt({ ...e, TIER_KIND: 'shared' }), 'shared + a fresh proof file').toBe('refused request');
        expect(await attempt({ ...e, TIER_KIND: 'Local' }), 'TIER_KIND=Local').toBe('refused request');
        expect(await attempt({ ...e, TIER_KIND: ' local' }), 'TIER_KIND=" local"').toBe('refused request');
        expect(await attempt({ ...e, REG_RUN_ID: 'qa-reg-20261014-120000-aaaa' }), 'another run id').toBe('refused request');
        expect(await attempt(e), 'local + this run\'s fresh proof').toBe('PUT /api/v1/settings/platform');
    } finally {
        await raw.dispose();
        await core.close();
    }
});

/** A fake docker CLI that records argv and the REG_PROOF_CERT it got, and answers like docker would. */
function recordingDocker(dir: string): { bin: string; calls: () => Array<{ argv: string[]; cert?: string; dockerHost?: string }> } {
    fs.mkdirSync(dir, { recursive: true });
    const log = path.join(dir, 'calls.jsonl');
    const bin = path.join(dir, 'fake-docker');
    fs.writeFileSync(bin, `#!${process.execPath}
const fs = require('fs');
const a = process.argv.slice(2);
fs.appendFileSync(${JSON.stringify(log)}, JSON.stringify({ argv: a, cert: process.env.REG_PROOF_CERT, dockerHost: process.env.DOCKER_HOST }) + '\\n');
if (a[0] === 'context') process.stdout.write(JSON.stringify([{ Name: 'colima', Endpoints: { docker: { Host: 'unix:///Users/qa/.colima/default/docker.sock' } } }]));
else if (a[0] === 'ps') process.stdout.write(JSON.stringify({ ID: 'lan', Ports: '192.168.1.10:8280->8080/tcp' }) + '\\n' + JSON.stringify({ ID: 'c0ffee', Ports: '0.0.0.0:8280->8081/tcp' }) + '\\n');
else if (a[0] === '-H') process.stdout.write('DAEMON-' + (a[1].startsWith('unix') ? 'L' : 'T') + '\\n');
else if (a[0] === 'exec') process.stdout.write(JSON.stringify({ uuid: 'u', name: 'n', url: a[a.length - 1] }));
else process.exit(2);
`);
    fs.chmodSync(bin, 0o755);
    return { bin, calls: () => (fs.existsSync(log) ? fs.readFileSync(log, 'utf8').trim().split('\n').map((l) => JSON.parse(l)) : []) };
}

test('the default docker seams, run against a fake CLI: their command lines, and the certificate never in argv', ({}, testInfo) => {
    const fake = recordingDocker(testInfo.outputPath('bin'));
    const e: NodeJS.ProcessEnv = { REG_DOCKER_BIN: fake.bin, DOCKER_HOST: 'tcp://localhost:2375' };
    expect(dockerContextEndpoint(e)).toEqual({ host: 'unix:///Users/qa/.colima/default/docker.sock' });
    expect(dockerContainerProof(8280, undefined, e, { bindOk: bindRule('localhost') }), 'the LAN-only binding is skipped').toEqual({ ok: true, container: 'c0ffee', containerPort: 8081 });
    expect(dockerDaemonId('tcp://localhost:2375', e)).toEqual({ id: 'DAEMON-T' });
    expect(dockerDaemonId('unix:///var/run/docker.sock', e)).toEqual({ id: 'DAEMON-L' });
    const inside = dockerExecProbe('c0ffee', 'http://127.0.0.1:8081/api/v1/roles/u', { 'ssl-client-cert': 'SECRET-CERT' }, e);
    expect(inside).toEqual({ ok: true, status: 200, body: { uuid: 'u', name: 'n', url: 'http://127.0.0.1:8081/api/v1/roles/u' } });
    const calls = fake.calls();
    expect(calls.map((c) => c.argv.slice(0, 4))).toEqual([
        ['context', 'inspect'], ['ps', '--format', '{{json .}}'], ['-H', 'tcp://localhost:2375', 'info', '--format'], ['-H', 'unix:///var/run/docker.sock', 'info', '--format'],
        ['exec', '-e', 'REG_PROOF_CERT', 'c0ffee'],
    ]);
    const exec = calls[4];
    expect(exec.argv.slice(4, 6)).toEqual(['sh', '-c']);
    expect(exec.argv.slice(-2)).toEqual(['sh', 'http://127.0.0.1:8081/api/v1/roles/u']);
    expect(exec.argv.join(' '), 'the certificate is not on the command line').not.toContain('SECRET-CERT');
    expect(exec.cert, 'it travels in the exec environment').toBe('SECRET-CERT');
    expect(calls[2].dockerHost, 'docker -H decides the endpoint: DOCKER_HOST is removed for the ID read').toBeUndefined();
});

test('unit tests never run the real docker; node -e gets `--` before its arguments', () => {
    expect(process.env.REG_UNIT_NO_DOCKER).toBe('1');
    expect(dockerContainerProof(8280, undefined, {})).toEqual({ ok: false, error: expect.stringMatching(/real docker CLI is disabled under the unit tests/) });
    expect(dockerContextEndpoint({}).error).toMatch(/disabled under the unit tests/);
    expect(dockerDaemonId('unix:///x', {}).error).toMatch(/disabled under the unit tests/);
    expect(dockerExecProbe('c', 'http://127.0.0.1:1/x', {}, {}).error).toMatch(/disabled under the unit tests/);
    // Without `--`, `node -e <script> --version` prints node's version instead of running the script with that argument.
    const r = httpProbeSync('--version');
    expect(r.ok).toBe(false);
    expect(r.error, 'the script ran and failed to parse the URL; node did not take it as an option').not.toBe('unreadable probe output');
    expect(String(r.error)).toMatch(/URL|Invalid|parse/i);
});
