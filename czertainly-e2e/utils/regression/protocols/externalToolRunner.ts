/**
 * externalToolRunner — the one place a protocol test starts an external client (`sscep`, `openssl cmp`): synchronous, bounded by a timeout,
 * arguments as a list (never a shell).
 */
import { spawnSync } from 'child_process';
import * as fs from 'fs';
import * as path from 'path';
import type { Tool } from '../requireTool';
import { settings } from '../run/settings';

export interface ToolRun {
    command: string;
    args: string[];
    exitCode: number | null;
    stdout: string;
    stderr: string;
    output: string;
    timedOut: boolean;
    error?: string;
}

export function toolCommand(tool: Tool, env: NodeJS.ProcessEnv = process.env): string {
    return settings(env).toolBin(tool);
}

export interface RunToolOptions {
    cwd: string;
    timeoutMs?: number;
    env?: NodeJS.ProcessEnv;
    input?: string;
}

const CHILD_ENV_KEYS: readonly string[] = ['PATH', 'HOME', 'TMPDIR', 'TMP', 'TEMP', 'LANG', 'LC_ALL', 'SYSTEMROOT', 'OPENSSL_CONF', 'OPENSSL_MODULES', 'SSL_CERT_FILE', 'SSL_CERT_DIR'];

/** The environment of a child tool: the listed keys of `base` that are set, then `extra`; the run's credentials never reach a tool. */
export function childEnv(extra: NodeJS.ProcessEnv = {}, base: NodeJS.ProcessEnv = process.env): NodeJS.ProcessEnv {
    const out: NodeJS.ProcessEnv = {};
    for (const k of CHILD_ENV_KEYS) if (base[k] !== undefined) out[k] = base[k];
    return { ...out, ...extra };
}

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

export function prepareWorkDir(dir: string): string {
    fs.mkdirSync(dir, { recursive: true });
    return path.resolve(dir);
}

/** Writes a tool input (a key, a CSR) under the working directory; specs may not write files themselves (lint `fs-write`). */
export function writeWorkFile(cwd: string, name: string, content: string | Buffer): string {
    if (path.isAbsolute(name) || name.includes('..') || name.includes('/')) throw new Error(`writeWorkFile: "${name}" must be a plain file name under the working directory`);
    const file = path.join(cwd, name);
    fs.writeFileSync(file, content);
    return file;
}

export function describeRun(run: ToolRun, lines = 12): string {
    const head = run.output.split(/\r?\n/).filter((l) => l.trim()).slice(0, lines).join('\n');
    const exit = run.timedOut ? 'timed out' : run.error ? `could not start (${run.error})` : `exit ${run.exitCode}`;
    return `${run.command} ${run.args.join(' ')} → ${exit}\n${head}`;
}
