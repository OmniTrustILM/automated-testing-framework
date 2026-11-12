/**
 * docker — the docker CLI calls of the key onboarding block, behind one injectable seam.
 *
 * WHAT: `DockerRunner` (args + extra environment → exit code and output), the default runner over the real CLI,
 * `dockerAvailable` (a daemon answers), `sidecarRunning` (the SoftHSM sidecar is up), `sidecarFacts` (its image, the
 * owner of its token files, its SOFTHSM2_CONF) and `passThrough` (the `-e NAME` flags that make docker copy a variable
 * from its own environment).
 * WHY: planting and removing key pairs on the token runs a throwaway container from the sidecar's image with the
 * sidecar's volumes; the PIN must never be on a command line (`ps` shows argv to every user of the runner), so every
 * value goes through the environment and argv carries only the variable names. The unit tests replace the runner and
 * never start docker.
 * HOW: the default runner resolves the binary through `dockerBin` (REG_DOCKER_BIN, else `docker`; under the unit tests
 * the real CLI is refused there), runs it without a shell and never throws on a non-zero exit: the caller decides what
 * an exit code means.
 */
import { spawn } from 'child_process';
import { dockerBin } from '../../regression/requireTool';
import { TierError } from '../../devBlocks/provision/transport';

export interface DockerResult {
    code: number;
    stdout: string;
    stderr: string;
}

/** Runs `docker <args>` with `env` added to the runner's environment. */
export type DockerRunner = (args: string[], opts?: { env?: Record<string, string> }) => Promise<DockerResult>;

/** The owner of the token files when the sidecar container declares no user (the source suite's default). */
const SIDECAR_IMAGE_USER = '10001';
const SOFTHSM2_CONF_VARIABLE = 'SOFTHSM2_CONF';

/** The real docker CLI (see the file header). */
export function defaultDockerRunner(processEnv: NodeJS.ProcessEnv = process.env): DockerRunner {
    return (args, opts = {}) => new Promise((resolve) => {
        const bin = dockerBin(processEnv);
        if (typeof bin !== 'string') {
            resolve({ code: 127, stdout: '', stderr: bin.error });
            return;
        }
        let stdout = '';
        let stderr = '';
        const child = spawn(bin, args, { env: { ...processEnv, ...opts.env }, stdio: ['ignore', 'pipe', 'pipe'] });
        child.stdout.on('data', (chunk: Buffer) => { stdout += chunk.toString('utf8'); });
        child.stderr.on('data', (chunk: Buffer) => { stderr += chunk.toString('utf8'); });
        child.on('error', (e) => resolve({ code: 127, stdout, stderr: `${stderr}${String(e)}` }));
        child.on('close', (code) => resolve({ code: code ?? 1, stdout, stderr }));
    });
}

/** A docker daemon answers. */
export async function dockerAvailable(docker: DockerRunner): Promise<boolean> {
    return (await docker(['version', '--format', '{{.Server.Version}}'])).code === 0;
}

/** The container exists and is running. */
export async function sidecarRunning(docker: DockerRunner, container: string): Promise<boolean> {
    const r = await docker(['inspect', '-f', '{{.State.Running}}', container]);
    return r.code === 0 && r.stdout.trim() === 'true';
}

export interface SidecarFacts {
    image: string;
    /** `uid:gid`, the form su-exec takes. */
    owner: string;
    /** The sidecar's SOFTHSM2_CONF, when it sets one. */
    softhsmConf?: string;
}

async function inspect(docker: DockerRunner, container: string, format: string): Promise<string> {
    const r = await docker(['inspect', '-f', format, container]);
    // The sidecar went away since the preflight saw it running: the tier's state, not the setup's error.
    if (r.code !== 0) throw new TierError(`docker inspect of the sidecar container answered exit ${r.code}`);
    return r.stdout.trim();
}

/** What the planting and the removal container take over from the sidecar (the source suite's three inspects). */
export async function sidecarFacts(docker: DockerRunner, container: string): Promise<SidecarFacts> {
    const image = await inspect(docker, container, '{{.Config.Image}}');
    const user = (await inspect(docker, container, '{{.Config.User}}')) || SIDECAR_IMAGE_USER;
    const conf = (await inspect(docker, container, '{{range .Config.Env}}{{println .}}{{end}}'))
        .split('\n')
        .find((line) => line.startsWith(`${SOFTHSM2_CONF_VARIABLE}=`))
        ?.slice(SOFTHSM2_CONF_VARIABLE.length + 1);
    return { image, owner: user.includes(':') ? user : `${user}:${user}`, ...(conf ? { softhsmConf: conf } : {}) };
}

/** The variables the token scripts read from the sidecar: SOFTHSM2_CONF (when set) and the owner of the token files. */
export function sidecarEnvironment(facts: SidecarFacts): Record<string, string> {
    return { ...(facts.softhsmConf ? { [SOFTHSM2_CONF_VARIABLE]: facts.softhsmConf } : {}), TOKEN_OWNER: facts.owner };
}

/** `-e NAME` per variable: docker copies each value from its own environment, so no value is on the command line. */
export function passThrough(environment: Record<string, string>): string[] {
    return Object.keys(environment).flatMap((name) => ['-e', name]);
}

/**
 * The `docker run` argv of a token script: as root in the sidecar's image, with the sidecar's volumes, the script
 * mounted read-only and run by `sh`; values only as `-e NAME`.
 */
export function scriptRunArgs(container: string, facts: SidecarFacts, scriptPath: string, mountedAs: string, environment: Record<string, string>): string[] {
    return [
        'run', '--rm', '--user', '0', '--volumes-from', container,
        '--entrypoint', 'sh',
        '-v', `${scriptPath}:${mountedAs}:ro`,
        ...passThrough(environment),
        facts.image, mountedAs,
    ];
}
