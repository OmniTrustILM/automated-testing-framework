/**
 * Protocols area (B2 / B3) — the tool runners against FAKE binaries written under the test output (never a real
 * sscep / openssl): the arguments that reach the tool (one argv entry per value, no shell), the minimal child
 * environment, the files the runner reads back (PEM and DER), the parsed status, a missing binary and a timeout. The
 * fakes are node scripts; the PATH is not consulted (the runner gets the command).
 */
import { expect, test } from '@playwright/test';
import * as fs from 'fs';
import * as path from 'path';
import { CMP_SECRET_ENV, opensslCmp } from '../../utils/regression/cmpRunner';
import { selfSignedPem } from '../../utils/regression/pki';
import { certificateFacts, pemToDer } from '../../utils/regression/protocolPki';
import { certificatesOfFile, sscepEnroll, sscepGetCa } from '../../utils/regression/sscepRunner';
import { prepareWorkDir, runTool, writeWorkFile } from '../../utils/regression/toolRun';

/** A fake tool: logs its arguments to `<dir>/args.json` and its environment to `<dir>/env.json`, runs `body`, exits `code`. */
function fakeTool(dir: string, name: string, body: string, code = 0): string {
    fs.mkdirSync(dir, { recursive: true });
    const file = path.join(dir, name);
    fs.writeFileSync(file, `#!${process.execPath}\nconst fs = require('fs'); const path = require('path'); const args = process.argv.slice(2); const cwd = process.cwd();\n` +
        `fs.writeFileSync(path.join(${JSON.stringify(dir)}, 'args.json'), JSON.stringify(args));\n` +
        `fs.writeFileSync(path.join(${JSON.stringify(dir)}, 'env.json'), JSON.stringify(process.env));\n${body}\nprocess.exit(${code});\n`);
    fs.chmodSync(file, 0o755);
    return file;
}

const argsOf = (dir: string): string[] => JSON.parse(fs.readFileSync(path.join(dir, 'args.json'), 'utf8')) as string[];
const envOf = (dir: string): Record<string, string> => JSON.parse(fs.readFileSync(path.join(dir, 'env.json'), 'utf8')) as Record<string, string>;

test('sscep getca: the CA files the fake writes are listed in order and read back as certificates (PEM and DER files)', ({}, testInfo) => {
    const dir = testInfo.outputPath('getca');
    const cwd = prepareWorkDir(path.join(dir, 'work'));
    const a = selfSignedPem('qa-unit-getca-a').pem;
    const b = selfSignedPem('qa-unit-getca-b').pem;
    const bDer = pemToDer(b).toString('base64');
    const fake = fakeTool(dir, 'sscep', `const c = args[args.indexOf('-c') + 1]; fs.writeFileSync(path.join(cwd, c + '-0'), ${JSON.stringify(a)}); fs.writeFileSync(path.join(cwd, c + '-1'), Buffer.from(${JSON.stringify(bDer)}, 'base64')); console.log('sscep: CA certificate written as ' + c + '-0');`);
    const got = sscepGetCa({ url: 'https://ilm.example/api/v1/protocols/scep/raProfile/r/pkiclient.exe', caFile: 'ca.crt', cwd, cmd: fake });
    expect(got.exitCode).toBe(0);
    expect(argsOf(dir)).toEqual(['getca', '-u', 'https://ilm.example/api/v1/protocols/scep/raProfile/r/pkiclient.exe', '-c', 'ca.crt']);
    expect(got.files.map((f) => path.basename(f))).toEqual(['ca.crt-0', 'ca.crt-1']);
    expect(certificatesOfFile(got.files[0])[0].commonName).toBe('qa-unit-getca-a');
    // The second file is DER: the DER branch reads it to the same facts as the PEM.
    expect(certificatesOfFile(got.files[1])[0].fingerprint).toBe(certificateFacts(b).fingerprint);
    expect(certificatesOfFile(got.files[1])[0].commonName).toBe('qa-unit-getca-b');
});

test('sscep enroll: cipher, digest, verbose and poll flags reach the tool; SUCCESS and the written certificate are read', ({}, testInfo) => {
    const dir = testInfo.outputPath('enroll');
    const cwd = prepareWorkDir(path.join(dir, 'work'));
    const issued = selfSignedPem('qa-unit-enrolled').pem;
    const fake = fakeTool(dir, 'sscep', `const l = args[args.indexOf('-l') + 1]; fs.writeFileSync(path.join(cwd, l), ${JSON.stringify(issued)}); console.log('sscep: pkistatus: SUCCESS\\nsscep: certificate written as ' + l);`);
    writeWorkFile(cwd, 'k.pem', 'key');
    writeWorkFile(cwd, 'r.csr', 'csr');
    const res = sscepEnroll({ url: 'https://ilm.example/x/pkiclient.exe', caCertFile: 'ca.crt-0', keyFile: 'k.pem', csrFile: 'r.csr', certOutFile: 'out.crt', cipher: 'aes', digest: 'sha256', cwd, cmd: fake, verbose: true });
    expect(res.exitCode).toBe(0);
    expect(res.pkiStatus).toBe('SUCCESS');
    expect(certificateFacts(res.certificatePem!).commonName).toBe('qa-unit-enrolled');
    expect(argsOf(dir)).toEqual(['enroll', '-u', 'https://ilm.example/x/pkiclient.exe', '-v', '-c', 'ca.crt-0', '-e', 'ca.crt-0', '-k', 'k.pem', '-r', 'r.csr', '-l', 'out.crt', '-E', 'aes', '-S', 'sha256', '-n', '1', '-t', '5', '-T', '15']);
});

test('sscep enroll: a FAILURE with a failinfo is read and no certificate is returned', ({}, testInfo) => {
    const dir = testInfo.outputPath('enroll-fail');
    const cwd = prepareWorkDir(path.join(dir, 'work'));
    const fake = fakeTool(dir, 'sscep', `console.error('sscep: pkistatus: FAILURE\\nsscep: failinfo: badMessageCheck');`, 1);
    const res = sscepEnroll({ url: 'https://ilm.example/x/pkiclient.exe', caCertFile: 'ca', keyFile: 'k', csrFile: 'r', certOutFile: 'out.crt', cwd, cmd: fake });
    expect(res.exitCode).toBe(1);
    expect(res.pkiStatus).toBe('FAILURE');
    expect(res.failInfo).toBe('badMessageCheck');
    expect(res.certificatePem).toBeUndefined();
});

test('openssl cmp: the arguments reach the tool, the secret only through the environment, the certificate is read back, a rejection is parsed', ({}, testInfo) => {
    const dir = testInfo.outputPath('cmp');
    const cwd = prepareWorkDir(path.join(dir, 'work'));
    const issued = selfSignedPem('qa-unit-cmp').pem;
    const ok = fakeTool(dir, 'openssl', `const o = args[args.indexOf('-certout') + 1]; fs.writeFileSync(path.join(cwd, o), ${JSON.stringify(issued)}); console.log('CMP info: received IP\\nCMP info: received PKICONF');`);
    const secret = `qa-unit-${Date.now().toString(36)}`;
    const res = opensslCmp({ command: 'ir', server: 'https://ilm.example', path: '/api/v1/protocols/cmp/raProfile/r', secret, ref: 'ref', newKey: 'k.pem', subject: '/CN=qa-unit-cmp', certOut: 'c.pem', cwd, bin: ok });
    expect(res.exitCode).toBe(0);
    expect(certificateFacts(res.certificatePem!).commonName).toBe('qa-unit-cmp');
    expect(argsOf(dir).slice(0, 3)).toEqual(['cmp', '-cmd', 'ir']);
    expect(argsOf(dir)).toEqual(expect.arrayContaining(['-secret', `env:${CMP_SECRET_ENV}`, '-path', '/api/v1/protocols/cmp/raProfile/r']));
    expect(argsOf(dir).join(' ')).not.toContain(secret);
    expect(envOf(dir)[CMP_SECRET_ENV]).toBe(secret);

    const rejected = fakeTool(dir, 'openssl-rr', `console.error('CMP error: received error:PKIStatus: rejection; PKIFailureInfo: certRevoked; StatusString: "already revoked"');`, 1);
    const rr = opensslCmp({ command: 'rr', server: 'https://ilm.example', path: '/p', secret, oldCert: 'c.pem', cwd, bin: rejected });
    expect(rr.exitCode).toBe(1);
    expect(rr.pkiStatus).toBe('rejection');
    expect(rr.failInfo).toEqual(['certRevoked']);
    expect(rr.statusStrings).toEqual(['already revoked']);
    expect(rr.certificatePem).toBeUndefined();
});

test('runTool: a value with spaces, quotes, `;` and `$(…)` reaches the tool as ONE argument (no shell); the child environment is minimal', ({}, testInfo) => {
    const dir = testInfo.outputPath('argv');
    const cwd = prepareWorkDir(path.join(dir, 'work'));
    const fake = fakeTool(dir, 'echo-args', '');
    const hostile = `a b; "c" 'd' $(touch ${path.join(dir, 'pwned')}) | e & f`;
    const run = runTool(fake, ['-subject', hostile, '--', '*'], { cwd, env: { QA_EXTRA: '1' } });
    expect(run.exitCode).toBe(0);
    expect(argsOf(dir)).toEqual(['-subject', hostile, '--', '*']);
    expect(fs.existsSync(path.join(dir, 'pwned'))).toBe(false);
    const env = envOf(dir);
    expect(env.QA_EXTRA).toBe('1');
    expect(env.PATH).toBeTruthy();
    for (const k of Object.keys(env)) expect(k, `child env key ${k}`).toMatch(/^(PATH|HOME|TMPDIR|TMP|TEMP|LANG|LC_ALL|SYSTEMROOT|OPENSSL_CONF|OPENSSL_MODULES|SSL_CERT_FILE|SSL_CERT_DIR|QA_EXTRA|__CF_USER_TEXT_ENCODING)$/);
    expect(env.REG_RUN_ID).toBeUndefined();
});

test('runTool: a missing binary is an error, a hanging one times out; nothing throws', ({}, testInfo) => {
    const dir = testInfo.outputPath('run');
    const cwd = prepareWorkDir(path.join(dir, 'work'));
    const missing = runTool(path.join(dir, 'no-such-tool'), ['x'], { cwd });
    expect(missing.exitCode).toBeNull();
    expect(missing.error).toMatch(/ENOENT/);
    // A synchronous 10 s wait: the fake must still be running when the 500 ms timeout kills it.
    const hang = fakeTool(dir, 'hang', `Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 10000);`);
    const slow = runTool(hang, [], { cwd, timeoutMs: 500 });
    expect(slow.timedOut).toBe(true);
    expect(slow.exitCode).toBeNull();
});

test('writeWorkFile refuses paths that leave the working directory', ({}, testInfo) => {
    const cwd = prepareWorkDir(testInfo.outputPath('wf'));
    expect(() => writeWorkFile(cwd, '../x.pem', 'x')).toThrow(/plain file name/);
    expect(() => writeWorkFile(cwd, '/etc/x', 'x')).toThrow(/plain file name/);
    expect(fs.readFileSync(writeWorkFile(cwd, 'ok.pem', 'content'), 'utf8')).toBe('content');
});
