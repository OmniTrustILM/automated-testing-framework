/**
 * cmpClient — `openssl cmp` for ir, kur and rr.
 *
 * Runs `openssl cmp` (OpenSSL 3) with shared-secret protection, so CMP enrolment is proven by a real client, and reads the
 * PKIStatus line OpenSSL prints. The secret reaches the child through its environment (`-secret env:…`), never the command
 * line; every file lives under the test's output directory.
 */
import * as fs from 'fs';
import * as path from 'path';
import { describeRun, runTool, ToolRun, toolCommand } from './externalToolRunner';

/** The environment variable `openssl cmp -secret env:…` reads the PBM secret from. */
export const CMP_SECRET_ENV = 'REG_CMP_SECRET';

type CmpCommand = 'ir' | 'cr' | 'kur' | 'rr' | 'p10cr' | 'genm';

export interface CmpStatus {
    /** `PKIStatus:` as printed (`rejection`, `accepted`, …). */
    pkiStatus?: string;
    /** `PKIFailureInfo:` names as printed (the ", " list split; empty for `<no failure info>`). */
    failInfo: string[];
    /** `StatusString(s):` texts as printed (unquoted). */
    statusStrings: string[];
}

/** Reads the `PKIStatus: …; PKIFailureInfo: …; StatusString(s): "…"` fragments of `openssl cmp` output (OpenSSL 3 format). */
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
    /** The server origin (`-server`, scheme + host [+ port]). */
    server: string;
    /** The HTTP path of the CMP endpoint (`-path`, e.g. `/api/v1/protocols/cmp/raProfile/<ra>`). */
    path: string;
    /** The profile's shared secret: handed to the child through `REG_CMP_SECRET` (`-secret env:REG_CMP_SECRET`), never as an argument. */
    secret: string;
    /** `-ref`: the senderKID reference (any string in the default mode). */
    ref?: string;
    /** `-recipient`: a DN; the server ignores it in the default mode (default `/CN=ILM`). */
    recipient?: string;
    /** `-newkey`: the private key (PEM) of the key to certify (ir, cr, kur). */
    newKey?: string;
    /** `-subject`: the requested subject DN (`/CN=<name>`). */
    subject?: string;
    /** `-certout`: where the issued certificate is written (PEM). */
    certOut?: string;
    /** `-oldcert`: the certificate to update (kur) or revoke (rr). */
    oldCert?: string;
    /** `-revreason`: the revocation reason code (rr); absent = none (the server defaults to unspecified). */
    revReason?: number;
    /** Working directory; relative file paths resolve against it. */
    cwd: string;
    /** The openssl binary (default: what `requireTool('openssl')` probes). */
    bin?: string;
    timeoutMs?: number;
    /** Extra arguments appended as given (a test's own switches, e.g. `-popo 0`). */
    extraArgs?: string[];
}

export interface CmpResult extends ToolRun, CmpStatus {
    /** The certificate at `certOut` after the run (PEM), when it exists. */
    certificatePem?: string;
}

/** The argument list of one `openssl cmp` call (exported for the unit tests). */
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

/** Runs `openssl cmp …` and reads its status lines and the written certificate. */
export function opensslCmp(o: CmpOptions): CmpResult {
    const run = runTool(o.bin ?? toolCommand('openssl'), cmpArgs(o), { cwd: o.cwd, timeoutMs: o.timeoutMs ?? 90_000, env: { [CMP_SECRET_ENV]: o.secret } });
    let certificatePem: string | undefined;
    if (o.certOut) {
        const abs = path.isAbsolute(o.certOut) ? o.certOut : path.join(o.cwd, o.certOut);
        if (fs.existsSync(abs)) certificatePem = fs.readFileSync(abs, 'utf8');
    }
    return { ...run, ...parseOpensslCmpOutput(run.output), ...(certificatePem ? { certificatePem } : {}) };
}

/** A failure message for an unexpected result (command — the secret is not in it —, exit, status, first output lines). */
export function describeCmp(run: CmpResult): string {
    const redacted: ToolRun = { ...run, args: run.args.map((a) => (/^(pass|file):/.test(a) ? `${a.split(':')[0]}:***` : a)) };
    return `${describeRun(redacted)} PKIStatus=${run.pkiStatus ?? '-'} failInfo=${run.failInfo.join(',') || '-'}`;
}
