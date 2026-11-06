/**
 * tier/docker — the docker side of the local-backend proof: which container publishes the core's port, the docker endpoint and daemon id,
 * and the in-container round trip. Every reader is a unit-test seam; REG_UNIT_NO_DOCKER never runs the real CLI.
 */
import { spawnSync } from 'child_process';
import * as os from 'os';
import { dockerBin } from '../requireTool';
import { bareHost, isLoopbackAddress, isLoopbackHost } from './dns';
import type { HttpProbeResult } from './localProof';

export interface ContainerRow {
    ID?: string;
    Names?: string;
    Ports?: string;
    Labels?: string;
}

export interface PortBinding {
    address: string;
    hostPort: number;
    containerPort: number;
}

/** The published ports of a `docker ps` Ports column, with their bind address. */
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

export function publishedHostPorts(ports: string | undefined): number[] {
    return publishedBindings(ports).map((b) => b.hostPort);
}

/** Every-interface addresses serve loopback and every address of the machine. */
const ANY_ADDRESS = new Set(['0.0.0.0', '::', '0:0:0:0:0:0:0:0']);

/**
 * Which bind addresses can serve REG_LOCAL_CORE_URL: a loopback core only 0.0.0.0, [::], 127.x and ::1; a private host every-interface or
 * its own addresses.
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
    error?: string;
    container?: string;
    containerPort?: number;
}

export type ContainerProof = (port: number, composeProject: string | undefined, env: NodeJS.ProcessEnv, opts?: { bindOk?: (address: string) => boolean }) => ContainerProofResult;

function publishingContainer(rows: ContainerRow[], port: number, composeProject?: string, bindOk: (address: string) => boolean = () => true): { row: ContainerRow; binding: PortBinding } | undefined {
    for (const row of rows) {
        if (composeProject && !(row.Labels ?? '').split(',').map((l) => l.trim()).includes(`com.docker.compose.project=${composeProject}`)) continue;
        const binding = publishedBindings(row.Ports).find((b) => b.hostPort === port && bindOk(b.address));
        if (binding) return { row, binding };
    }
    return undefined;
}

export function containerPublishes(rows: ContainerRow[], port: number, composeProject?: string, bindOk?: (address: string) => boolean): boolean {
    return publishingContainer(rows, port, composeProject, bindOk) !== undefined;
}

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

export type DockerContextReader = (env: NodeJS.ProcessEnv) => { host?: string; error?: string };

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

export type InContainerProbe = (container: string, url: string, headers: Record<string, string>, env: NodeJS.ProcessEnv) => HttpProbeResult;

/** Default: `docker exec` with `curl` / `wget`; the admin certificate goes through the exec environment, never the command line. */
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

export const DEFAULT_SOCKET = process.platform === 'win32' ? 'npipe:////./pipe/docker_engine' : 'unix:///var/run/docker.sock';

export type InterfaceAddresses = () => string[];

export const machineAddresses: InterfaceAddresses = () =>
    Object.values(os.networkInterfaces())
        .flatMap((list) => list ?? [])
        .map((i) => bareHost(i.address).replace(/%.*$/, ''));

export function dockerHostName(value: string | undefined): string | undefined {
    if (!value) return undefined;
    if (/^(unix|npipe):/i.test(value)) return undefined;
    try {
        return bareHost(new URL(value).hostname);
    } catch {
        return '';
    }
}
