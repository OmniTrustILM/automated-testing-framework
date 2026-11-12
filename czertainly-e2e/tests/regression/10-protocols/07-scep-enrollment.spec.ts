/**
 * REG-PROT-07 — SCEP enrolment with the real `sscep` client. ilm#430.
 *
 * WHAT: Per worker, before its first test: the protocol CA certificate, a dedicated own RA profile, and an enabled own SCEP profile
 *       with a challenge password activated on it. Then, one test per cipher and digest (3DES + SHA-1, AES + SHA-256):
 *       1. GetCACaps advertises the arm's capabilities.
 *       2. `sscep getca` writes the CA material, which includes the protocol CA.
 *       3. `sscep enroll` with a CSR carrying the challenge password → exit 0 and a certificate file (pkistatus SUCCESS when printed)
 *          within 60 s; it carries the CSR key and the CN.
 *       4. The inventory lists it by fingerprint under the dedicated RA profile as SCEP with the SCEP profile's uuid.
 * WHY: SCEP is how devices enrol with a challenge; PKCSReq with the profile's password must issue through the activated RA profile
 *      (RFC 8894). The exit code and the certificate file are the primary oracle, the status text is secondary.
 * HOW: needs the `sscep` binary (skips with the reason otherwise) and a CA that can issue the protocol CA certificate. Classic sscep speaks
 *      plain HTTP only, so a reported SCEP URL that is https skips the test (the rig learns it only after the activation, and a proxy may
 *      rewrite the scheme; the rig's own objects are recorded and removed by the teardown). The profile and RA profile are own objects;
 *      every certificate is recorded in the ledger by its run-prefixed CN right after the client returns, before any assertion.
 */
import * as path from 'path';
import { expect, test } from '../../../fixtures/areas/protocolTarget';
import { protocolGet } from '../../../utils/regression/protocols/protocolHttp';
import { certificateFacts, parseGetCaCaps } from '../../../utils/regression/protocols/protocolResponseReaders';
import { csrWithChallengePassword, sha256Hex } from '../../../utils/regression/pkiBuilders';
import { pollCertificateByFingerprint, getCertificate } from '../../../utils/regression/apiReads';
import { ownName } from '../../../utils/regression/ledger/runState';
import { certificatesOfFile, describeSscep, SscepCipher, SscepDigest, sscepEnroll, sscepGetCa } from '../../../utils/regression/protocols/sscepClient';
import { testMeta, tags } from '../../../utils/regression/tags';
import { EXTERNAL_TOOL_MS, ISSUE_MS, PROTOCOL_ANSWER_MS } from '../../../utils/regression/timeouts';
import { prepareWorkDir, writeWorkFile } from '../../../utils/regression/protocols/externalToolRunner';

test.describe('SCEP with sscep', { tag: tags.regression }, () => {
    const ARMS: Array<{ cipher: SscepCipher; digest: SscepDigest; caps: string[]; prio: 'P2' | 'P3' }> = [
        { cipher: '3des', digest: 'sha1', caps: ['DES3', 'SHA-1'], prio: 'P2' },
        { cipher: 'aes', digest: 'sha256', caps: ['AES', 'SHA-256'], prio: 'P3' },
    ];

    for (const arm of ARMS) {
        test(`sscep enrols with the challenge password using ${arm.cipher === 'aes' ? 'AES and SHA-256' : '3DES and SHA-1'} and gets a SCEP certificate`,
            testMeta({
                id: 'REG-PROT-07', row: `${arm.cipher}+${arm.digest}`, prio: arm.prio, issue: 'ilm#430', needs: 'sscep',
                rule: [
                    'ilm#430 steps 3 and 4: sscep getca, then sscep enroll against pkiclient.exe → issued (pkistatus: SUCCESS); poll flags -n 1 -t 5 -T 15 per the ilm#430 note',
                    'GetCACaps advertises POSTPKIOperation, SHA-1, SHA-256, SHA-512, DES3, AES, Renewal, SCEPStandard; GetCACert answers the CA certificate (and its chain)',
                    'PKCSReq with the profile challenge password issues; the certificate is issued through the activated RA profile (RFC 8894 §3.3.1, §4)',
                    'the protocol CA certificate is issued and valid and its RSA key items carry ENCRYPT + VERIFY / DECRYPT + SIGN (the rig checks it and skips with the reason otherwise); the activation reports the RA-profile URL (the rig fails without it)',
                ],
            }),
            async ({ api, own, scepRig: run }, testInfo) => {
                // getca, enroll (≤ 60 s) and the inventory read; the rig (protocol CA, profiles) is built by its fixture with its own
                // budget.
                test.setTimeout(ISSUE_MS);
                const cwd = prepareWorkDir(testInfo.outputPath(`sscep-${arm.cipher}`));

                await test.step(`GetCACaps advertises ${arm.caps.join(' and ')}`, async () => {
                    const caps = await protocolGet(`${run.url}?operation=GetCACaps`);
                    expect(caps.status).toBe(200);
                    const keywords = parseGetCaCaps(caps.text);
                    for (const k of arm.caps) expect(keywords, `GetCACaps: ${caps.text}`).toContain(k);
                });

                const caFile = await test.step('sscep getca writes the CA material; its certificates include the protocol CA', async () => {
                    const got = sscepGetCa({ url: run.url, caFile: 'ca.crt', cwd });
                    expect(got.exitCode, describeSscep(got)).toBe(0);
                    expect(got.files.length, describeSscep(got)).toBeGreaterThan(0);
                    const withFca = got.files.find((f) => certificatesOfFile(f).some((c) => c.fingerprint === run.ca.certificate.fingerprint));
                    expect(withFca, `no CA file written by sscep carries the protocol CA ${run.ca.certificate.fingerprint}: ${got.files.map((f) => path.basename(f)).join(', ')}`).toBeTruthy();
                    return withFca!;
                });

                const cn = ownName(`scep-${arm.cipher}`);
                const csr = csrWithChallengePassword(cn, run.password);
                writeWorkFile(cwd, 'client.key', csr.privateKeyPem);
                writeWorkFile(cwd, 'client.csr', csr.pem);

                const enrolled = await test.step(`sscep enroll (-E ${arm.cipher} -S ${arm.digest}) → exit 0 and a certificate written (pkistatus: SUCCESS when printed)`, async () => {
                    const started = Date.now();
                    const res = sscepEnroll({ url: run.url, caCertFile: caFile, keyFile: 'client.key', csrFile: 'client.csr', certOutFile: 'client.crt', cipher: arm.cipher, digest: arm.digest, cwd, timeoutMs: EXTERNAL_TOOL_MS, verbose: true });
                    // Ledger before any assertion: whatever the CA issued for this CN is this run's.
                    await own.recordNamed(cn, `issued via SCEP (sscep, ${arm.cipher} + ${arm.digest})`);
                    // Primary oracle: the client's exit code and the certificate it wrote; the status text is
                    // secondary (sscep prints `pkistatus:` only in verbose mode and only when the CertRep parsed).
                    expect(res.exitCode, describeSscep(res)).toBe(0);
                    expect(res.certificatePem, `the certificate file was written: ${describeSscep(res)}`).toBeTruthy();
                    if (res.pkiStatus !== undefined) expect(res.pkiStatus, describeSscep(res)).toBe('SUCCESS');
                    else testInfo.annotations.push({ type: 'sscep-status', description: 'no pkistatus line in the output; exit code + certificate file are the oracle' });
                    expect(Date.now() - started, 'enroll answered within 60 s').toBeLessThanOrEqual(PROTOCOL_ANSWER_MS);
                    return res.certificatePem!;
                });

                const facts = certificateFacts(enrolled);
                await test.step('The issued certificate carries the CSR key and the CN', async () => {
                    expect(facts.commonName).toBe(cn);
                    expect(facts.spkiBase64, 'certificate public key = CSR key').toBe(csr.spkiBase64);
                });

                await test.step('Inventory (by fingerprint): RA profile = the dedicated RA profile, protocol SCEP, SCEP profile uuid', async () => {
                    const row = await pollCertificateByFingerprint(api, facts.fingerprint);
                    expect(row, `certificate ${facts.fingerprint} is in the inventory`).toBeTruthy();
                    const detail = await getCertificate(api, String(row!.uuid));
                    expect(detail.raProfile?.uuid).toBe(run.raProfile.uuid);
                    expect(String(detail.protocolInfo?.protocol ?? '')).toMatch(/scep/i);
                    expect(detail.protocolInfo?.protocolProfileUuid).toBe(run.scepProfile.uuid);
                    expect(sha256Hex(Buffer.from(String(detail.certificateContent ?? ''), 'base64'))).toBe(facts.fingerprint);
                });
            });
    }
});
