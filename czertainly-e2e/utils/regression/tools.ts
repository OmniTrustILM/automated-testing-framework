/**
 * tools — preflight for runner tools a `@needs:<tool>` row depends on (OpenSSL 3 with `cmp`, sscep, docker, kubectl).
 *
 * `requireTool(name)` returns undefined when the tool is usable, else the skip reason; a spec calls it in `beforeAll`
 * and skips with that reason (a skip is never counted as coverage). OpenSSL must be 3.x and have the `cmp` command:
 * LibreSSL (the macOS default) is refused, because the CMP rows need `openssl cmp`. Under the unit tests
 * (`REG_UNIT_NO_DOCKER=1`) `docker` must be a fake (`unitDockerBinProblem`, fix pass 5).
 */
import { spawnSync } from 'child_process';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';

export type Tool = 'openssl' | 'sscep' | 'docker' | 'kubectl';

const VERSION_ARGS: Record<Tool, string[]> = {
    openssl: ['version'],
    sscep: ['-h'],
    docker: ['--version'],
    kubectl: ['version', '--client'],
};

/** "OpenSSL 3.3.1 4 Jun 2024" → { major: 3, minor: 3 }; LibreSSL and anything else → undefined. */
export function parseOpenSslVersion(text: string): { major: number; minor: number } | undefined {
    const m = /^OpenSSL (\d+)\.(\d+)/.exec(text.trim());
    return m ? { major: Number(m[1]), minor: Number(m[2]) } : undefined;
}

/** Where a FAKE docker may live under the unit tests: the suite's test output, the OS temp directory, /tmp. */
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
 * Under the unit tests (`REG_UNIT_NO_DOCKER=1`, playwright.unit.config.ts) a docker binary must be a FAKE (fix pass 5):
 * an absolute path that, through every symlink, lies inside the suite's `test-results` or the OS temp directory / /tmp.
 * `docker`, a PATH lookup or `/usr/local/bin/docker` are refused. Returns why not, or undefined.
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

function run(cmd: string, args: string[]): { ok: boolean; out: string } {
    const r = spawnSync(cmd, args, { encoding: 'utf8', timeout: 15_000 });
    return { ok: !r.error, out: `${r.stdout ?? ''}${r.stderr ?? ''}` };
}

/** undefined when the tool can be used, else why not (the skip reason). */
export function requireTool(tool: Tool, cmd: string = process.env[`REG_${tool.toUpperCase()}_BIN`] ?? tool): string | undefined {
    // Fix pass 5: under the unit tests `requireTool('docker')` never runs the real docker either.
    if (tool === 'docker' && process.env.REG_UNIT_NO_DOCKER === '1') {
        const problem = unitDockerBinProblem(cmd);
        if (problem) return problem;
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
