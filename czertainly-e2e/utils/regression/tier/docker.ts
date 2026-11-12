/**
 * tier/docker — the docker side of the local-backend proof: which running container publishes the core's port (and on
 * which bind address), the docker endpoint and daemon id, and the in-container round trip. Every reader is a seam the
 * unit tests inject; under REG_UNIT_NO_DOCKER the real docker CLI is never run.
 */
import { spawnSync } from 'child_process';
import * as os from 'os';
import { dockerBin } from '../requireTool';
import { bareHost, isLoopbackAddress, isLoopbackHost } from './dns';
import type { HttpProbeResult } from './localProof';

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
 * 127.0.0.1:8000-8002->8000-8002/tcp, :::8280->8080/tcp`), with their bind address.
 */
export function publishedBindings(ports: string | undefined): PortBinding[] {
    const out: PortBinding[] = [];
    for (const part of (ports ?? '').split(',')) {
        const m = /^(.*):(\d+)(?:-(\d+))?->(\d+)(?:-\d+)?\/\w+$/.exec(part.trim());
        if (!m) continue;
        const address = bareHost(m[1]);
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
 * Which bind addresses can serve REG_LOCAL_CORE_URL: a loopback core only 0.0.0.0, [::], 127.x and ::1
 * (a container bound to another interface does not answer on loopback); a private core host every-interface or one of
 * that host's own addresses.
 */
export function bindRule(coreHost: string, coreAddresses: string[] = []): (address: string) => boolean {
    const loopback = isLoopbackHost(coreHost);
    const own = new Set(coreAddresses.map(bareHost));
    return (address) => {
        const a = bareHost(address);
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

/** The container proof; injected in unit tests. `bindOk`: which bind addresses can serve the core URL. */
export type ContainerProof = (port: number, composeProject: string | undefined, env: NodeJS.ProcessEnv, opts?: { bindOk?: (address: string) => boolean }) => ContainerProofResult;

/** The running container that publishes `port` on an acceptable bind address (and carries the compose label when asked). */
function publishingContainer(rows: ContainerRow[], port: number, composeProject?: string, bindOk: (address: string) => boolean = () => true): { row: ContainerRow; binding: PortBinding } | undefined {
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
export type InContainerProbe = (container: string, url: string, headers: Record<string, string>, env: NodeJS.ProcessEnv) => HttpProbeResult;

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
export const DEFAULT_SOCKET = process.platform === 'win32' ? 'npipe:////./pipe/docker_engine' : 'unix:///var/run/docker.sock';

/** The addresses of this machine's network interfaces (lower case, no zone id). Injected in unit tests. */
export type InterfaceAddresses = () => string[];

export const machineAddresses: InterfaceAddresses = () =>
    Object.values(os.networkInterfaces())
        .flatMap((list) => list ?? [])
        .map((i) => bareHost(i.address).replace(/%.*$/, ''));

/** The host DOCKER_HOST points at; undefined for a local socket (unix / npipe) or when unset; '' when unreadable. */
export function dockerHostName(value: string | undefined): string | undefined {
    if (!value) return undefined;
    if (/^(unix|npipe):/i.test(value)) return undefined;
    try {
        return bareHost(new URL(value).hostname);
    } catch {
        return '';
    }
}
