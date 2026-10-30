/**
 * tier/localProof — the guards that keep destructive `@local` rows off shared tiers.
 *
 *   - Only `TIER_KIND=local` is a local stack, and BASE_URL and REG_LOCAL_CORE_URL must be local hosts.
 *   - `assertLocalAllowed()` needs POSITIVE proof of a local backend: `<core>/api/v1/info` answers a build marker and `docker ps`
 *     on THIS machine's daemon shows a container publishing the core port on an address that serves it. Otherwise the run
 *     stops before it lists a test. The configs freeze TIER_KIND after loading the env file; a later load cannot switch it.
 *   - `assertLocalBackend(api)` checks the BASE_URL build marker equals a fresh read of REG_LOCAL_CORE_URL.
 *   - `proveLocalInstance` creates a run-prefixed role through BASE_URL and reads it back from the core and the container; only
 *     then is the proof file written. It expires and is required by `describeLocalOnly` and the guard's `localStack` option.
 *   - AUTH_MODE=header only with a local BASE_URL. Messages never echo BASE_URL, REG_LOCAL_CORE_URL or TIER_LOCAL_HOSTS.
 */
import { spawnSync } from 'child_process';
import * as fs from 'fs';
import * as net from 'net';
import * as path from 'path';
import { currentRunId, regressionStateDir } from '../run/runId';
import { bareHost, dnsResolveSync, hostOf, isLocalHost, isLoopbackAddress, isLoopbackHost, LocalHostOptions, Resolver } from './dns';
import { bindRule, ContainerProof, DaemonIdReader, DEFAULT_SOCKET, dockerHostName, DockerContextReader, dockerContainerProof, dockerContextEndpoint, dockerDaemonId, dockerExecProbe, InContainerProbe, InterfaceAddresses, machineAddresses } from './docker';
import { isLocalTier, tierIdentity } from './kind';
import { settings } from '../run/settings';

// ------------------------------------------------------------------ positive proof of a local backend

export interface HttpProbeResult {
    ok: boolean;
    status?: number;
    body?: unknown;
    error?: string;
}

/** A synchronous GET (config load is synchronous). Injected in unit tests. */
export type HttpProbe = (url: string, headers?: Record<string, string>) => HttpProbeResult;

const PROBE_SCRIPT = `
const [url, headers] = process.argv.slice(1);
fetch(url, { headers: JSON.parse(headers), redirect: 'manual', signal: AbortSignal.timeout(8000) })
  .then(async (r) => { const t = await r.text(); let b; try { b = JSON.parse(t); } catch { b = undefined; }
    process.stdout.write(JSON.stringify({ status: r.status, body: b })); })
  .catch((e) => process.stdout.write(JSON.stringify({ error: String(e && e.cause ? e.cause.code || e.cause : e).slice(0, 120) })));
`;

/** Default probe: one GET in a child Node process (8 s timeout; a local stack's self-signed TLS is accepted). */
export const probeHttpSync: HttpProbe = (url, headers = {}) => {
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
 * version (the commit id or the build time is required, a version alone matches every stack of a release).
 */
export function buildMarker(body: unknown): string | undefined {
    const b = body as { app?: { name?: string; version?: string }; build?: { commitId?: string; timestamp?: string } } | undefined;
    if (!b?.app?.version || !(b.build?.commitId || b.build?.timestamp)) return undefined;
    return JSON.stringify([b.app.version, b.build?.commitId ?? '', b.build?.timestamp ?? '']);
}

/** The port of a URL (the scheme's default when none is written). */
function portOf(url: string): number {
    const u = new URL(url);
    return Number(u.port || (u.protocol === 'https:' ? 443 : 80));
}

export interface LocalProofOptions {
    probe?: HttpProbe;
    resolve?: Resolver;
    containers?: ContainerProof;
    interfaces?: InterfaceAddresses;
    /** The current docker context's endpoint (default `docker context inspect`). */
    dockerContext?: DockerContextReader;
    /** A daemon's ID behind an endpoint (default `docker -H … info`). */
    daemonId?: DaemonIdReader;
    /** The in-container round trip of the instance proof (default `docker exec`). */
    inContainer?: InContainerProbe;
}

/**
 * The endpoint the container proof's docker CLI talks to: DOCKER_HOST, else the current docker context's endpoint
 * (a context pointing at another machine is judged like DOCKER_HOST). Messages never echo it.
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
 * (the current context's socket, else the platform default) — the same daemon, so a local one.
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
 * The daemon the container proof reads must be the one of the core's machine. A loopback core needs a
 * local daemon (DOCKER_HOST unset, a socket, or pointing at this machine); a private core host must be an address of
 * this machine, or DOCKER_HOST must point at that very host. Messages never echo a host.
 */
function assertDaemonOfCoreHost(coreHost: string, env: NodeJS.ProcessEnv, opts: LocalProofOptions): void {
    const resolve = opts.resolve ?? dnsResolveSync;
    const mine = new Set((opts.interfaces ?? machineAddresses)().map((a) => bareHost(a)));
    const addressesOf = (h: string): string[] => (net.isIP(h) ? [h] : h === 'localhost' ? ['127.0.0.1'] : (resolve(h).addresses ?? [])).map((a) => bareHost(a));
    const onThisMachine = (h: string): boolean => {
        const addrs = addressesOf(h);
        return addrs.length > 0 && addrs.every((a) => isLoopbackAddress(a) || mine.has(a));
    };
    const endpoint = dockerEndpoint(env, opts);
    const daemon = dockerHostName(endpoint.value);
    if (daemon === '') throw new Error(`TIER_KIND=local: ${endpoint.source === 'DOCKER_HOST' ? 'DOCKER_HOST' : 'the current docker context\'s endpoint'} is not a readable URL; refusing @local rows.`);
    if (daemon !== undefined && isLoopbackHost(daemon)) assertLoopbackDaemonLocal(endpoint.value!, endpoint.source, env, opts);
    const core = bareHost(coreHost);
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
    const host = bareHost(hostOf(coreUrl, 'REG_LOCAL_CORE_URL'));
    const addresses = net.isIP(host) ? [host] : isLoopbackHost(host) ? [] : ((opts.resolve ?? dnsResolveSync)(host).addresses ?? []);
    return bindRule(host, addresses);
}

/**
 * Throws unless TIER_KIND=local is backed by positive proof of a local stack (see the module header). A shared tier
 * (TIER_KIND unset or anything but `local`) passes without a request. Returns the core's build marker (local only).
 */
export function assertLocalAllowed(env: NodeJS.ProcessEnv = process.env, opts: LocalProofOptions = {}): string | undefined {
    if (!isLocalTier(env)) return undefined;
    const baseUrl = settings(env).baseUrl;
    if (!baseUrl) throw new Error('TIER_KIND=local needs BASE_URL (the local stack); refusing to guess.');
    if (!isLocalHost(hostOf(baseUrl, 'BASE_URL'), env, opts)) {
        throw new Error(
            'TIER_KIND=local but BASE_URL does not point at a loopback address or a private (RFC 1918 / link-local) host listed in ' +
                'TIER_LOCAL_HOSTS. @local rows are destructive (docker control, platform settings, schedules); unset TIER_KIND for a shared tier.',
        );
    }
    const coreUrl = settings(env).localCoreUrl;
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
    const proof = (opts.containers ?? dockerContainerProof)(portOf(coreUrl), settings(env).composeProject, env, { bindOk: bindRuleOf(coreUrl, opts) });
    if (!proof.ok) {
        throw new Error(`TIER_KIND=local: no container proof for the local core (${proof.error ?? 'unknown'}); refusing @local rows.`);
    }
    const viaBase = (opts.probe ?? probeHttpSync)(new URL('/api/v1/info', baseUrl).toString(), authHeaders(env));
    const baseBuild = viaBase.ok ? buildMarker(viaBase.body) : undefined;
    if (baseBuild && baseBuild !== coreBuild) {
        throw new Error('TIER_KIND=local: BASE_URL is served by a different core build than REG_LOCAL_CORE_URL; refusing @local rows.');
    }
    env.REG_LOCAL_CORE_MARKER = coreBuild;
    return coreBuild;
}

const authHeaders = (env: NodeJS.ProcessEnv): Record<string, string> => (settings(env).authClientCert ? { 'ssl-client-cert': settings(env).authClientCert! } : {});

/** The core's build marker from `<REG_LOCAL_CORE_URL>/api/v1/info`; throws when there is none (no liveness-only pass). */
function coreMarker(env: NodeJS.ProcessEnv, probe: HttpProbe = probeHttpSync): string {
    const info = probe(joinUrl(settings(env).localCoreUrl!, 'api/v1/info'), authHeaders(env));
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

/** `<state dir>/<run id>.local-proof.json`: written by `proveLocalInstance`, read by `describeLocalOnly` and the guard. */
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
 * The authenticated half of the local-backend proof (the setup and the run-end teardown): under TIER_KIND=local, BASE_URL's `/api/v1/info`
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
 * Instance identity: the setup's last local check before `@local` rows may run. The
 * build marker (assertLocalBackend) is checked again, then a role created through BASE_URL must be readable through
 * REG_LOCAL_CORE_URL with the header-mode admin certificate (AUTH_CLIENT_CERT): the same build on another instance (a
 * tunnel to a shared core of the same release) cannot pass. Not found, unreadable or no certificate ⇒ refused; only
 * on success the run's proof file is written. A shared tier passes without a request.
 */
export async function proveLocalInstance(api: InfoReader, env: NodeJS.ProcessEnv = process.env, opts: InstanceRoundTrip): Promise<void> {
    if (!isLocalTier(env)) return;
    removeLocalProof(env);
    const marker = await assertLocalBackend(api, env, opts);
    const cert = settings(env).authClientCert;
    if (!cert) {
        throw new Error('TIER_KIND=local: the instance proof reads REG_LOCAL_CORE_URL with the header-mode admin certificate, but ' +
            'AUTH_CLIENT_CERT is unset; refusing @local rows.');
    }
    const role = await opts.createRole();
    const isRole = (r: HttpProbeResult): boolean => {
        const body = r.body as { uuid?: string; name?: string } | undefined;
        return r.ok && String(body?.uuid ?? '').toLowerCase() === role.uuid.toLowerCase() && body?.name === role.name;
    };
    const read = (opts.probe ?? probeHttpSync)(joinUrl(settings(env).localCoreUrl!, `api/v1/roles/${role.uuid}`), { 'ssl-client-cert': cert });
    if (!isRole(read)) {
        throw new Error(`TIER_KIND=local: the role created through BASE_URL was not found through REG_LOCAL_CORE_URL ` +
            `(${read.status ?? read.error ?? 'no answer'}); BASE_URL and the local core are not the same instance. Refusing @local rows.`);
    }
    // Last step: the container that publishes the core port must itself serve the role through ITS OWN port,
    // read from inside it (`docker exec`): a port that only forwards to another instance cannot pass.
    const coreUrl = settings(env).localCoreUrl!;
    const container = (opts.containers ?? dockerContainerProof)(portOf(coreUrl), settings(env).composeProject, env, { bindOk: bindRuleOf(coreUrl, opts) });
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

// ------------------------------------------------------------------ auth mode, freeze, identity

/** AUTH_MODE=header only against a local BASE_URL (loopback, or a private TIER_LOCAL_HOSTS host). */
export function assertAuthModeAllowed(env: NodeJS.ProcessEnv = process.env, opts: LocalHostOptions = {}): void {
    if (settings(env).authMode !== 'header') return;
    const baseUrl = settings(env).baseUrl;
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
 * The tier checks again, in the run-end teardown and the setup: TIER_KIND frozen by a config, the local proof, the
 * auth mode, and BASE_URL unchanged since the config loaded (REG_TIER_ID).
 */
export function assertRunTier(env: NodeJS.ProcessEnv = process.env, opts: LocalProofOptions = {}): void {
    if (settings(env).tierKind !== 'local' && settings(env).tierKind !== 'shared') {
        throw new Error('TIER_KIND is not frozen (the REG / API configs set it to local or shared at load); ' +
            'run through playwright.regression.config.ts or playwright.api.config.ts.');
    }
    assertLocalAllowed(env, opts);
    assertAuthModeAllowed(env, opts);
    const frozen = settings(env).tierId;
    const now = tierIdentity(env);
    if (frozen && now && frozen !== now) throw new Error('BASE_URL changed since the config was loaded (tier identity differs); refusing.');
}

/** assertRunTier plus, under TIER_KIND=local, the authenticated BASE_URL build check (`assertLocalBackend`). */
export async function assertRunTierLive(api: InfoReader, env: NodeJS.ProcessEnv = process.env, opts: LocalProofOptions = {}): Promise<void> {
    assertRunTier(env, opts);
    await assertLocalBackend(api, env, opts);
}

/** The part of Playwright's `test` that describeLocalOnly needs (works with the fixtures' extended `test`). */
interface SkipCapable {
    skip(condition: boolean, description?: string): void;
    skip(callback: () => boolean, description?: string): void;
}

/**
 * Call inside a `test.describe` of a `@local` spec: every test in it is skipped unless TIER_KIND=local, and (checked
 * when each test starts) unless this run holds its authenticated local-backend proof on this tier.
 */
export function describeLocalOnly(test: SkipCapable, env: NodeJS.ProcessEnv = process.env): void {
    test.skip(!isLocalTier(env), 'local stack only (TIER_KIND=local)');
    test.skip(() => !hasLocalProof(env), 'no authenticated local-backend proof for this run (API-GEN-33[guard] in the snapshot project)');
}
