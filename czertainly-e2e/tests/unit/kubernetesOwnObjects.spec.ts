/**
 * kubernetesOwnObjects — the Kubernetes ledger contract of utils/regression/kubernetesOwnObjects.ts with a fake kubectl
 * (REG_KUBECTL_BIN, a Node script that logs its arguments): an object is recorded as `k8s:<Kind>` before its apply, names
 * carry the run prefix, and `removeOwnK8sObject` deletes only ledger-proven own objects (newest first), proves them gone and
 * appends the `deleted` line; anything else is a cleanup failure, never a delete.
 */
import { test, expect } from '@playwright/test';
import * as fs from 'fs';
import * as path from 'path';
import { readCleanupFailures } from '../../utils/cleanupLedger';
import { applyOwnManifest, CERT_MANAGER_KINDS, clusterProblem, k8sUuid, K8sRef, recordOwnK8sObject, removeOwnK8sObject } from '../../utils/regression/kubernetesOwnObjects';
import { OwnObjectViolation } from '../../utils/regression/ledger/ownership';
import { readLedger } from '../../utils/regression/ledger/ledger';
import { runName } from '../../utils/regression/ledger/runState';

const KEYS = ['REG_KUBECTL_BIN', 'REG_STATE_DIR', 'CLEANUP_LEDGER_FILE', 'FAKE_KUBECTL_LOG', 'FAKE_KUBECTL_FAIL_APPLY', 'FAKE_KUBECTL_LEFT', 'FAKE_KUBECTL_NO_LIST', 'FAKE_KUBECTL_CANNOT'];
let saved: Record<string, string | undefined> = {};

test.beforeEach(({}, testInfo) => {
    saved = Object.fromEntries(KEYS.map((k) => [k, process.env[k]]));
    const dir = testInfo.outputPath('k8s');
    fs.mkdirSync(dir, { recursive: true });
    const bin = path.join(dir, 'fake-kubectl');
    // Logs argv; `apply` fails with FAKE_KUBECTL_FAIL_APPLY; `get … -o name` prints FAKE_KUBECTL_LEFT (empty = gone) and
    // fails for a resource named in FAKE_KUBECTL_NO_LIST; `auth can-i <verb> <resource>` answers yes unless
    // "<verb> <resource>" is in FAKE_KUBECTL_CANNOT (then "no", exit 1, like kubectl).
    fs.writeFileSync(bin, `#!${process.execPath}
const fs = require('fs');
const args = process.argv.slice(2);
fs.appendFileSync(process.env.FAKE_KUBECTL_LOG, args.join(' ') + '\\n');
if (args.includes('apply')) { fs.readFileSync(0); if (process.env.FAKE_KUBECTL_FAIL_APPLY) { process.stderr.write('apply refused'); process.exit(1); } }
if (args[2] === 'auth' && args[3] === 'can-i') {
  const asked = args[4] + ' ' + args[5];
  if ((process.env.FAKE_KUBECTL_CANNOT || '').split(';').includes(asked)) { process.stdout.write('no\\n'); process.exit(1); }
  process.stdout.write('yes\\n'); process.exit(0);
}
if (args.includes('get') && args.includes('name')) {
  if (process.env.FAKE_KUBECTL_NO_LIST && args.includes(process.env.FAKE_KUBECTL_NO_LIST)) { process.stderr.write('error: the server does not have a resource type'); process.exit(1); }
  process.stdout.write(process.env.FAKE_KUBECTL_LEFT || '');
}
`);
    fs.chmodSync(bin, 0o755);
    Object.assign(process.env, { REG_KUBECTL_BIN: bin, REG_STATE_DIR: testInfo.outputPath('state'), CLEANUP_LEDGER_FILE: testInfo.outputPath('cleanup.jsonl'), FAKE_KUBECTL_LOG: path.join(dir, 'calls.log') });
    delete process.env.FAKE_KUBECTL_FAIL_APPLY;
    delete process.env.FAKE_KUBECTL_LEFT;
    delete process.env.FAKE_KUBECTL_NO_LIST;
    delete process.env.FAKE_KUBECTL_CANNOT;
});

test.afterEach(() => {
    for (const [k, v] of Object.entries(saved)) {
        if (v === undefined) delete process.env[k];
        else process.env[k] = v;
    }
});

const calls = () => (fs.existsSync(process.env.FAKE_KUBECTL_LOG!) ? fs.readFileSync(process.env.FAKE_KUBECTL_LOG!, 'utf8').trim().split('\n') : []);
const manifest = (ref: K8sRef) => ({ apiVersion: 'v1', kind: ref.kind, metadata: { name: ref.name } });

test('the ledger line comes before the apply: a failing apply still leaves the k8s line', () => {
    const issuer: K8sRef = { kind: 'CzertainlyIssuer', namespace: 'ns-1', name: runName('issuer') };
    process.env.FAKE_KUBECTL_FAIL_APPLY = '1';
    expect(() => applyOwnManifest(issuer, manifest(issuer), 'T')).toThrow(/apply refused|Command failed/);
    expect(readLedger()).toEqual([expect.objectContaining({ type: 'k8s:CzertainlyIssuer', uuid: k8sUuid(issuer), name: issuer.name, event: 'created' })]);
});

test('names must carry the run prefix; a manifest must be the ref it is applied as', () => {
    expect(() => recordOwnK8sObject({ kind: 'Secret', namespace: 'ns-1', name: 'shared-secret' }, 'T')).toThrow(OwnObjectViolation);
    const cert: K8sRef = { kind: 'Certificate', namespace: 'ns-1', name: runName('cm') };
    expect(() => applyOwnManifest(cert, { ...manifest(cert), metadata: { name: 'other' } }, 'T')).toThrow(/is not the ref/);
    expect(readLedger()).toEqual([]);
    expect(calls()).toEqual([]);
});

test('removeOwnK8sObject deletes own objects newest first, proves them gone and appends deleted lines; an unrecorded one is refused', async () => {
    const issuer: K8sRef = { kind: 'CzertainlyIssuer', namespace: 'ns-1', name: runName('issuer') };
    const cert: K8sRef = { kind: 'Certificate', namespace: 'ns-1', name: runName('cm'), resource: 'certificates.cert-manager.io' };
    const stray: K8sRef = { kind: 'Secret', namespace: 'ns-1', name: runName('not-recorded') };
    applyOwnManifest(issuer, manifest(issuer), 'T');
    applyOwnManifest(cert, manifest(cert), 'T');
    await removeOwnK8sObject([issuer, cert, stray], 'T');
    const deletes = calls().filter((c) => c.includes(' delete '));
    expect(deletes).toEqual([
        `-n ns-1 delete certificates.cert-manager.io ${cert.name} --ignore-not-found --wait=true --timeout=120s`,
        `-n ns-1 delete czertainlyissuer ${issuer.name} --ignore-not-found --wait=true --timeout=120s`,
    ]);
    expect(readLedger().filter((l) => l.event === 'deleted').map((l) => l.uuid)).toEqual([k8sUuid(cert), k8sUuid(issuer)]);
    expect(readCleanupFailures()).toEqual([expect.objectContaining({ resource: 'k8s:Secret', uuid: k8sUuid(stray), message: expect.stringMatching(/no ledger "created" line/) })]);
});

test('an object still there after the delete is a cleanup failure, not a deleted line', async () => {
    const cert: K8sRef = { kind: 'Certificate', namespace: 'ns-1', name: runName('cm') };
    applyOwnManifest(cert, manifest(cert), 'T');
    process.env.FAKE_KUBECTL_LEFT = `certificate/${cert.name}`;
    await removeOwnK8sObject([cert], 'T');
    expect(readLedger().filter((l) => l.event === 'deleted')).toEqual([]);
    expect(readCleanupFailures()).toEqual([expect.objectContaining({ resource: 'k8s:Certificate', message: expect.stringMatching(/still there after the delete/) })]);
});

test('a Certificate and a Secret of the same name are two ledger objects; the Certificate goes first', async () => {
    const name = runName('cm-same');
    const secret: K8sRef = { kind: 'Secret', namespace: 'ns-1', name };
    const cert: K8sRef = { kind: 'Certificate', namespace: 'ns-1', name, resource: 'certificates.cert-manager.io' };
    expect(k8sUuid(secret)).toBe(`ns-1/${name}.secret`);
    expect(k8sUuid(cert)).toBe(`ns-1/${name}.certificate`);
    // REG-USE-06.1's order: the Secret is recorded before the Certificate is applied.
    recordOwnK8sObject(secret, 'T');
    applyOwnManifest(cert, manifest(cert), 'T');
    await removeOwnK8sObject([secret, cert], 'T');
    expect(calls().filter((c) => c.includes(' delete '))).toEqual([
        `-n ns-1 delete certificates.cert-manager.io ${name} --ignore-not-found --wait=true --timeout=120s`,
        `-n ns-1 delete secret ${name} --ignore-not-found --wait=true --timeout=120s`,
    ]);
    expect(readLedger().filter((l) => l.event === 'deleted').map((l) => l.uuid)).toEqual([k8sUuid(cert), k8sUuid(secret)]);
    expect(readCleanupFailures()).toEqual([]);
});

test('clusterProblem probes the namespace only (list + auth can-i), never a cluster-scoped object', () => {
    expect(clusterProblem('ns-1')).toBeUndefined();
    const made = calls();
    expect(made.every((c) => c.startsWith('-n ns-1 '))).toBe(true);
    expect(made.some((c) => / get (crd|namespace) /.test(` ${c} `))).toBe(false);
    for (const kind of CERT_MANAGER_KINDS) {
        expect(made).toContain(`-n ns-1 get ${kind} -o name`);
        expect(made).toContain(`-n ns-1 auth can-i create ${kind}`);
        expect(made).toContain(`-n ns-1 auth can-i delete ${kind}`);
    }
    expect(made).toEqual(expect.arrayContaining(['-n ns-1 auth can-i get secrets', '-n ns-1 auth can-i delete secrets']));
});

test('clusterProblem names the missing kind or permission (each a skip reason)', () => {
    process.env.FAKE_KUBECTL_NO_LIST = 'czertainlyissuers.czertainly-issuer.czertainly.com';
    expect(clusterProblem('ns-1')).toMatch(/^czertainlyissuers\.czertainly-issuer\.czertainly\.com cannot be listed in namespace ns-1/);
    delete process.env.FAKE_KUBECTL_NO_LIST;
    process.env.FAKE_KUBECTL_CANNOT = 'create certificates.cert-manager.io';
    expect(clusterProblem('ns-1')).toBe('no permission to create certificates.cert-manager.io in namespace ns-1');
    process.env.FAKE_KUBECTL_CANNOT = 'delete czertainlyissuers.czertainly-issuer.czertainly.com';
    expect(clusterProblem('ns-1')).toMatch(/^no permission to delete czertainlyissuers/);
    process.env.FAKE_KUBECTL_CANNOT = 'get secrets';
    expect(clusterProblem('ns-1')).toBe('no permission to read secrets in namespace ns-1');
    process.env.FAKE_KUBECTL_CANNOT = 'delete secrets';
    expect(clusterProblem('ns-1')).toMatch(/^no permission to delete secrets/);
});
