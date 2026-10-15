/**
 * tier — which kind of environment a run talks to, and the guards that keep destructive `@local` rows off shared tiers.
 *
 * - `tierKind()`: `TIER_KIND=local` means a disposable local stack; anything else, including unset, means a shared
 *   tier (the safe default). The configs freeze the value after loading the env file (`freezeTierEnv`, review R3), so a
 *   later dotenv load (utils/env.ts in a worker, a stray `.env` in the working directory) can never switch it.
 * - Local hosts (review Q4): `localhost`, 127.0.0.0/8 and ::1 always; a `*.localhost` name only when it RESOLVES to
 *   loopback addresses only (B0 fix pass 3: resolved like any other name, never trusted by its suffix); a host listed
 *   in TIER_LOCAL_HOSTS only when it IS an RFC 1918 / link-local / loopback address or RESOLVES only to such addresses
 *   (the lookup runs in a child process at config load and is injectable). A public name or address is refused.
 * - `assertLocalAllowed()` (config load, synchronous): `TIER_KIND=local` needs POSITIVE proof of a local backend
 *   (reviews R8, Q4), not only a loopback BASE_URL (a dev-server proxy, a tunnel or a port-forward can serve a loopback
 *   port from a shared core):
 *     1. BASE_URL is a local host (above);
 *     2. REG_LOCAL_CORE_URL (the local core itself, e.g. `http://localhost:8280`) is a local host too;
 *     3. `<core>/api/v1/info` answers with a core build marker: the version AND the commit id or the build time (a
 *        version alone matches every stack of the same release, B0 fix pass 3). No liveness-only pass;
 *     4. a container proof: `docker ps` (REG_DOCKER_BIN, else `docker`) lists a running container that publishes
 *        REG_LOCAL_CORE_URL's port ON A BIND ADDRESS THAT SERVES IT (fix pass 4: a loopback core only 0.0.0.0, [::],
 *        127.x, ::1; a private core host every-interface or its own address), and, when REG_LOCAL_COMPOSE_PROJECT is
 *        set, that container carries the compose project label. A missing docker CLI refuses the local mode
 *        (injectable for tests). The daemon must be the one of the core's machine (B0 fix pass 3): a non-loopback core
 *        host must be an address of THIS machine (`os.networkInterfaces`) or the docker endpoint must point at that
 *        host; a loopback core with an endpoint pointing at another machine is refused (an unrelated container on
 *        another daemon publishing the same port proves nothing). The endpoint is DOCKER_HOST, else the current docker
 *        context's (`docker context inspect`, fix pass 4). A TCP / SSH endpoint on loopback (`tcp://localhost:2375`,
 *        indistinguishable from an `ssh -L` tunnel) counts only when its daemon ID equals the local socket's;
 *     5. when BASE_URL's `/api/v1/info` is readable without authentication, it names the same build.
 *   The marker is kept in REG_LOCAL_CORE_MARKER. Otherwise the run stops before it lists a single test.
 * - `assertLocalBackend(api)` (the setup and the run-end teardown, asynchronous, review Q4): with the AUTHENTICATED
 *   context, read BASE_URL's `/api/v1/info` and compare its marker with a fresh read of REG_LOCAL_CORE_URL's.
 *   Unreadable, or another build ⇒ refused (fail closed).
 * - `proveLocalInstance(api, env, { createRole })` (the setup only, B0 fix pass 3, Q4 residual a): the same build is
 *   not the same instance (a tunnel to a shared core of the same build passes the marker). A run-prefixed role is
 *   created through BASE_URL (guarded, recorded; the run-end teardown deletes it) and read back through
 *   REG_LOCAL_CORE_URL with the header-mode admin certificate (AUTH_CLIENT_CERT); not found ⇒ refused. Last step (fix
 *   pass 4): the container that publishes the core port reads the role through ITS OWN port from inside
 *   (`docker exec … curl | wget`, injectable), so a published port that only forwards elsewhere cannot pass. Only then
 *   the run's local-backend proof (`<state dir>/<run id>.local-proof.json`: run id, tier, marker, time) is written. It
 *   expires after LOCAL_PROOF_MAX_AGE_MS, `prepareRun` (runner) and the run-end teardown delete it, and both
 *   `describeLocal` and the guard's `localStack` option require it (`hasLocalProof`).
 * - `assertAuthModeAllowed()`: AUTH_MODE=header (no identity provider, a dev proxy injects an admin certificate) only
 *   with a local BASE_URL (review R25).
 * - `tierIdentity()`: a hash of BASE_URL's host (never the host itself) stored in the run state, every ledger line and
 *   the snapshots; the teardown deletes only lines recorded on the same tier (review R15).
 * - `assertRunTier()` / `assertRunTierLive(api)`: the whole check again, for the run-end teardown and the setup (R3).
 * - `describeLocal(test)`: describe-level skip for `@local` specs, the second guard next to the configs' grepInvert: the
 *   rows run only with TIER_KIND=local AND this run's unexpired local-backend proof on this tier.
 *
 * Messages never echo BASE_URL, REG_LOCAL_CORE_URL or a TIER_LOCAL_HOSTS entry: reports of a run may be shared.
 */
import { spawnSync } from 'child_process';
import * as crypto from 'crypto';
import * as fs from 'fs';
import * as net from 'net';
import * as os from 'os';
import * as path from 'path';
import { currentRunId, regressionStateDir } from './runId';
import { unitDockerBinProblem } from './tools';

export type TierKind = 'local' | 'shared';

export function tierKind(env: NodeJS.ProcessEnv = process.env): TierKind {
    return env.TIER_KIND === 'local' ? 'local' : 'shared';
}

export function isLocalTier(env: NodeJS.ProcessEnv = process.env): boolean {
    return tierKind(env) === 'local';
}

const bare = (host: string): string => host.toLowerCase().replace(/^\[|\]$/g, '');

/** 127.0.0.0/8, ::1 and ::ffff:127.x (with or without brackets). */
export function isLoopbackAddress(address: string): boolean {
    const a = bare(address);
    if (net.isIPv4(a)) return a.split('.')[0] === '127';
    if (net.isIPv6(a)) {
        const mapped = /^::ffff:(\d+\.\d+\.\d+\.\d+)$/.exec(a);
        if (mapped) return isLoopbackAddress(mapped[1]);
        return a === '::1' || a === '0:0:0:0:0:0:0:1';
    }
    return false;
}

/**
 * `localhost` and loopback literals (with or without brackets). A `*.localhost` name is NOT loopback by its suffix
 * (B0 fix pass 3): `isLocalHost` resolves it and accepts it only when every address is loopback.
 */
export function isLoopbackHost(host: string): boolean {
    const h = bare(host);
    return h === 'localhost' || isLoopbackAddress(h);
}

/** RFC 1918 (10/8, 172.16/12, 192.168/16), link-local (169.254/16, fe80::/10) or loopback; false for anything else. */
export function isPrivateAddress(address: string): boolean {
    const a = bare(address);
    if (net.isIPv4(a)) {
        const [o1, o2] = a.split('.').map(Number);
        return o1 === 10 || o1 === 127 || (o1 === 172 && o2 >= 16 && o2 <= 31) || (o1 === 192 && o2 === 168) || (o1 === 169 && o2 === 254);
    }
    if (net.isIPv6(a)) {
        const mapped = /^::ffff:(\d+\.\d+\.\d+\.\d+)$/.exec(a);
        if (mapped) return isPrivateAddress(mapped[1]);
        if (a === '::1' || a === '0:0:0:0:0:0:0:1') return true;
        return /^fe[89ab][0-9a-f]:/.test(a); // fe80::/10
    }
    return false;
}

/** Extra hosts a local stack may use (TIER_LOCAL_HOSTS, comma-separated); each must still prove it is private. */
export function extraLocalHosts(env: NodeJS.ProcessEnv = process.env): string[] {
    return (env.TIER_LOCAL_HOSTS ?? '')
        .split(',')
        .map((h) => h.trim().toLowerCase())
        .filter(Boolean);
}

/** A synchronous name lookup (config load is synchronous): every address the name resolves to. Injected in tests. */
export type Resolver = (host: string) => { addresses?: string[]; error?: string };

const RESOLVE_SCRIPT = `
require('dns').lookup(process.argv[1], { all: true }, (e, a) =>
  process.stdout.write(JSON.stringify(e ? { error: String(e.code || e).slice(0, 80) } : { addresses: a.map((x) => x.address) })));
`;

const resolved = new Map<string, { addresses?: string[]; error?: string }>();

/** Default resolver: `dns.lookup(all)` in a child Node process, cached per process. */
export const dnsResolveSync: Resolver = (host) => {
    const key = host.toLowerCase();
    const hit = resolved.get(key);
    if (hit) return hit;
    // `--` ends node's own options: a host that starts with `-` is an argument, never an option (fix pass 4).
    const r = spawnSync(process.execPath, ['-e', RESOLVE_SCRIPT, '--', key], { encoding: 'utf8', timeout: 10_000 });
    let out: { addresses?: string[]; error?: string };
    try {
        out = JSON.parse(r.stdout || '{}');
    } catch {
        out = { error: 'unreadable lookup output' };
    }
    if (!out.addresses && !out.error) out = { error: r.error ? String(r.error) : 'no answer' };
    resolved.set(key, out);
    return out;
};

export interface LocalHostOptions {
    resolve?: Resolver;
}

/**
 * Loopback; or listed in TIER_LOCAL_HOSTS AND private: an RFC 1918 / link-local / loopback literal, or a name whose
 * every address is one (Q4).
 */
export function isLocalHost(host: string, env: NodeJS.ProcessEnv = process.env, opts: LocalHostOptions = {}): boolean {
    if (isLoopbackHost(host)) return true;
    const h = bare(host);
    if (h.endsWith('.localhost')) {
        // Resolved like any other name: loopback only (a resolver or /etc/hosts may map it anywhere).
        const { addresses } = (opts.resolve ?? dnsResolveSync)(h);
        return !!addresses && addresses.length > 0 && addresses.every(isLoopbackAddress);
    }
    if (!extraLocalHosts(env).map(bare).includes(h)) return false;
    if (net.isIP(h)) return isPrivateAddress(h);
    const { addresses } = (opts.resolve ?? dnsResolveSync)(h);
    return !!addresses && addresses.length > 0 && addresses.every(isPrivateAddress);
}

/** The hostname of a URL variable; the error names the variable, never its value. */
function hostOf(value: string, variable: string): string {
    try {
        return new URL(value).hostname;
    } catch {
        throw new Error(`${variable} is not a valid URL; refusing to run @local tests.`);
    }
}

// ------------------------------------------------------------------ positive proof of a local backend (R8, Q4)

export interface ProbeResult {
    ok: boolean;
    status?: number;
    body?: unknown;
    error?: string;
}

/** A synchronous GET (config load is synchronous). Injected in unit tests. */
export type Probe = (url: string, headers?: Record<string, string>) => ProbeResult;

const PROBE_SCRIPT = `
const [url, headers] = process.argv.slice(1);
fetch(url, { headers: JSON.parse(headers), redirect: 'manual', signal: AbortSignal.timeout(8000) })
  .then(async (r) => { const t = await r.text(); let b; try { b = JSON.parse(t); } catch { b = undefined; }
    process.stdout.write(JSON.stringify({ status: r.status, body: b })); })
  .catch((e) => process.stdout.write(JSON.stringify({ error: String(e && e.cause ? e.cause.code || e.cause : e).slice(0, 120) })));
`;

/** Default probe: one GET in a child Node process (8 s timeout; a local stack's self-signed TLS is accepted). */
export const httpProbeSync: Probe = (url, headers = {}) => {
    const r = spawnSync(process.execPath, ['-e', PROBE_SCRIPT, '--', url, JSON.stringify(headers)], {
        encoding: 'utf8',
        timeout: 15_000,
        env: { ...process.env, NODE_TLS_REJECT_UNAUTHORIZED: '0', NODE_NO_WARNINGS: '1' },
    });
    try {
        const out = JSON.parse(r.stdout || '{}') as { status?: number; body?: unknown; error?: string };
        if (out.status === undefined) return { ok: false, error: out.error ?? (r.error ? String(r.error) : 'no answer') };
        return { ok: out.status >= 200 && out.status < 300, status: out.status, body: out.body };
    } catch {
        return { ok: false, error: 'unreadable probe output' };
    }
};

const joinUrl = (base: string, rel: string): string => new URL(rel, base.endsWith('/') ? base : `${base}/`).toString();

/**
 * The fields that identify a core build in /v1/info; undefined when the body is not a core info answer or names only a
 * version (B0 fix pass 3: the commit id or the build time is required, a version alone matches every stack of a release).
 */
export function buildMarker(body: unknown): string | undefined {
    const b = body as { app?: { name?: string; version?: string }; build?: { commitId?: string; timestamp?: string } } | undefined;
    if (!b?.app?.version || !(b.build?.commitId || b.build?.timestamp)) return undefined;
    return JSON.stringify([b.app.version, b.build?.commitId ?? '', b.build?.timestamp ?? '']);
}

/** The port of a URL (the scheme's default when none is written). */
export function portOf(url: string): number {
    const u = new URL(url);
    return Number(u.port || (u.protocol === 'https:' ? 443 : 80));
}

/** One running container as `docker ps --format '{{json .}}'` prints it (the fields the proof reads). */
export interface ContainerRow {
    ID?: string;
    Names?: string;
    Ports?: string;
    Labels?: string;
}

/** One published port of a `docker ps` Ports column: the host address it binds, the host port and the container port. */
export interface PortBinding {
    address: string;
    hostPort: number;
    containerPort: number;
}

/**
 * The published ports of a `docker ps` Ports column (`0.0.0.0:8280->8080/tcp, [::]:8280->8080/tcp,
 * 127.0.0.1:8000-8002->8000-8002/tcp, :::8280->8080/tcp`), with their bind address (fix pass 4).
 */
export function publishedBindings(ports: string | undefined): PortBinding[] {
    const out: PortBinding[] = [];
    for (const part of (ports ?? '').split(',')) {
        const m = /^(.*):(\d+)(?:-(\d+))?->(\d+)(?:-\d+)?\/\w+$/.exec(part.trim());
        if (!m) continue;
        const address = bare(m[1]);
        const from = Number(m[2]);
        const to = m[3] ? Number(m[3]) : from;
        for (let p = from; p <= to && p - from < 1000; p++) out.push({ address, hostPort: p, containerPort: Number(m[4]) + (p - from) });
    }
    return out;
}

/** The host ports a `docker ps` Ports column publishes. */
export function publishedHostPorts(ports: string | undefined): number[] {
    return publishedBindings(ports).map((b) => b.hostPort);
}

/** Every-interface bind addresses (`0.0.0.0`, `::`): they serve loopback and every address of the daemon's machine. */
const ANY_ADDRESS = new Set(['0.0.0.0', '::', '0:0:0:0:0:0:0:0']);

/**
 * Which bind addresses can serve REG_LOCAL_CORE_URL (fix pass 4): a loopback core only 0.0.0.0, [::], 127.x and ::1
 * (a container bound to another interface does not answer on loopback); a private core host every-interface or one of
 * that host's own addresses.
 */
export function bindRule(coreHost: string, coreAddresses: string[] = []): (address: string) => boolean {
    const loopback = isLoopbackHost(coreHost);
    const own = new Set(coreAddresses.map(bare));
    return (address) => {
        const a = bare(address);
        return ANY_ADDRESS.has(a) || (loopback ? isLoopbackAddress(a) : own.has(a));
    };
}

export interface ContainerProofResult {
    ok: boolean;
    /** Why the proof failed (never a host name). */
    error?: string;
    /** The container publishing the core port (ID or name) and the port inside it: the in-container round trip uses them. */
    container?: string;
    containerPort?: number;
}

/** The container proof (Q4); injected in unit tests. `bindOk`: which bind addresses can serve the core URL. */
export type ContainerProof = (port: number, composeProject: string | undefined, env: NodeJS.ProcessEnv, opts?: { bindOk?: (address: string) => boolean }) => ContainerProofResult;

/** The running container that publishes `port` on an acceptable bind address (and carries the compose label when asked). */
export function publishingContainer(rows: ContainerRow[], port: number, composeProject?: string, bindOk: (address: string) => boolean = () => true): { row: ContainerRow; binding: PortBinding } | undefined {
    for (const row of rows) {
        if (composeProject && !(row.Labels ?? '').split(',').map((l) => l.trim()).includes(`com.docker.compose.project=${composeProject}`)) continue;
        const binding = publishedBindings(row.Ports).find((b) => b.hostPort === port && bindOk(b.address));
        if (binding) return { row, binding };
    }
    return undefined;
}

/** Pure decision over `docker ps` rows: a running container publishes `port` (and carries the compose label when asked). */
export function containerPublishes(rows: ContainerRow[], port: number, composeProject?: string, bindOk?: (address: string) => boolean): boolean {
    return publishingContainer(rows, port, composeProject, bindOk) !== undefined;
}

/**
 * The docker binary: REG_DOCKER_BIN, else `docker`. Under the unit tests (`REG_UNIT_NO_DOCKER=1`, set by
 * playwright.unit.config.ts) the real docker is never run: a test must inject the seam or name a fake REG_DOCKER_BIN
 * (fix pass 4 — a unit test without the seam once ran `docker exec` against a local container), and since fix pass 5
 * that fake must be an absolute path inside the test output or the temp directory (tools.ts `unitDockerBinProblem`):
 * `REG_DOCKER_BIN=docker` or `/usr/local/bin/docker` no longer slip past the flag.
 */
function dockerBin(env: NodeJS.ProcessEnv): string | { error: string } {
    const unit = process.env.REG_UNIT_NO_DOCKER === '1';
    if (env.REG_DOCKER_BIN) {
        const problem = unit ? unitDockerBinProblem(env.REG_DOCKER_BIN) : undefined;
        return problem ? { error: problem } : env.REG_DOCKER_BIN;
    }
    if (unit) return { error: 'the real docker CLI is disabled under the unit tests (inject the seam or a fake REG_DOCKER_BIN)' };
    return 'docker';
}

/** Default container proof: `docker ps --format '{{json .}}'` (REG_DOCKER_BIN overrides the binary). */
export const dockerContainerProof: ContainerProof = (port, composeProject, env, opts = {}) => {
    const bin = dockerBin(env);
    if (typeof bin !== 'string') return { ok: false, error: bin.error };
    const r = spawnSync(bin, ['ps', '--format', '{{json .}}'], { encoding: 'utf8', timeout: 20_000, env: { ...process.env, ...env } });
    if (r.error) return { ok: false, error: `the docker CLI is not usable (${(r.error as NodeJS.ErrnoException).code ?? 'error'}); set REG_DOCKER_BIN or install docker` };
    if (r.status !== 0) return { ok: false, error: `docker ps exited ${r.status}` };
    const rows: ContainerRow[] = [];
    for (const line of (r.stdout ?? '').split('\n')) {
        if (!line.trim()) continue;
        try {
            rows.push(JSON.parse(line) as ContainerRow);
        } catch {
            return { ok: false, error: 'unreadable docker ps output' };
        }
    }
    const hit = publishingContainer(rows, port, composeProject, opts.bindOk);
    if (hit) return { ok: true, container: hit.row.ID || hit.row.Names, containerPort: hit.binding.containerPort };
    if (opts.bindOk && containerPublishes(rows, port, composeProject)) {
        return { ok: false, error: 'a container publishes the core port only on a bind address that does not serve REG_LOCAL_CORE_URL' };
    }
    return { ok: false, error: `no running container publishes the core port${composeProject ? ' in compose project REG_LOCAL_COMPOSE_PROJECT' : ''}` };
};

const cliError = (r: ReturnType<typeof spawnSync>): string => `the docker CLI is not usable (${(r.error as NodeJS.ErrnoException).code ?? 'error'}); set REG_DOCKER_BIN or install docker`;

/** The endpoint of the current docker context (`docker context inspect`), used when DOCKER_HOST is unset. Injected in tests. */
export type DockerContextReader = (env: NodeJS.ProcessEnv) => { host?: string; error?: string };

/** Default: `docker context inspect` (the current context, DOCKER_CONTEXT honoured) → `Endpoints.docker.Host`. */
export const dockerContextEndpoint: DockerContextReader = (env) => {
    const bin = dockerBin(env);
    if (typeof bin !== 'string') return { error: bin.error };
    const r = spawnSync(bin, ['context', 'inspect'], { encoding: 'utf8', timeout: 20_000, env: { ...process.env, ...env } });
    if (r.error) return { error: cliError(r) };
    if (r.status !== 0) return { error: `docker context inspect exited ${r.status}` };
    try {
        const host = (JSON.parse(r.stdout) as Array<{ Endpoints?: { docker?: { Host?: unknown } } }>)?.[0]?.Endpoints?.docker?.Host;
        return typeof host === 'string' && host ? { host } : { error: 'docker context inspect names no docker endpoint' };
    } catch {
        return { error: 'unreadable docker context inspect output' };
    }
};

/** The ID of the daemon behind a docker endpoint (`docker -H <endpoint> info --format {{.ID}}`). Injected in tests. */
export type DaemonIdReader = (endpoint: string, env: NodeJS.ProcessEnv) => { id?: string; error?: string };

export const dockerDaemonId: DaemonIdReader = (endpoint, env) => {
    const bin = dockerBin(env);
    if (typeof bin !== 'string') return { error: bin.error };
    const { DOCKER_HOST: _host, DOCKER_CONTEXT: _context, ...rest } = { ...process.env, ...env };
    const r = spawnSync(bin, ['-H', endpoint, 'info', '--format', '{{.ID}}'], { encoding: 'utf8', timeout: 20_000, env: rest });
    if (r.error) return { error: cliError(r) };
    if (r.status !== 0) return { error: `docker info exited ${r.status}` };
    const id = (r.stdout ?? '').trim();
    return id ? { id } : { error: 'docker info named no daemon ID' };
};

/** A GET run INSIDE a container (`docker exec`), the last step of the instance proof. Injected in tests. */
export type InContainerProbe = (container: string, url: string, headers: Record<string, string>, env: NodeJS.ProcessEnv) => ProbeResult;

/**
 * Default: `docker exec -e REG_PROOF_CERT <container> sh -c 'curl … || wget …' sh <url>`. The admin certificate reaches
 * the container through the exec environment (taken from this CLI's environment), never through the command line.
 */
export const dockerExecProbe: InContainerProbe = (container, url, headers, env) => {
    const bin = dockerBin(env);
    if (typeof bin !== 'string') return { ok: false, error: bin.error };
    const script = 'u="$1"; if command -v curl >/dev/null 2>&1; then exec curl -fksS -H "ssl-client-cert: $REG_PROOF_CERT" "$u"; ' +
        'elif command -v wget >/dev/null 2>&1; then exec wget -qO- --header "ssl-client-cert: $REG_PROOF_CERT" "$u"; ' +
        'else echo "no curl or wget in the container" >&2; exit 127; fi';
    const r = spawnSync(bin, ['exec', '-e', 'REG_PROOF_CERT', container, 'sh', '-c', script, 'sh', url], {
        encoding: 'utf8', timeout: 30_000, env: { ...process.env, ...env, REG_PROOF_CERT: headers['ssl-client-cert'] ?? '' },
    });
    if (r.error) return { ok: false, error: cliError(r) };
    if (r.status !== 0) return { ok: false, error: `docker exec exited ${r.status}${r.status === 127 ? ' (no curl or wget in the core container)' : ''}` };
    try {
        return { ok: true, status: 200, body: JSON.parse(r.stdout) };
    } catch {
        return { ok: false, error: 'unreadable answer inside the container' };
    }
};

/** The platform's default local daemon socket (compared with a loopback TCP / SSH endpoint). */
const DEFAULT_SOCKET = process.platform === 'win32' ? 'npipe:////./pipe/docker_engine' : 'unix:///var/run/docker.sock';

/** The addresses of this machine's network interfaces (lower case, no zone id). Injected in unit tests. */
export type InterfaceAddresses = () => string[];

export const machineAddresses: InterfaceAddresses = () =>
    Object.values(os.networkInterfaces())
        .flatMap((list) => list ?? [])
        .map((i) => bare(i.address).replace(/%.*$/, ''));

/** The host DOCKER_HOST points at; undefined for a local socket (unix / npipe) or when unset; '' when unreadable. */
export function dockerHostName(value: string | undefined): string | undefined {
    if (!value) return undefined;
    if (/^(unix|npipe):/i.test(value)) return undefined;
    try {
        return bare(new URL(value).hostname);
    } catch {
        return '';
    }
}

export interface LocalProofOptions {
    probe?: Probe;
    resolve?: Resolver;
    containers?: ContainerProof;
    interfaces?: InterfaceAddresses;
    /** The current docker context's endpoint (fix pass 4; default `docker context inspect`). */
    dockerContext?: DockerContextReader;
    /** A daemon's ID behind an endpoint (fix pass 4; default `docker -H … info`). */
    daemonId?: DaemonIdReader;
    /** The in-container round trip of the instance proof (fix pass 4; default `docker exec`). */
    inContainer?: InContainerProbe;
}

/**
 * The endpoint the container proof's docker CLI talks to: DOCKER_HOST, else the current docker context's endpoint
 * (fix pass 4: a context pointing at another machine is judged like DOCKER_HOST). Messages never echo it.
 */
function dockerEndpoint(env: NodeJS.ProcessEnv, opts: LocalProofOptions): { value: string | undefined; source: string } {
    if (env.DOCKER_HOST) return { value: env.DOCKER_HOST, source: 'DOCKER_HOST' };
    const ctx = (opts.dockerContext ?? dockerContextEndpoint)(env);
    if (ctx.error) throw new Error(`TIER_KIND=local: the current docker context could not be read (${ctx.error}); refusing @local rows.`);
    return { value: ctx.host, source: 'the current docker context' };
}

/**
 * A TCP / SSH docker endpoint on loopback (`DOCKER_HOST=tcp://localhost:2375`) looks exactly like an `ssh -L` tunnel to
 * another machine's daemon. It is accepted only when its daemon ID equals the ID of the daemon behind the local socket
 * (the current context's socket, else the platform default) — the same daemon, so a local one (fix pass 4).
 */
function assertLoopbackDaemonLocal(endpoint: string, source: string, env: NodeJS.ProcessEnv, opts: LocalProofOptions): void {
    const { DOCKER_HOST: _h, ...withoutHost } = env;
    const ctx = (opts.dockerContext ?? dockerContextEndpoint)(withoutHost);
    const socket = ctx.host && /^(unix|npipe):/i.test(ctx.host) ? ctx.host : DEFAULT_SOCKET;
    const ids = opts.daemonId ?? dockerDaemonId;
    const viaEndpoint = ids(endpoint, env);
    const viaSocket = ids(socket, env);
    if (!viaEndpoint.id || !viaSocket.id || viaEndpoint.id !== viaSocket.id) {
        throw new Error(`TIER_KIND=local: ${source} is a TCP / SSH endpoint on loopback (a tunnel to another machine looks the same) and its ` +
            `daemon could not be proven to be the local one (${viaEndpoint.error ?? viaSocket.error ?? 'its daemon ID differs from the local socket\'s'}). ` +
            'Use the local socket (unset DOCKER_HOST) or a socket context; refusing @local rows.');
    }
}

/**
 * Q4 residual b: the daemon the container proof reads must be the one of the core's machine. A loopback core needs a
 * local daemon (DOCKER_HOST unset, a socket, or pointing at this machine); a private core host must be an address of
 * this machine, or DOCKER_HOST must point at that very host. Messages never echo a host.
 */
function assertDaemonOfCoreHost(coreHost: string, env: NodeJS.ProcessEnv, opts: LocalProofOptions): void {
    const resolve = opts.resolve ?? dnsResolveSync;
    const mine = new Set((opts.interfaces ?? machineAddresses)().map((a) => bare(a)));
    const addressesOf = (h: string): string[] => (net.isIP(h) ? [h] : h === 'localhost' ? ['127.0.0.1'] : (resolve(h).addresses ?? [])).map((a) => bare(a));
    const onThisMachine = (h: string): boolean => {
        const addrs = addressesOf(h);
        return addrs.length > 0 && addrs.every((a) => isLoopbackAddress(a) || mine.has(a));
    };
    const endpoint = dockerEndpoint(env, opts);
    const daemon = dockerHostName(endpoint.value);
    if (daemon === '') throw new Error(`TIER_KIND=local: ${endpoint.source === 'DOCKER_HOST' ? 'DOCKER_HOST' : 'the current docker context\'s endpoint'} is not a readable URL; refusing @local rows.`);
    if (daemon !== undefined && isLoopbackHost(daemon)) assertLoopbackDaemonLocal(endpoint.value!, endpoint.source, env, opts);
    const core = bare(coreHost);
    if (onThisMachine(core)) {
        if (daemon !== undefined && !onThisMachine(daemon)) {
            throw new Error(`TIER_KIND=local: the core runs on this machine but ${endpoint.source} points at another daemon; its containers prove ` +
                'nothing about the core port. Refusing @local rows.');
        }
        return;
    }
    const coreAddrs = addressesOf(core);
    const sameHost = daemon !== undefined && (daemon === core || (() => {
        const d = addressesOf(daemon);
        return d.length > 0 && coreAddrs.length > 0 && d.every((a) => coreAddrs.includes(a));
    })());
    if (!sameHost) {
        throw new Error('TIER_KIND=local: REG_LOCAL_CORE_URL is a private host that is not an address of this machine, and DOCKER_HOST does ' +
            'not point at that host (nor does the current docker context): the container proof would read another daemon than the one ' +
            'serving the core. Refusing @local rows.');
    }
}

/** The bind rule of the core URL's host (its resolved addresses for a private host). */
function bindRuleOf(coreUrl: string, opts: LocalProofOptions): (address: string) => boolean {
    const host = bare(hostOf(coreUrl, 'REG_LOCAL_CORE_URL'));
    const addresses = net.isIP(host) ? [host] : isLoopbackHost(host) ? [] : ((opts.resolve ?? dnsResolveSync)(host).addresses ?? []);
    return bindRule(host, addresses);
}

/**
 * Throws unless TIER_KIND=local is backed by positive proof of a local stack (see the module header). A shared tier
 * (TIER_KIND unset or anything but `local`) passes without a request. Returns the core's build marker (local only).
 */
export function assertLocalAllowed(env: NodeJS.ProcessEnv = process.env, opts: LocalProofOptions = {}): string | undefined {
    if (!isLocalTier(env)) return undefined;
    const baseUrl = env.BASE_URL;
    if (!baseUrl) throw new Error('TIER_KIND=local needs BASE_URL (the local stack); refusing to guess.');
    if (!isLocalHost(hostOf(baseUrl, 'BASE_URL'), env, opts)) {
        throw new Error(
            'TIER_KIND=local but BASE_URL does not point at a loopback address or a private (RFC 1918 / link-local) host listed in ' +
                'TIER_LOCAL_HOSTS. @local rows are destructive (docker control, platform settings, schedules); unset TIER_KIND for a shared tier.',
        );
    }
    const coreUrl = env.REG_LOCAL_CORE_URL;
    if (!coreUrl) {
        throw new Error(
            'TIER_KIND=local needs REG_LOCAL_CORE_URL (the local core, e.g. http://localhost:<core port>): a loopback BASE_URL ' +
                'alone does not prove the backend is local (a dev proxy or a tunnel may forward it to a shared core).',
        );
    }
    if (!isLocalHost(hostOf(coreUrl, 'REG_LOCAL_CORE_URL'), env, opts)) {
        throw new Error('TIER_KIND=local but REG_LOCAL_CORE_URL is not a loopback address or a private host listed in TIER_LOCAL_HOSTS.');
    }
    const coreBuild = coreMarker(env, opts.probe);
    assertDaemonOfCoreHost(hostOf(coreUrl, 'REG_LOCAL_CORE_URL'), env, opts);
    const proof = (opts.containers ?? dockerContainerProof)(portOf(coreUrl), env.REG_LOCAL_COMPOSE_PROJECT || undefined, env, { bindOk: bindRuleOf(coreUrl, opts) });
    if (!proof.ok) {
        throw new Error(`TIER_KIND=local: no container proof for the local core (${proof.error ?? 'unknown'}); refusing @local rows.`);
    }
    const viaBase = (opts.probe ?? httpProbeSync)(new URL('/api/v1/info', baseUrl).toString(), authHeaders(env));
    const baseBuild = viaBase.ok ? buildMarker(viaBase.body) : undefined;
    if (baseBuild && baseBuild !== coreBuild) {
        throw new Error('TIER_KIND=local: BASE_URL is served by a different core build than REG_LOCAL_CORE_URL; refusing @local rows.');
    }
    env.REG_LOCAL_CORE_MARKER = coreBuild;
    return coreBuild;
}

const authHeaders = (env: NodeJS.ProcessEnv): Record<string, string> => (env.AUTH_CLIENT_CERT ? { 'ssl-client-cert': env.AUTH_CLIENT_CERT } : {});

/** The core's build marker from `<REG_LOCAL_CORE_URL>/api/v1/info`; throws when there is none (no liveness-only pass). */
function coreMarker(env: NodeJS.ProcessEnv, probe: Probe = httpProbeSync): string {
    const info = probe(joinUrl(env.REG_LOCAL_CORE_URL!, 'api/v1/info'), authHeaders(env));
    const marker = info.ok ? buildMarker(info.body) : undefined;
    if (!marker) {
        throw new Error(
            `TIER_KIND=local: the core at REG_LOCAL_CORE_URL did not answer /api/v1/info with a build marker ` +
                `(${info.status ?? info.error ?? 'no marker in the answer'}); refusing to enable @local rows without it.`,
        );
    }
    return marker;
}

/** What `assertLocalBackend` needs of a context: an authenticated GET through BASE_URL. */
export interface InfoReader {
    get(url: string): Promise<{ ok(): boolean; status(): number; json(): Promise<unknown> }>;
}

/** `<state dir>/<run id>.local-proof.json`: written by `proveLocalInstance`, read by `describeLocal` and the guard. */
export function localProofFile(env: NodeJS.ProcessEnv = process.env): string {
    return path.join(regressionStateDir(env), `${currentRunId(env)}.local-proof.json`);
}

/** How long a local-backend proof is honoured (a crashed run's proof must not unlock a later invocation). */
export const LOCAL_PROOF_MAX_AGE_MS = 6 * 60 * 60 * 1000;

/** True when this run proved its local backend AND instance on this tier, less than LOCAL_PROOF_MAX_AGE_MS ago. */
export function hasLocalProof(env: NodeJS.ProcessEnv = process.env, now: number = Date.now()): boolean {
    try {
        const proof = JSON.parse(fs.readFileSync(localProofFile(env), 'utf8')) as { runId?: string; tier?: string; at?: string };
        const at = Date.parse(proof.at ?? '');
        if (Number.isNaN(at) || now - at > LOCAL_PROOF_MAX_AGE_MS || at - now > 5 * 60 * 1000) return false;
        return proof.runId === currentRunId(env) && !!proof.tier && proof.tier === tierIdentity(env);
    } catch {
        return false;
    }
}

/** Removes the run's local-backend proof (prepareRun in the runner, the end of the run-end teardown). */
export function removeLocalProof(env: NodeJS.ProcessEnv = process.env): void {
    fs.rmSync(localProofFile(env), { force: true });
}

/**
 * Q4, the authenticated half (the setup and the run-end teardown): under TIER_KIND=local, BASE_URL's `/api/v1/info`
 * read WITH the run's authentication must answer the same build marker as REG_LOCAL_CORE_URL. Unreadable ⇒ refused
 * (fail closed). A shared tier passes without a request. Writes nothing (the proof needs the instance round trip).
 */
export async function assertLocalBackend(api: InfoReader, env: NodeJS.ProcessEnv = process.env, opts: LocalProofOptions = {}): Promise<string | undefined> {
    if (!isLocalTier(env)) return undefined;
    const coreBuild = coreMarker(env, opts.probe);
    const res = await api.get('/api/v1/info');
    if (!res.ok()) {
        throw new Error(`TIER_KIND=local: BASE_URL's /api/v1/info answered ${res.status()} with the run's authentication; ` +
            'without its build marker a tunnel to a shared core cannot be excluded. Refusing @local rows.');
    }
    const baseBuild = buildMarker(await res.json());
    if (!baseBuild) throw new Error('TIER_KIND=local: BASE_URL\'s /api/v1/info carries no core build marker (version plus commit id or build time); refusing @local rows.');
    if (baseBuild !== coreBuild) throw new Error('TIER_KIND=local: BASE_URL is served by a different core build than REG_LOCAL_CORE_URL; refusing @local rows.');
    return coreBuild;
}

export interface InstanceRoundTrip extends LocalProofOptions {
    /**
     * Creates a run-prefixed role THROUGH BASE_URL with the guarded context and records it in the ledger (the run-end
     * teardown deletes it); returns its uuid and name.
     */
    createRole: () => Promise<{ uuid: string; name: string }>;
}

/**
 * Q4 residual a (B0 fix pass 3): instance identity, the setup's last local check before `@local` rows may run. The
 * build marker (assertLocalBackend) is checked again, then a role created through BASE_URL must be readable through
 * REG_LOCAL_CORE_URL with the header-mode admin certificate (AUTH_CLIENT_CERT): the same build on another instance (a
 * tunnel to a shared core of the same release) cannot pass. Not found, unreadable or no certificate ⇒ refused; only
 * on success the run's proof file is written. A shared tier passes without a request.
 */
export async function proveLocalInstance(api: InfoReader, env: NodeJS.ProcessEnv = process.env, opts: InstanceRoundTrip): Promise<void> {
    if (!isLocalTier(env)) return;
    removeLocalProof(env);
    const marker = await assertLocalBackend(api, env, opts);
    const cert = env.AUTH_CLIENT_CERT;
    if (!cert) {
        throw new Error('TIER_KIND=local: the instance proof reads REG_LOCAL_CORE_URL with the header-mode admin certificate, but ' +
            'AUTH_CLIENT_CERT is unset; refusing @local rows.');
    }
    const role = await opts.createRole();
    const isRole = (r: ProbeResult): boolean => {
        const body = r.body as { uuid?: string; name?: string } | undefined;
        return r.ok && String(body?.uuid ?? '').toLowerCase() === role.uuid.toLowerCase() && body?.name === role.name;
    };
    const read = (opts.probe ?? httpProbeSync)(joinUrl(env.REG_LOCAL_CORE_URL!, `api/v1/roles/${role.uuid}`), { 'ssl-client-cert': cert });
    if (!isRole(read)) {
        throw new Error(`TIER_KIND=local: the role created through BASE_URL was not found through REG_LOCAL_CORE_URL ` +
            `(${read.status ?? read.error ?? 'no answer'}); BASE_URL and the local core are not the same instance. Refusing @local rows.`);
    }
    // Last step (fix pass 4): the container that publishes the core port must itself serve the role through ITS OWN port,
    // read from inside it (`docker exec`): a port that only forwards to another instance cannot pass.
    const coreUrl = env.REG_LOCAL_CORE_URL!;
    const container = (opts.containers ?? dockerContainerProof)(portOf(coreUrl), env.REG_LOCAL_COMPOSE_PROJECT || undefined, env, { bindOk: bindRuleOf(coreUrl, opts) });
    if (!container.ok || !container.container || !container.containerPort) {
        throw new Error(`TIER_KIND=local: the container publishing the core port could not be named for the in-container check ` +
            `(${container.error ?? 'no container id or port'}); refusing @local rows.`);
    }
    const base = new URL(coreUrl);
    const inside = joinUrl(`${base.protocol}//127.0.0.1:${container.containerPort}${base.pathname}`, `api/v1/roles/${role.uuid}`);
    const insideRead = (opts.inContainer ?? dockerExecProbe)(container.container, inside, { 'ssl-client-cert': cert }, env);
    if (!isRole(insideRead)) {
        throw new Error(`TIER_KIND=local: the core container does not serve the role through its own port ` +
            `(${insideRead.status ?? insideRead.error ?? 'no answer'}); the published port is not this instance. Refusing @local rows.`);
    }
    const file = localProofFile(env);
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(file, JSON.stringify({ runId: currentRunId(env), tier: tierIdentity(env), marker, instanceRole: role.uuid, at: new Date().toISOString() }));
}

// ------------------------------------------------------------------ auth mode (R25), freeze (R3), identity (R15)

/** AUTH_MODE=header only against a local BASE_URL (loopback, or a private TIER_LOCAL_HOSTS host). */
export function assertAuthModeAllowed(env: NodeJS.ProcessEnv = process.env, opts: LocalHostOptions = {}): void {
    if ((env.AUTH_MODE ?? 'local') !== 'header') return;
    const baseUrl = env.BASE_URL;
    let local = false;
    if (baseUrl) {
        try {
            local = isLocalHost(new URL(baseUrl).hostname, env, opts);
        } catch {
            local = false;
        }
    }
    if (!local) {
        throw new Error('AUTH_MODE=header (no identity provider; a dev proxy injects an admin client certificate) is accepted only ' +
            'for a loopback BASE_URL or a private (RFC 1918 / link-local) host listed in TIER_LOCAL_HOSTS.');
    }
}

/**
 * Called by both configs right after their env file is loaded: TIER_KIND is always set (`local` or `shared`),
 * AUTH_MODE and REG_RA_PROFILE_NAME are set (an empty value counts as set). dotenv never overrides a set variable, so
 * no later load can change them.
 */
export function freezeTierEnv(env: NodeJS.ProcessEnv = process.env): void {
    env.TIER_KIND = tierKind(env);
    env.AUTH_MODE = env.AUTH_MODE ?? 'local';
    env.REG_RA_PROFILE_NAME = env.REG_RA_PROFILE_NAME ?? '';
}

/** sha256 of BASE_URL's host (with port), first 12 hex characters; undefined without a valid BASE_URL. */
export function tierIdentity(env: NodeJS.ProcessEnv = process.env): string | undefined {
    if (!env.BASE_URL) return undefined;
    try {
        const host = new URL(env.BASE_URL).host.toLowerCase();
        return crypto.createHash('sha256').update(host).digest('hex').slice(0, 12);
    } catch {
        return undefined;
    }
}

/**
 * The tier checks again, in the run-end teardown and the setup: TIER_KIND frozen by a config, the local proof, the
 * auth mode, and BASE_URL unchanged since the config loaded (REG_TIER_ID).
 */
export function assertRunTier(env: NodeJS.ProcessEnv = process.env, opts: LocalProofOptions = {}): void {
    if (env.TIER_KIND !== 'local' && env.TIER_KIND !== 'shared') {
        throw new Error('TIER_KIND is not frozen (the REG / API configs set it to local or shared at load); ' +
            'run through playwright.regression.config.ts or playwright.api.config.ts.');
    }
    assertLocalAllowed(env, opts);
    assertAuthModeAllowed(env, opts);
    const frozen = env.REG_TIER_ID;
    const now = tierIdentity(env);
    if (frozen && now && frozen !== now) throw new Error('BASE_URL changed since the config was loaded (tier identity differs); refusing.');
}

/** assertRunTier plus, under TIER_KIND=local, the authenticated BASE_URL build check (`assertLocalBackend`). */
export async function assertRunTierLive(api: InfoReader, env: NodeJS.ProcessEnv = process.env, opts: LocalProofOptions = {}): Promise<void> {
    assertRunTier(env, opts);
    await assertLocalBackend(api, env, opts);
}

/** The part of Playwright's `test` that describeLocal needs (works with the fixtures' extended `test`). */
interface SkipCapable {
    skip(condition: boolean, description?: string): void;
    skip(callback: () => boolean, description?: string): void;
}

/**
 * Call inside a `test.describe` of a `@local` spec: every test in it is skipped unless TIER_KIND=local, and (checked
 * when each test starts) unless this run holds its authenticated local-backend proof on this tier (Q4).
 */
export function describeLocal(test: SkipCapable, env: NodeJS.ProcessEnv = process.env): void {
    test.skip(!isLocalTier(env), 'local stack only (TIER_KIND=local)');
    test.skip(() => !hasLocalProof(env), 'no authenticated local-backend proof for this run (API-GEN-33[guard] in the snapshot project)');
}
