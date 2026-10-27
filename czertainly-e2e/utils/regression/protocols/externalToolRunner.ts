/**
 * externalToolRunner — the one place a protocol test starts an external client.
 *
 * WHAT: the one place a protocol test starts an external client (`sscep`, `openssl cmp`): synchronous,
 *       bounded by a timeout, output captured, arguments passed as a list (never a shell). The binary is the one
 *       `tools.requireTool` probed, so a test runs exactly the binary its preflight accepted.
 * WHY: Protocol tests run `sscep` and `openssl cmp` and must run exactly the binary the preflight accepted.
 * HOW: Synchronous, bounded by a timeout, output captured, arguments as a list and never a shell.
 */
import { spawnSync } from 'child_process';
import * as fs from 'fs';
import * as path from 'path';
import type { Tool } from '../requireTool';
import { settings } from '../run/settings';

export interface ToolRun {
    /** The binary as invoked. */
    command: string;
    args: string[];
    /** null when the process was killed (timeout) or could not start. */
    exitCode: number | null;
    stdout: string;
    stderr: string;
    /** stdout followed by stderr: what the parsers read (tools print their status on either). */
    output: string;
    timedOut: boolean;
    /** The spawn error (binary missing, not executable), if any. */
    error?: string;
}

/** The command `requireTool(tool)` probes by default: the `REG_<TOOL>_BIN` override, else the bare name on PATH. */
export function toolCommand(tool: Tool, env: NodeJS.ProcessEnv = process.env): string {
    return settings(env).toolBin(tool);
}

export interface RunToolOptions {
    /** Working directory: every file the tool reads or writes lives under the test output (never the clone). */
    cwd: string;
    timeoutMs?: number;
    /** Extra environment for the tool (added to the minimal child environment, never the whole process environment). */
    env?: NodeJS.ProcessEnv;
    /** Text given on stdin, if any. */
    input?: string;
}

/** The process variables a child tool gets (plus `opts.env`): where to find binaries and temp files, the locale, OpenSSL's own. */
const CHILD_ENV_KEYS: readonly string[] = ['PATH', 'HOME', 'TMPDIR', 'TMP', 'TEMP', 'LANG', 'LC_ALL', 'SYSTEMROOT', 'OPENSSL_CONF', 'OPENSSL_MODULES', 'SSL_CERT_FILE', 'SSL_CERT_DIR'];

/**
 * The environment of a child tool: the listed keys of `base` that are set, then `extra` (the run's credentials and run id never reach a
 * tool).
 */
export function childEnv(extra: NodeJS.ProcessEnv = {}, base: NodeJS.ProcessEnv = process.env): NodeJS.ProcessEnv {
    const out: NodeJS.ProcessEnv = {};
    for (const k of CHILD_ENV_KEYS) if (base[k] !== undefined) out[k] = base[k];
    return { ...out, ...extra };
}

/** Runs `cmd args…` without a shell; never throws (a missing binary is `error`, a timeout is `timedOut`). */
export function runTool(cmd: string, args: string[], opts: RunToolOptions): ToolRun {
    const r = spawnSync(cmd, args, {
        cwd: opts.cwd,
        encoding: 'utf8',
        timeout: opts.timeoutMs ?? 120_000,
        env: childEnv(opts.env),
        input: opts.input,
        maxBuffer: 16 * 1024 * 1024,
    });
    const stdout = r.stdout ?? '';
    const stderr = r.stderr ?? '';
    // Node reports a timeout as error.code ETIMEDOUT (the child killed with SIGTERM, no exit status).
    const timedOut = (r.error as NodeJS.ErrnoException | undefined)?.code === 'ETIMEDOUT' || (r.signal === 'SIGTERM' && r.status === null);
    return {
        command: cmd,
        args: [...args],
        exitCode: r.status,
        stdout,
        stderr,
        output: `${stdout}${stdout && stderr ? '\n' : ''}${stderr}`,
        timedOut,
        ...(r.error && !timedOut ? { error: r.error.message } : {}),
    };
}

/** Creates (or empties nothing of) a working directory under the test output for a tool run; returns its absolute path. */
export function prepareWorkDir(dir: string): string {
    fs.mkdirSync(dir, { recursive: true });
    return path.resolve(dir);
}

/**
 * Writes a tool input (a key, a CSR) under the working directory and returns its absolute path. Specs never write files
 * themselves (lint `fs-write`); the runner layer does, and only under the test output.
 */
export function writeWorkFile(cwd: string, name: string, content: string | Buffer): string {
    if (path.isAbsolute(name) || name.includes('..') || name.includes('/')) throw new Error(`writeWorkFile: "${name}" must be a plain file name under the working directory`);
    const file = path.join(cwd, name);
    fs.writeFileSync(file, content);
    return file;
}

/** One line for a failure message: the command, its exit, and the first lines of its output (never the environment). */
export function describeRun(run: ToolRun, lines = 12): string {
    const head = run.output.split(/\r?\n/).filter((l) => l.trim()).slice(0, lines).join('\n');
    const exit = run.timedOut ? 'timed out' : run.error ? `could not start (${run.error})` : `exit ${run.exitCode}`;
    return `${run.command} ${run.args.join(' ')} → ${exit}\n${head}`;
}
