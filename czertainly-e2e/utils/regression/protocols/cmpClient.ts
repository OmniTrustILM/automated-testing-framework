/**
 * cmpClient — `openssl cmp` for ir, kur and rr with shared-secret protection. The secret reaches the child through its
 * environment, never the command line; every file lives under the test's output directory.
 */
import * as fs from 'fs';
import * as path from 'path';
import { describeRun, runTool, ToolRun, toolCommand } from './externalToolRunner';

export const CMP_SECRET_ENV = 'REG_CMP_SECRET';

type CmpCommand = 'ir' | 'cr' | 'kur' | 'rr' | 'p10cr' | 'genm';

export interface CmpStatus {
    pkiStatus?: string;
    failInfo: string[];
    statusStrings: string[];
}

export function parseOpensslCmpOutput(text: string): CmpStatus {
    const out: CmpStatus = { failInfo: [], statusStrings: [] };
    const status = /PKIStatus:\s*([A-Za-z]+)/.exec(text);
    if (status) out.pkiStatus = status[1];
    for (const m of text.matchAll(/PKIFailureInfo:\s*([A-Za-z]+(?:\s*,\s*[A-Za-z]+)*)/g)) {
        for (const name of m[1].split(/\s*,\s*/)) if (!out.failInfo.includes(name)) out.failInfo.push(name);
    }
    for (const m of text.matchAll(/StatusStrings?:\s*((?:"[^"]*"(?:\s*,\s*)?)+)/g)) {
        for (const s of m[1].matchAll(/"([^"]*)"/g)) out.statusStrings.push(s[1]);
    }
    return out;
}

export interface CmpOptions {
    command: CmpCommand;
    server: string;
    path: string;
    /** The profile's shared secret: handed to the child through `REG_CMP_SECRET`, never as an argument. */
    secret: string;
    ref?: string;
    recipient?: string;
    newKey?: string;
    subject?: string;
    certOut?: string;
    oldCert?: string;
    revReason?: number;
    cwd: string;
    bin?: string;
    timeoutMs?: number;
    extraArgs?: string[];
}

export interface CmpResult extends ToolRun, CmpStatus {
    certificatePem?: string;
}

export function cmpArgs(o: CmpOptions): string[] {
    return [
        'cmp', '-cmd', o.command, '-server', o.server, '-path', o.path,
        '-secret', `env:${CMP_SECRET_ENV}`, ...(o.ref ? ['-ref', o.ref] : []),
        '-recipient', o.recipient ?? '/CN=ILM',
        '-unprotected_errors',
        ...(o.newKey ? ['-newkey', o.newKey] : []),
        ...(o.subject ? ['-subject', o.subject] : []),
        ...(o.certOut ? ['-certout', o.certOut] : []),
        ...(o.oldCert ? ['-oldcert', o.oldCert] : []),
        ...(o.revReason !== undefined ? ['-revreason', String(o.revReason)] : []),
        ...(o.extraArgs ?? []),
    ];
}

export function opensslCmp(o: CmpOptions): CmpResult {
    const run = runTool(o.bin ?? toolCommand('openssl'), cmpArgs(o), { cwd: o.cwd, timeoutMs: o.timeoutMs ?? 90_000, env: { [CMP_SECRET_ENV]: o.secret } });
    let certificatePem: string | undefined;
    if (o.certOut) {
        const abs = path.isAbsolute(o.certOut) ? o.certOut : path.join(o.cwd, o.certOut);
        if (fs.existsSync(abs)) certificatePem = fs.readFileSync(abs, 'utf8');
    }
    return { ...run, ...parseOpensslCmpOutput(run.output), ...(certificatePem ? { certificatePem } : {}) };
}

export function describeCmp(run: CmpResult): string {
    const redacted: ToolRun = { ...run, args: run.args.map((a) => (/^(pass|file):/.test(a) ? `${a.split(':')[0]}:***` : a)) };
    return `${describeRun(redacted)} PKIStatus=${run.pkiStatus ?? '-'} failInfo=${run.failInfo.join(',') || '-'}`;
}
