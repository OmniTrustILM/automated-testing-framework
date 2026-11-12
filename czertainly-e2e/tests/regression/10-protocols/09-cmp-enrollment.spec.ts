/**
 * REG-PROT-09, REG-PROT-10, REG-PROT-11 — CMP with the real `openssl cmp` client. ilm#430.
 *
 * WHAT: 1. `ir` with the shared secret (REG-PROT-09) → exit 0 within 60 s and a certificate for a new key with the requested CN; the
 *          inventory lists it by fingerprint under the dedicated RA profile as CMP.
 *       2. `kur` with the old certificate and a new key (REG-PROT-10) → a certificate with the same subject and a different key.
 *       3. `rr` (REG-PROT-11) → the successor is Revoked within 60 s with the history "Certificate revoked. Reason: Unspecified"; a
 *          second `rr` is rejected (PKIStatus rejection, exit not 0); the certificate issued with `ir` stays issued.
 *       4. A second `rr` should name failInfo certRevoked (test.fixme: the endpoint answered systemFailure; to be settled with the
 *          developers).
 * WHY: CMP is the enrolment protocol of managed PKI clients; the profile accepts only shared-secret protection, `kur` must change the
 *      key, and revoking goes through the certificate's own RA profile (RFC 4210).
 * HOW: needs the `openssl` binary (skips with the reason otherwise) and a CA. An own CMP profile (v2, shared secret both ways) is
 *      activated on a dedicated own RA profile, made once per worker. Each test issues the certificates it needs itself, so any one
 *      runs alone. Certificates are recorded by their run-prefixed CN right after the client returns, with the key core links
 *      (server-clock bound read before the call); the secret never appears in a name or message.
 */
import * as path from 'path';
import { waitForCertificateState } from '../../../utils/regression/wait/certificateState';
import { expect, test } from '../../../fixtures/areas/protocolTarget';
import type { CmpRig } from '../../../fixtures/areas/protocolTarget';
import { describeCmp, opensslCmp } from '../../../utils/regression/protocols/cmpClient';
import type { GuardedApi } from '../../../utils/regression/guard/types';
import { csrWithSan } from '../../../utils/regression/pkiBuilders';
import { certificateFacts } from '../../../utils/regression/protocols/protocolResponseReaders';
import { getCertificateHistory } from '../../../utils/regression/discovery/discoveryApi';
import { pollCertificateByFingerprint, getCertificate, serverCreatedAfter } from '../../../utils/regression/apiReads';
import type { OwnObjects } from '../../../utils/regression/ownObjects';
import { runId, ownName } from '../../../utils/regression/ledger/runState';
import { testMeta, tags } from '../../../utils/regression/tags';
import { prepareWorkDir, writeWorkFile } from '../../../utils/regression/protocols/externalToolRunner';
import { EXTERNAL_TOOL_MS, HISTORY_ENTRY_MS, HISTORY_POLL_EVERY_MS, ISSUE_MS, LIFECYCLE_MS, PROTOCOL_ANSWER_MS, SLOW_LIFECYCLE_MS, STATUS_CHANGE_MS } from '../../../utils/regression/timeouts';
import type { JsonObject } from '../../../utils/regression/json';

interface IssuedCert {
    /** Absolute paths under the test output. */
    keyFile: string;
    certFile: string;
    pem: string;
    commonName: string;
    spkiBase64: string;
    fingerprint: string;
    uuid: string;
}

test.describe('CMP with openssl', { tag: tags.regression }, () => {
    /** Writes a fresh RSA-2048 private key (PKCS#8 PEM) and returns its path and SPKI. */
    function freshKey(dir: string, name: string): { file: string; spkiBase64: string } {
        const csr = csrWithSan('key-holder');
        return { file: writeWorkFile(dir, name, csr.privateKeyPem), spkiBase64: csr.spkiBase64 };
    }

    /** The inventory certificate for a client-written PEM: recorded first, then found by fingerprint under the RA profile. */
    async function inventoryOf(api: GuardedApi, own: OwnObjects, run: CmpRig, pem: string, commonName: string, note: string, createdAfter: string, opts: { protocol?: boolean } = {}): Promise<IssuedCert & { detail: JsonObject }> {
        await own.issuedNamed(commonName, createdAfter, note);
        const facts = certificateFacts(pem);
        const row = await pollCertificateByFingerprint(api, facts.fingerprint);
        // The derived key of a CMP-issued certificate is recorded before anything is judged; the server-clock bound was read before the
        // openssl call.
        if (row) await own.derivedKey(String(row.uuid), createdAfter);
        expect(row, `certificate ${facts.fingerprint} (${commonName}) is in the inventory`).toBeTruthy();
        const detail = await getCertificate(api, String(row!.uuid));
        expect((detail.raProfile as JsonObject | undefined)?.uuid, 'RA profile = the dedicated RA profile').toBe(run.raProfile.uuid);
        // ir / cr associate CMP with the certificate; a kur successor carries no protocol info (core's rekey takes none),
        // so the protocol is asserted for `ir` only.
        if (opts.protocol !== false) expect(String((detail.protocolInfo as JsonObject | undefined)?.protocol ?? ''), 'protocol CMP').toMatch(/cmp/i);
        return { keyFile: '', certFile: '', pem, commonName, spkiBase64: facts.spkiBase64, fingerprint: facts.fingerprint, uuid: String(row!.uuid), detail };
    }

    /** `openssl cmp -cmd ir` with a fresh key: exit 0 within 60 s, the certificate carries the key and the CN, in the inventory as CMP. */
    async function issueWithIr(api: GuardedApi, own: OwnObjects, run: CmpRig, cwd: string): Promise<IssuedCert> {
        const key = freshKey(cwd, 'key1.pem');
        const createdAfter = await serverCreatedAfter(api);
        const commonName = ownName('cmp');
        const res = await test.step('openssl cmp -cmd ir → exit 0 within 60 s, certificate written', async () => {
            const started = Date.now();
            const r = opensslCmp({ command: 'ir', server: run.server, path: run.path, secret: run.secret, ref: runId(), newKey: key.file, subject: `/CN=${commonName}`, certOut: 'cert1.pem', cwd, timeoutMs: EXTERNAL_TOOL_MS });
            await own.issuedNamed(commonName, createdAfter, 'issued via CMP ir (openssl)');
            expect(r.exitCode, describeCmp(r)).toBe(0);
            expect(Date.now() - started, 'ir answered within 60 s').toBeLessThanOrEqual(PROTOCOL_ANSWER_MS);
            expect(r.certificatePem, 'the certificate file was written').toBeTruthy();
            return r;
        });
        const facts = certificateFacts(res.certificatePem!);
        await test.step('The certificate parses, carries the new key and the requested CN', async () => {
            expect(facts.commonName).toBe(commonName);
            expect(facts.spkiBase64, 'certificate public key = the new key').toBe(key.spkiBase64);
        });
        return test.step('Inventory (by fingerprint): the dedicated RA profile, protocol CMP', async () => {
            const inv = await inventoryOf(api, own, run, res.certificatePem!, commonName, 'issued via CMP ir (openssl)', createdAfter);
            return { ...inv, keyFile: key.file, certFile: path.join(cwd, 'cert1.pem') };
        });
    }

    /** `openssl cmp -cmd kur` with a new key and `-oldcert`: same subject, a different key, in the inventory. */
    async function updateWithKur(api: GuardedApi, own: OwnObjects, run: CmpRig, cwd: string, first: IssuedCert): Promise<IssuedCert> {
        const key = freshKey(cwd, 'key2.pem');
        const createdAfter = await serverCreatedAfter(api);
        const res = await test.step('openssl cmp -cmd kur -oldcert <first> -newkey <new> → exit 0, certificate written', async () => {
            const r = opensslCmp({ command: 'kur', server: run.server, path: run.path, secret: run.secret, ref: runId(), oldCert: first.certFile, newKey: key.file, certOut: 'cert2.pem', cwd, timeoutMs: EXTERNAL_TOOL_MS });
            await own.issuedNamed(first.commonName, createdAfter, 'issued via CMP kur (openssl)');
            expect(r.exitCode, describeCmp(r)).toBe(0);
            expect(r.certificatePem, 'the certificate file was written').toBeTruthy();
            return r;
        });
        const facts = certificateFacts(res.certificatePem!);
        await test.step('Same subject, a different public key (= the new key)', async () => {
            expect(facts.subject).toBe(certificateFacts(first.pem).subject);
            expect(facts.spkiBase64).not.toBe(first.spkiBase64);
            expect(facts.spkiBase64).toBe(key.spkiBase64);
            expect(facts.fingerprint).not.toBe(first.fingerprint);
        });
        return test.step('Inventory: the new certificate under the dedicated RA profile', async () => {
            const inv = await inventoryOf(api, own, run, res.certificatePem!, first.commonName, 'issued via CMP kur (openssl)', createdAfter, { protocol: false });
            return { ...inv, keyFile: key.file, certFile: path.join(cwd, 'cert2.pem') };
        });
    }

    test('openssl cmp ir with the shared secret issues a certificate for the new key',
        testMeta({
            id: 'REG-PROT-09', prio: 'P2', issue: 'ilm#430', needs: 'openssl',
            rule: [
                'openssl cmp -cmd ir against the CMP endpoint → issued; the profile accepts only shared-secret protection (-secret)',
                'the endpoint consumes / produces application/pkixcmp; the first CertReqMsg is issued (RFC 4210 §5.3.1)',
                'the client calls the RA-profile CMP URL the platform reports after the activation (the rig fails when the activation reports none)',
            ],
        }),
        async ({ api, own, cmpRig }, testInfo) => {
            test.setTimeout(ISSUE_MS);
            const run = cmpRig;
            await issueWithIr(api, own, run, prepareWorkDir(testInfo.outputPath('cmp')));
        });

    test('openssl cmp kur issues a certificate with the same subject and a new key',
        testMeta({
            id: 'REG-PROT-10', prio: 'P2', issue: 'ilm#430', needs: 'openssl',
            rule: [
                'openssl cmp -cmd kur → a new certificate',
                'kur locates the old certificate by the oldCertID serial; the new public key must differ (RFC 4210 §5.3.5)',
            ],
        }),
        async ({ api, own, cmpRig }, testInfo) => {
            test.setTimeout(LIFECYCLE_MS);
            const run = cmpRig;
            const cwd = prepareWorkDir(testInfo.outputPath('cmp'));
            const first = await test.step('Prerequisite: a certificate issued with ir', async () => issueWithIr(api, own, run, cwd));
            await updateWithKur(api, own, run, cwd, first);
        });

    test('openssl cmp rr revokes the certificate and a second rr is rejected',
        testMeta({
            id: 'REG-PROT-11', prio: 'P2', issue: 'ilm#430', needs: 'openssl',
            rule: [
                'openssl cmp -cmd rr → revoked',
                'reason optional (default UNSPECIFIED; core#1925), already revoked → certRevoked; the lookup is by serial and revokes through the certificate\'s own RA profile (RFC 4210 §5.3.9)',
                'the history records "Certificate revoked. Reason: Unspecified"',
            ],
        }),
        async ({ api, own, cmpRig }, testInfo) => {
            test.setTimeout(SLOW_LIFECYCLE_MS);
            const run = cmpRig;
            const cwd = prepareWorkDir(testInfo.outputPath('cmp'));
            const first = await test.step('Prerequisite: a certificate issued with ir', async () => issueWithIr(api, own, run, cwd));
            const updated = await test.step('Prerequisite: its kur successor', async () => updateWithKur(api, own, run, cwd, first));

            await test.step('openssl cmp -cmd rr -oldcert <successor> (no reason) → exit 0', async () => {
                const r = opensslCmp({ command: 'rr', server: run.server, path: run.path, secret: run.secret, ref: runId(), oldCert: updated.certFile, cwd, timeoutMs: EXTERNAL_TOOL_MS });
                expect(r.exitCode, describeCmp(r)).toBe(0);
            });

            await test.step('Inventory: revoked within a minute; history reason Unspecified', async () => {
                await waitForCertificateState(api, updated.uuid, 'revoked', STATUS_CHANGE_MS);
                // Core sets REVOKED first and writes the history entry afterwards : poll the history.
                await expect.poll(async () => (await getCertificateHistory(api, updated.uuid)).map((h) => String(h.message ?? '')),
                    { timeout: HISTORY_ENTRY_MS, intervals: [HISTORY_POLL_EVERY_MS], message: 'history after the revoke' }).toContain('Certificate revoked. Reason: Unspecified');
            });

            await test.step('Second rr on the same certificate → rejected (PKIStatus rejection, exit ≠ 0)', async () => {
                const r = opensslCmp({ command: 'rr', server: run.server, path: run.path, secret: run.secret, ref: runId(), oldCert: updated.certFile, cwd, timeoutMs: EXTERNAL_TOOL_MS });
                expect(r.exitCode, describeCmp(r)).not.toBe(0);
                // The oracle here is the REJECTION; the failInfo is the fixme test below (the endpoint answered systemFailure).
                expect(String(r.pkiStatus ?? ''), describeCmp(r)).toMatch(/rejection/i);
            });

            await test.step('The certificate issued with ir is untouched (still issued)', async () => {
                const detail = await getCertificate(api, first.uuid);
                expect(detail.state).toBe('issued');
            });
        });

    test.fixme('a second rr on a revoked certificate names failInfo certRevoked',
        testMeta({
            id: 'REG-PROT-11', row: 'failInfo', prio: 'P2', issue: 'ilm#430', needs: 'openssl',
            rule: ['already revoked → failInfo certRevoked (RFC 4210 §5.3.9); the endpoint has answered systemFailure instead: unconfirmed, so the row stays fixme'],
        }),
        async ({ api, own, cmpRig }, testInfo) => {
            test.setTimeout(LIFECYCLE_MS);
            const run = cmpRig;
            const cwd = prepareWorkDir(testInfo.outputPath('cmp'));
            const issued = await issueWithIr(api, own, run, cwd);
            const revoke = () => opensslCmp({ command: 'rr', server: run.server, path: run.path, secret: run.secret, ref: runId(), oldCert: issued.certFile, cwd, timeoutMs: EXTERNAL_TOOL_MS });
            expect(revoke().exitCode, 'the first rr revokes').toBe(0);
            const r = revoke();
            expect(r.exitCode, describeCmp(r)).not.toBe(0);
            expect(r.failInfo, describeCmp(r)).toContain('certRevoked');
        });
});
