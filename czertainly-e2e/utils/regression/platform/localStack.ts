/**
 * localStack — docker compose control of the local stack, for the local-only rows.
 *
 * Stop, start, restart, `down -v`, logs, and psql inside the database container. Restart, stop and database rows can only run
 * against a stack the suite owns, so every call refuses unless TIER_KIND=local and BASE_URL is loopback. The docker binary
 * comes from `tools.requireTool('docker')` (a fake under the unit tests); compose file, project and service names come from
 * the environment, never from code.
 */
import { execFileSync, spawnSync } from 'child_process';
import { Logger } from '../../Logger';
import { hasLocalProof } from '../tier/localProof';
import { isLocalTier } from '../tier/kind';
import { isLoopbackHost } from '../tier/dns';
import { dockerBin, requireTool } from '../requireTool';
import { settings } from '../run/settings';

const logger = new Logger('PlatformStack');

export type Service = 'core' | 'rabbitmq' | 'db' | 'auth' | 'scheduler';

export interface StackConfig {
    dockerBin: string;
    composeFile?: string;
    project?: string;
    services: Record<Service, string>;
}

/** Why the local stack must not be touched from this process, or undefined. */
export function stackProblem(env: NodeJS.ProcessEnv = process.env): string | undefined {
    if (!isLocalTier(env)) return 'local stack only (TIER_KIND=local)';
    let host: string;
    try {
        host = new URL(settings(env).baseUrl ?? '').hostname;
    } catch {
        return 'BASE_URL is not a URL';
    }
    if (!isLoopbackHost(host)) return 'BASE_URL is not a loopback address: the local stack control refuses a remote target';
    return requireTool('docker');
}

/** The stack configuration from the environment (pure apart from reading `env`). */
export function stackConfig(env: NodeJS.ProcessEnv = process.env): StackConfig {
    return {
        dockerBin: settings(env).dockerBinOverride ?? 'docker',
        composeFile: settings(env).composeFile,
        project: settings(env).composeProject,
        services: settings(env).services,
    };
}

/** The `docker compose …` argv for a subcommand (pure): `-f <file>` / `-p <project>` when configured. */
export function composeArgs(cfg: StackConfig, ...rest: string[]): string[] {
    return ['compose', ...(cfg.composeFile ? ['-f', cfg.composeFile] : []), ...(cfg.project ? ['-p', cfg.project] : []), ...rest];
}

export interface CommandResult {
    ok: boolean;
    status: number | null;
    stdout: string;
    stderr: string;
}

export type Runner = (bin: string, args: string[], input?: string) => CommandResult;

/** The default runner: `spawnSync` with a 10-minute ceiling (an upgrade's migration can take minutes). */
const spawnRunner: Runner = (bin, args, input) => {
    const r = spawnSync(bin, args, { encoding: 'utf8', input, timeout: 600_000, maxBuffer: 64 * 1024 * 1024 });
    return { ok: !r.error && r.status === 0, status: r.status, stdout: r.stdout ?? '', stderr: r.error ? String(r.error) : (r.stderr ?? '') };
};

/**
 * The local stack controller. `run` is injectable for the unit tests (the fake records argv); the real runner is only
 * reached after `stackProblem` passed.
 */
export class PlatformStack {
    constructor(private readonly cfg: StackConfig = stackConfig(), private readonly run: Runner = spawnRunner, private readonly env: NodeJS.ProcessEnv = process.env) {}

    private guard(what: string): void {
        const problem = stackProblem(this.env);
        if (problem) throw new Error(`localStack.${what}: ${problem}`);
    }

    private compose(what: string, ...args: string[]): CommandResult {
        this.guard(what);
        const argv = composeArgs(this.cfg, ...args);
        logger.info(`docker ${argv.filter((a) => !a.includes('/')).join(' ')}`);
        const r = this.run(this.cfg.dockerBin, argv);
        if (!r.ok) throw new Error(`localStack.${what}: docker ${args[0]} failed (${r.status}): ${r.stderr.slice(0, 400)}`);
        return r;
    }

    service(name: Service): string {
        return this.cfg.services[name];
    }

    stop(service: Service): void {
        this.compose(`stop(${service})`, 'stop', this.service(service));
    }

    start(service: Service): void {
        this.compose(`start(${service})`, 'start', this.service(service));
    }

    restart(service: Service): void {
        this.compose(`restart(${service})`, 'restart', this.service(service));
    }

    /**
     * `compose down -v` (volumes too): the empty-database start of REG-CORE-01 / 02. Refused unless the compose project OR the
     * compose file is explicit (`LOCAL_COMPOSE_PROJECT` / `LOCAL_COMPOSE_FILE`): a `down -v` resolved from the current directory
     * would wipe whatever project the shell happens to sit in.
     */
    downWithVolumes(): void {
        if (!this.cfg.project && !this.cfg.composeFile) throw new Error('localStack.downWithVolumes: LOCAL_COMPOSE_PROJECT or LOCAL_COMPOSE_FILE must name the stack explicitly');
        this.compose('downWithVolumes', 'down', '-v', '--remove-orphans');
    }

    /** `compose up -d <services>`. */
    up(...services: Service[]): void {
        this.compose('up', 'up', '-d', ...services.map((s) => this.service(s)));
    }

    /** The logs of a service since a duration / timestamp (`--since`), as text. */
    logs(service: Service, since?: string): string {
        return this.compose(`logs(${service})`, 'logs', '--no-color', ...(since ? ['--since', since] : []), this.service(service)).stdout;
    }

    /**
     * One SQL statement inside the database container: `compose exec -T <db> psql -At -v ON_ERROR_STOP=1 -c <sql>` as
     * the container's default user / database. Returns the unaligned rows (`|`-separated columns).
     */
    psql(sql: string): string[] {
        const r = this.compose('psql', 'exec', '-T', this.service('db'), 'psql', '-At', '-v', 'ON_ERROR_STOP=1', '-c', sql);
        return r.stdout.split('\n').map((l) => l.trimEnd()).filter(Boolean);
    }

    /** The image / tag a service runs (`compose images --format json`), for the upgrade guard of REG-DEP-02. */
    imageOf(service: Service): string | undefined {
        const r = this.compose(`imageOf(${service})`, 'images', '--format', 'json', this.service(service));
        try {
            const rows = JSON.parse(r.stdout || '[]') as Array<{ Repository?: string; Tag?: string; Service?: string }>;
            const row = rows.find((x) => !x.Service || x.Service === this.service(service)) ?? rows[0];
            return row ? `${row.Repository ?? ''}:${row.Tag ?? ''}` : undefined;
        } catch {
            return undefined;
        }
    }
}

/** The parts of a core start log REG-CORE-01 / 02 read (pure). */
export interface CoreStartLogFacts {
    appliedMigrations?: number;
    nowAtVersion?: string;
    validatedOnly: boolean;
    errors: string[];
    syncCompleted: boolean;
    syncFailed: boolean;
}

export function coreStartLogFacts(log: string): CoreStartLogFacts {
    const applied = /Successfully applied (\d+) migrations? to schema "core", now at version v(\S+)/.exec(log);
    const validated = /Successfully validated \d+ migrations/.test(log) && /No migration necessary/.test(log);
    const errors = log.split('\n').filter((l) => /\bERROR\b/.test(l)).map((l) => l.slice(0, 300));
    return {
        appliedMigrations: applied ? Number(applied[1]) : undefined,
        nowAtVersion: applied?.[2],
        validatedOnly: validated,
        errors,
        syncCompleted: /Sync operation completed/.test(log),
        syncFailed: /Unable to synchronize resources with Auth Service/.test(log),
    };
}

// ------------------------------------------------------------------ the core restart (session tests on the local stack)

/**
 * The docker arguments that restart the core service, or why not. Stricter than `PlatformStack.restart`: it needs this run's
 * unexpired local-backend proof (`hasLocalProof`, tier/localProof.ts) and a NAMED compose project (a bare `docker compose restart` would
 * act on whatever compose project the working directory belongs to).
 */
export function restartPlan(env: NodeJS.ProcessEnv = process.env): { args: string[] } | { problem: string } {
    if (!isLocalTier(env)) return { problem: 'restarting core needs a local stack (TIER_KIND=local)' };
    if (!hasLocalProof(env)) return { problem: 'no authenticated local-backend proof for this run (API-GEN-33[guard] in the snapshot project)' };
    const cfg = stackConfig(env);
    if (!cfg.project) return { problem: 'REG_LOCAL_COMPOSE_PROJECT (or LOCAL_COMPOSE_PROJECT) names no compose project: a restart without it could act on another stack' };
    return { args: composeArgs(cfg, 'restart', cfg.services.core) };
}

/**
 * `docker compose -p <project> restart <core service>` on a proven local stack; returns when docker returns. Specs never call
 * child_process (spec guards): the session tests call this. Under the unit tests (`REG_UNIT_NO_DOCKER=1`) only an absolute fake inside
 * the test output runs (requireTool.ts `dockerBin`).
 */
export function restartCore(env: NodeJS.ProcessEnv = process.env): void {
    const plan = restartPlan(env);
    if ('problem' in plan) throw new Error(plan.problem);
    const bin = dockerBin(env);
    if (typeof bin !== 'string') throw new Error(bin.error);
    logger.info(`docker ${plan.args.filter((a) => !a.includes('/')).join(' ')}`);
    execFileSync(bin, plan.args, { encoding: 'utf8', timeout: 240_000, stdio: ['ignore', 'pipe', 'pipe'], env: { ...process.env, ...env } });
}
