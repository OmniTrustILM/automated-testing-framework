/**
 * Unit tests for the estclient runner: the docker arguments, the exec hand-off, the work directory,
 * and reading the certificate, CA certificates and key estclient writes.
 */
import { test, expect } from '@playwright/test';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import * as forge from 'node-forge';
import { certToDer, createCa, issueCert } from '../../utils/estPki';
import {
    createWorkDir,
    EDGE_CA_FILE,
    estclientDockerArgs,
    readEstclientCaCertificates,
    readEstclientCertificate,
    readEstclientKey,
    runEstclient,
} from '../../utils/estClientRunner';

const ca = createCa({ cn: 'runner-unit-ca' });
const leaf = issueCert(ca, { subject: 'device' });

function certsOnlyBase64(...certs: forge.pki.Certificate[]): string {
    const p7 = forge.pkcs7.createSignedData();
    certs.forEach((c) => p7.addCertificate(c));
    return Buffer.from(forge.asn1.toDer(p7.toAsn1()).getBytes(), 'binary').toString('base64');
}

function tempDir(): string {
    return fs.mkdtempSync(path.join(os.tmpdir(), 'runner-unit-'));
}

const run = { image: 'local/estclient:1', baseUrl: 'https://ilm.est.test:8443', workDir: '/tmp/w', args: ['-g', '-o', '/work/g'] };

test('the docker arguments map the edge host, mount the work dir and trust the edge CA', () => {
    expect(estclientDockerArgs(run)).toEqual([
        'run', '--rm', '--add-host', 'ilm.est.test:host-gateway', '-v', '/tmp/w:/work',
        '-e', `EST_OPENSSL_CACERT=/work/${EDGE_CA_FILE}`, 'local/estclient:1',
        '-s', 'ilm.est.test', '-p', '8443', '-g', '-o', '/work/g',
    ]);
});

test('the port defaults to 443', () => {
    const args = estclientDockerArgs({ ...run, baseUrl: 'https://ilm.example.com' });
    expect(args.slice(args.indexOf('-p'), args.indexOf('-p') + 2)).toEqual(['-p', '443']);
});

test('runEstclient hands docker and the arguments to exec', async () => {
    const seen: Array<[string, string[]]> = [];
    const result = await runEstclient(run, async (file, args) => {
        seen.push([file, args]);
        return { code: 0, output: 'done' };
    });
    expect(result).toEqual({ code: 0, output: 'done' });
    expect(seen).toEqual([['docker', estclientDockerArgs(run)]]);
});

test('runEstclient reports a command that cannot start as a failure', async () => {
    const result = await runEstclient(run, async () => ({ code: 1, output: 'spawn docker ENOENT' }));
    expect(result.code).toBe(1);
});

test('createWorkDir copies the edge CA into a fresh directory', () => {
    const parent = tempDir();
    const caFile = path.join(parent, 'ca.pem');
    fs.writeFileSync(caFile, 'PEM');
    const dir = createWorkDir(parent, caFile);
    expect(fs.readFileSync(path.join(dir, EDGE_CA_FILE), 'utf8')).toBe('PEM');
});

test('the certificate and the CA certificates are read from their PKCS#7 files', () => {
    const dir = tempDir();
    fs.writeFileSync(path.join(dir, 'cert-0-0.pkcs7'), `${certsOnlyBase64(leaf.cert)}\n`);
    fs.writeFileSync(path.join(dir, 'cacert-0-0.pkcs7'), certsOnlyBase64(ca.cert, leaf.cert));
    expect(readEstclientCertificate(dir)).toEqual(certToDer(leaf.cert));
    expect(readEstclientCaCertificates(dir)).toEqual([certToDer(ca.cert), certToDer(leaf.cert)]);
});

test('reading fails when estclient wrote nothing', () => {
    const dir = tempDir();
    expect(() => readEstclientCertificate(dir)).toThrow('wrote no certificate');
    expect(() => readEstclientCaCertificates(dir)).toThrow('wrote no CA certificates');
    expect(() => readEstclientKey(dir)).toThrow('wrote no key');
});

test('more than one certificate in the enrollment output is refused', () => {
    const dir = tempDir();
    fs.writeFileSync(path.join(dir, 'cert-0-0.pkcs7'), certsOnlyBase64(ca.cert, leaf.cert));
    expect(() => readEstclientCertificate(dir)).toThrow('wrote 2 certificates');
});

test('the key is read from the key file as DER', () => {
    const dir = tempDir();
    const der = Buffer.from([0x30, 0x03, 0x02, 0x01, 0x00]);
    fs.writeFileSync(path.join(dir, 'key-x-0.pkcs8'), `${der.toString('base64')}\r\n`);
    expect(readEstclientKey(dir)).toEqual(der);
});
