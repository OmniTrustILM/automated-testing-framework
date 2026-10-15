/**
 * sscepRunner — thin wrapper around the `sscep` client (D2: no hand-written SCEP client) for REG-PROT-07 / 08:
 * `sscep getca` (RFC 8894 §4.2 GetCACert: the CA material, one file per certificate when the answer is a chain) and
 * `sscep enroll` (PKCSReq with the CSR's challengePassword; `-n 1 -t 5 -T 15` per the ilm#430 note so a pending
 * answer returns at once). The binary is the one `tools.requireTool('sscep')` probed (`REG_SSCEP_BIN`, else PATH);
 * every file lives under the test's output directory.
 *
 * Output parsing is tolerant: sscep prints `pkistatus: SUCCESS | FAILURE | PENDING` and, on a failure, the
 * `failinfo` the CertRep carried (older builds print the number instead of the name; both are read).
 */
import * as fs from 'fs';
import * as path from 'path';
import { certificateFacts, certificatePems } from './protocolPki';
import { describeRun, runTool, ToolRun, toolCommand } from './toolRun';

export type CertificateFacts = ReturnType<typeof certificateFacts>;

export type SscepCipher = '3des' | 'aes';
export type SscepDigest = 'sha1' | 'sha256';

export interface SscepStatus {
    pkiStatus?: 'SUCCESS' | 'FAILURE' | 'PENDING';
    /** failInfo name (RFC 8894 §3.2.1.4), when sscep printed one. */
    failInfo?: string;
}

/** RFC 8894 failInfo numbers → names (sscep may print the number). */
const FAIL_INFO_BY_NUMBER: Record<string, string> = { '0': 'badAlg', '1': 'badMessageCheck', '2': 'badRequest', '3': 'badTime', '4': 'badCertId' };

/** Reads `pkistatus:` and `failinfo:` / `failInfo:` lines from sscep's output (any case, name or number). */
export function parseSscepOutput(text: string): SscepStatus {
    const out: SscepStatus = {};
    const status = /pkistatus:\s*([A-Za-z]+)/i.exec(text);
    if (status) {
        const s = status[1].toUpperCase();
        if (s === 'SUCCESS' || s === 'FAILURE' || s === 'PENDING') out.pkiStatus = s;
    }
    const fail = /fail\s*info:\s*([A-Za-z0-9]+)/i.exec(text);
    if (fail) out.failInfo = FAIL_INFO_BY_NUMBER[fail[1]] ?? fail[1];
    return out;
}

export interface SscepBase {
    /** The SCEP URL (`…/pkiclient.exe`). */
    url: string;
    /** Working directory under the test output; every file path below is relative to it unless absolute. */
    cwd: string;
    /** The sscep binary (default: what `requireTool('sscep')` probes). */
    cmd?: string;
    timeoutMs?: number;
    /** Verbose output (`-v`): status lines are printed either way; `-d` adds debugging. */
    verbose?: boolean;
}

export interface SscepGetCaOptions extends SscepBase {
    /** The CA certificate file sscep writes (`<file>` for one certificate, `<file>-0`, `<file>-1`, … for a chain). */
    caFile: string;
}

export interface SscepGetCaResult extends ToolRun {
    /** The CA files that exist after the call, in sscep's order (`<file>`, then `<file>-0`, `-1`, …). */
    files: string[];
}

const commonArgs = (o: SscepBase): string[] => ['-u', o.url, ...(o.verbose ? ['-v'] : [])];

/** `sscep getca -u <url> -c <caFile>`: the CA material written as one or several files. */
export function sscepGetCa(o: SscepGetCaOptions): SscepGetCaResult {
    const run = runTool(o.cmd ?? toolCommand('sscep'), ['getca', ...commonArgs(o), '-c', o.caFile], { cwd: o.cwd, timeoutMs: o.timeoutMs ?? 60_000 });
    const abs = path.isAbsolute(o.caFile) ? o.caFile : path.join(o.cwd, o.caFile);
    const files: string[] = [];
    if (fs.existsSync(abs)) files.push(abs);
    for (let i = 0; i < 32; i++) {
        const f = `${abs}-${i}`;
        if (!fs.existsSync(f)) break;
        files.push(f);
    }
    return { ...run, files };
}

export interface SscepEnrollOptions extends SscepBase {
    /** The CA (signer) certificate file (`-c`). */
    caCertFile: string;
    /** The encryption (RA) certificate file (`-e`); default: the CA certificate. */
    encCertFile?: string;
    /** The private key of the CSR (`-k`, PEM). */
    keyFile: string;
    /** The CSR (`-r`, PEM). */
    csrFile: string;
    /** Where the issued certificate is written (`-l`, PEM). */
    certOutFile: string;
    /** PKCS#7 encryption algorithm (`-E`). */
    cipher?: SscepCipher;
    /** PKCS#7 signature digest (`-S`). */
    digest?: SscepDigest;
    /** Poll settings (`-n`, `-t`, `-T`); defaults per the ilm#430 note. */
    pollAttempts?: number;
    pollIntervalS?: number;
    pollMaxS?: number;
}

export interface SscepEnrollResult extends ToolRun, SscepStatus {
    /** The issued certificate (PEM), when the output file exists. */
    certificatePem?: string;
}

/** `sscep enroll …`: PKCSReq with the CSR, the CA material, the chosen cipher / digest, one poll. */
export function sscepEnroll(o: SscepEnrollOptions): SscepEnrollResult {
    const args = [
        'enroll', ...commonArgs(o),
        '-c', o.caCertFile, '-e', o.encCertFile ?? o.caCertFile,
        '-k', o.keyFile, '-r', o.csrFile, '-l', o.certOutFile,
        ...(o.cipher ? ['-E', o.cipher] : []), ...(o.digest ? ['-S', o.digest] : []),
        '-n', String(o.pollAttempts ?? 1), '-t', String(o.pollIntervalS ?? 5), '-T', String(o.pollMaxS ?? 15),
    ];
    const run = runTool(o.cmd ?? toolCommand('sscep'), args, { cwd: o.cwd, timeoutMs: o.timeoutMs ?? 90_000 });
    const abs = path.isAbsolute(o.certOutFile) ? o.certOutFile : path.join(o.cwd, o.certOutFile);
    const certificatePem = fs.existsSync(abs) ? fs.readFileSync(abs, 'utf8') : undefined;
    return { ...run, ...parseSscepOutput(run.output), ...(certificatePem ? { certificatePem } : {}) };
}

/** The certificates (facts) of a file sscep wrote: PEM blocks, else one DER certificate. */
export function certificatesOfFile(file: string): CertificateFacts[] {
    const raw = fs.readFileSync(file);
    const pems = certificatePems(raw.toString('utf8'));
    return pems.length ? pems.map((p) => certificateFacts(p)) : [certificateFacts(raw)];
}

/** A failure message for an unexpected sscep result (command, exit, status, first output lines). */
export function describeSscep(run: SscepEnrollResult | SscepGetCaResult): string {
    const status = 'pkiStatus' in run ? ` pkistatus=${run.pkiStatus ?? '-'} failInfo=${run.failInfo ?? '-'}` : '';
    return `${describeRun(run)}${status}`;
}
