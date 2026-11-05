/**
 * sscepClient — runs `sscep` for `getca` and `enroll` (PKCSReq, no long pending wait) and reads its `pkistatus` / `failinfo` output; every
 * file lives under the test's output directory.
 */
import * as fs from 'fs';
import * as path from 'path';
import { certificateFacts, certificatePems } from './protocolResponseReaders';
import { describeRun, runTool, ToolRun, toolCommand } from './externalToolRunner';

export type CertificateFacts = ReturnType<typeof certificateFacts>;

export type SscepCipher = '3des' | 'aes';
export type SscepDigest = 'sha1' | 'sha256';

export interface SscepStatus {
    pkiStatus?: 'SUCCESS' | 'FAILURE' | 'PENDING';
    failInfo?: string;
}

const FAIL_INFO_BY_NUMBER: Record<string, string> = { '0': 'badAlg', '1': 'badMessageCheck', '2': 'badRequest', '3': 'badTime', '4': 'badCertId' };

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
    url: string;
    cwd: string;
    cmd?: string;
    timeoutMs?: number;
    verbose?: boolean;
}

export interface SscepGetCaOptions extends SscepBase {
    caFile: string;
}

export interface SscepGetCaResult extends ToolRun {
    files: string[];
}

const commonArgs = (o: SscepBase): string[] => ['-u', o.url, ...(o.verbose ? ['-v'] : [])];

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
    caCertFile: string;
    encCertFile?: string;
    keyFile: string;
    csrFile: string;
    certOutFile: string;
    cipher?: SscepCipher;
    digest?: SscepDigest;
    pollAttempts?: number;
    pollIntervalS?: number;
    pollMaxS?: number;
}

export interface SscepEnrollResult extends ToolRun, SscepStatus {
    certificatePem?: string;
}

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

export function certificatesOfFile(file: string): CertificateFacts[] {
    const raw = fs.readFileSync(file);
    const pems = certificatePems(raw.toString('utf8'));
    return pems.length ? pems.map((p) => certificateFacts(p)) : [certificateFacts(raw)];
}

export function describeSscep(run: SscepEnrollResult | SscepGetCaResult): string {
    const status = 'pkiStatus' in run ? ` pkistatus=${run.pkiStatus ?? '-'} failInfo=${run.failInfo ?? '-'}` : '';
    return `${describeRun(run)}${status}`;
}
