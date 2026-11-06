/**
 * requireTool — preflight for runner tools a `@needs:<tool>` row depends on; returns undefined when usable, else the skip reason (never
 * counted as coverage). OpenSSL must be 3.x with `cmp` (LibreSSL is refused); under `REG_UNIT_NO_DOCKER=1` docker must be a fake.
 */
import { spawnSync } from 'child_process';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { settings } from './run/settings';

export type Tool = 'openssl' | 'sscep' | 'docker' | 'kubectl';

const VERSION_ARGS: Record<Tool, string[]> = {
    openssl: ['version'],
    sscep: ['-h'],
    docker: ['--version'],
    kubectl: ['version', '--client'],
};

export function parseOpenSslVersion(text: string): { major: number; minor: number } | undefined {
    const m = /^OpenSSL (\d+)\.(\d+)/.exec(text.trim());
    return m ? { major: Number(m[1]), minor: Number(m[2]) } : undefined;
}

function unitScratchRoots(): string[] {
    const real = (p: string): string | undefined => {
        try {
            return fs.realpathSync(p);
        } catch {
            return undefined;
        }
    };
    return [path.resolve(__dirname, '..', '..', 'test-results'), real(os.tmpdir()), real('/tmp')]
        .filter((r): r is string => !!r)
        .map((r) => (fs.existsSync(r) ? fs.realpathSync(r) : r));
}

/**
 * Under the unit tests a docker binary must be a FAKE: an absolute path, through every symlink, inside `test-results` or the temp
 * directory. Returns why not, or undefined.
 */
export function unitDockerBinProblem(bin: string): string | undefined {
    if (!path.isAbsolute(bin)) return 'the real docker CLI is disabled under the unit tests: REG_DOCKER_BIN must be an absolute path to a fake (test output or temp directory)';
    let resolved: string;
    try {
        resolved = fs.existsSync(bin) ? fs.realpathSync(bin) : path.join(fs.realpathSync(path.dirname(bin)), path.basename(bin));
    } catch {
        resolved = path.resolve(bin);
    }
    const inside = unitScratchRoots().some((root) => resolved === root || resolved.startsWith(root + path.sep));
    return inside ? undefined : 'the real docker CLI is disabled under the unit tests: REG_DOCKER_BIN must name a fake inside the test output or the temp directory';
}

/**
 * The docker binary: REG_DOCKER_BIN, else `docker`. Under `REG_UNIT_NO_DOCKER=1` the real docker is never run: a test injects the seam or
 * names a fake (see `unitDockerBinProblem`).
 */
export function dockerBin(env: NodeJS.ProcessEnv): string | { error: string } {
    const { unitNoDocker: unit, dockerBinOverride: override } = settings(env);
    if (override) {
        const problem = unit ? unitDockerBinProblem(override) : undefined;
        return problem ? { error: problem } : override;
    }
    if (unit) return { error: 'the real docker CLI is disabled under the unit tests (inject the seam or a fake REG_DOCKER_BIN)' };
    return 'docker';
}

function run(cmd: string, args: string[]): { ok: boolean; out: string } {
    const r = spawnSync(cmd, args, { encoding: 'utf8', timeout: 15_000 });
    return { ok: !r.error, out: `${r.stdout ?? ''}${r.stderr ?? ''}` };
}

export function requireTool(tool: Tool, cmd: string = settings().toolBin(tool)): string | undefined {
    // Under the unit tests this never runs the real docker either.
    if (tool === 'docker') {
        const bin = dockerBin({ ...process.env, REG_DOCKER_BIN: cmd });
        if (typeof bin !== 'string') return bin.error;
    }
    const probe = run(cmd, VERSION_ARGS[tool]);
    if (!probe.ok) return `${tool} not found on the runner (set REG_${tool.toUpperCase()}_BIN or install it)`;
    if (tool === 'openssl') {
        const v = parseOpenSslVersion(probe.out);
        if (!v || v.major < 3) return `OpenSSL 3.x required, found "${probe.out.trim().split('\n')[0]}" (LibreSSL has no cmp)`;
        if (!run(cmd, ['cmp', '-help']).out.toLowerCase().includes('usage')) return 'this OpenSSL build has no cmp command';
    }
    return undefined;
}
