/**
 * docker — the docker CLI calls of the key onboarding block, behind one injectable seam.
 * The PIN must never be on a command line: every value goes through the environment and argv carries only the variable names.
 */
import { spawn } from 'child_process';
import { dockerBin } from '../../regression/requireTool';
import { TierError } from '../../devBlocks/provision/transport';

export interface DockerResult {
    code: number;
    stdout: string;
    stderr: string;
    notStarted?: boolean;
}

export type DockerRunner = (args: string[], opts?: { env?: Record<string, string> }) => Promise<DockerResult>;

const SIDECAR_IMAGE_USER = '10001';
const SOFTHSM2_CONF_VARIABLE = 'SOFTHSM2_CONF';

export function defaultDockerRunner(processEnv: NodeJS.ProcessEnv = process.env): DockerRunner {
    return (args, opts = {}) => new Promise((resolve) => {
        const bin = dockerBin(processEnv);
        if (typeof bin !== 'string') {
            resolve({ code: 127, stdout: '', stderr: bin.error, notStarted: true });
            return;
        }
        let stdout = '';
        let stderr = '';
        let started = false;
        const child = spawn(bin, args, { env: { ...processEnv, ...opts.env }, stdio: ['ignore', 'pipe', 'pipe'] });
        child.on('spawn', () => { started = true; });
        child.stdout.on('data', (chunk: Buffer) => { stdout += chunk.toString('utf8'); });
        child.stderr.on('data', (chunk: Buffer) => { stderr += chunk.toString('utf8'); });
        child.on('error', (e) => resolve({ code: 127, stdout, stderr: `${stderr}${String(e)}`, ...(started ? {} : { notStarted: true }) }));
        child.on('close', (code) => resolve({ code: code ?? 1, stdout, stderr }));
    });
}

export async function dockerAvailable(docker: DockerRunner): Promise<boolean> {
    return (await docker(['version', '--format', '{{.Server.Version}}'])).code === 0;
}

export async function sidecarRunning(docker: DockerRunner, container: string): Promise<boolean> {
    const r = await docker(['inspect', '-f', '{{.State.Running}}', container]);
    return r.code === 0 && r.stdout.trim() === 'true';
}

export interface SidecarFacts {
    image: string;
    owner: string;
    softhsmConf?: string;
}

async function inspect(docker: DockerRunner, container: string, format: string): Promise<string> {
    const r = await docker(['inspect', '-f', format, container]);
    // The sidecar went away since the preflight: the tier's state, not the setup's error.
    if (r.code !== 0) throw new TierError(`docker inspect of the sidecar container answered exit ${r.code}`);
    return r.stdout.trim();
}

export async function sidecarFacts(docker: DockerRunner, container: string): Promise<SidecarFacts> {
    const image = await inspect(docker, container, '{{.Config.Image}}');
    const user = (await inspect(docker, container, '{{.Config.User}}')) || SIDECAR_IMAGE_USER;
    const conf = (await inspect(docker, container, '{{range .Config.Env}}{{println .}}{{end}}'))
        .split('\n')
        .find((line) => line.startsWith(`${SOFTHSM2_CONF_VARIABLE}=`))
        ?.slice(SOFTHSM2_CONF_VARIABLE.length + 1);
    return { image, owner: user.includes(':') ? user : `${user}:${user}`, ...(conf ? { softhsmConf: conf } : {}) };
}

export function sidecarEnvironment(facts: SidecarFacts): Record<string, string> {
    return { ...(facts.softhsmConf ? { [SOFTHSM2_CONF_VARIABLE]: facts.softhsmConf } : {}), TOKEN_OWNER: facts.owner };
}

/** Docker copies each value from its own environment, so no value is on the command line. */
export function passThrough(environment: Record<string, string>): string[] {
    return Object.keys(environment).flatMap((name) => ['-e', name]);
}

/** Runs as root in the sidecar's image, with the sidecar's volumes and the script mounted read-only. */
export function scriptRunArgs(container: string, facts: SidecarFacts, scriptPath: string, mountedAs: string, environment: Record<string, string>): string[] {
    return [
        'run', '--rm', '--user', '0', '--volumes-from', container,
        '--entrypoint', 'sh',
        '-v', `${scriptPath}:${mountedAs}:ro`,
        ...passThrough(environment),
        facts.image, mountedAs,
    ];
}
