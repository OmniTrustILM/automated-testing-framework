/**
 * REG-PROT-07 — SCEP enrolment with the real client (ilm#430 steps 3 and 4: `sscep getca`, then `sscep enroll`).
 *
 * Flow: F-CA (own token, RSA-2048 key, certificate issued for that key through the run RA profile: protocolCa) → own
 * SCEP profile with a challenge password, enabled, activated on a dedicated own RA profile (RA*) → `sscep getca`
 * against the RA-profile URL writes the CA material (RFC 8894 §4.2: the CA certificate and its issuers) → `sscep
 * enroll` with a CSR carrying the challenge password (RFC 8894 §3.3.1) → `pkistatus: SUCCESS` → the written
 * certificate carries the CSR key and CN → the inventory shows it under RA* with protocol SCEP and the SCEP profile.
 * One test per cipher / digest pair the server advertises in GetCACaps (DES3 + SHA-1 is the P1 arm, AES + SHA-256
 * the P3 arm of the same row: plan §3.1).
 *
 * Nothing pre-existing is touched: every object is run-prefixed and recorded in the ledger before an assertion; the
 * issued certificate is adopted by its run-prefixed CN right after the client returns (`recordCertificatesNamed`) and
 * revoked + deleted by the run-end teardown together with the SCEP profile (deactivated first), the key, the token
 * profile and the token. The client binary is the one `requireTool('sscep')` probed (D2); every file lives under the
 * test's output directory.
 */
import * as path from 'path';
import { expect, test } from '../../fixtures/testFixtures';
import { GuardedApi } from '../../utils/regression/guardedApi';
import { ensureProtocolCaCertificate, orSkipWithoutProtocolCa, ProtocolCa } from '../../utils/regression/protocolCa';
import { protocolGet } from '../../utils/regression/protocolHttp';
import { certificateFacts, csrWithChallengePassword, parseGetCaCaps, sha256Hex } from '../../utils/regression/protocolPki';
import {
    createOwnScepProfile, enableOwnScepProfile, ensureProtocolRaProfile, ensureScepActiveOnOwnRaProfile, OwnRaProfile, randomSecret,
} from '../../utils/regression/protocolProfiles';
import { getCertificate, orSkipWithoutCa, recordCertificatesNamed, searchCertificates } from '../../utils/regression/regressionApi';
import { OwnRef, regName } from '../../utils/regression/regressionRun';
import { certificatesOfFile, describeSscep, SscepCipher, SscepDigest, sscepEnroll, sscepGetCa } from '../../utils/regression/sscepRunner';
import { meta } from '../../utils/regression/tags';
import { prepareWorkDir, writeWorkFile } from '../../utils/regression/toolRun';
import { requireTool } from '../../utils/regression/tools';

const SPEC = 'REG-PROT-07';
const skip = (reason: string) => test.skip(true, reason);

type Json = Record<string, any>;

interface ScepRun {
    ca: ProtocolCa;
    ra: OwnRaProfile;
    scep: OwnRef;
    password: string;
    /** The RA-profile SCEP URL the server reported (`…/protocols/scep/raProfile/<ra>/pkiclient.exe`). */
    url: string;
}

/** The inventory row of a certificate by fingerprint, polled (issuance through the connector may land a moment later). */
async function findByFingerprint(api: GuardedApi, fingerprint: string, timeoutMs = 60_000): Promise<Json | undefined> {
    const end = Date.now() + timeoutMs;
    for (;;) {
        const rows = await searchCertificates(api, [{ fieldSource: 'property', fieldIdentifier: 'FINGERPRINT', condition: 'EQUALS', value: fingerprint }]);
        if (rows.length || Date.now() > end) return rows[0];
        await new Promise((r) => setTimeout(r, 3000));
    }
}

test.describe('@regression REG-PROT-07 SCEP with sscep', () => {
    test.beforeAll(() => {
        const problem = requireTool('sscep');
        test.skip(!!problem, problem ?? '');
    });

    let shared: ScepRun | undefined;

    /** F-CA, RA*, one enabled SCEP profile with a challenge password activated on RA*: built once per file. */
    async function scepRun(api: GuardedApi): Promise<ScepRun> {
        if (shared) return shared;
        const ca = await orSkipWithoutProtocolCa(orSkipWithoutCa(ensureProtocolCaCertificate(api, SPEC), skip), skip);
        const ra = await ensureProtocolRaProfile(api, SPEC, 'scep');
        const password = randomSecret();
        const scep = await createOwnScepProfile(api, SPEC, { name: regName(`scep-${Date.now().toString(36)}`), caCertificateUuid: ca.certificate.uuid, challengePassword: password },
            'SCEP profile with a challenge password (REG-PROT-07)');
        await enableOwnScepProfile(api, scep);
        const url = await ensureScepActiveOnOwnRaProfile(api, ra, scep);
        shared = { ca, ra, scep, password, url };
        return shared;
    }

    const ARMS: Array<{ cipher: SscepCipher; digest: SscepDigest; caps: string[]; prio: 'P1' | 'P3' }> = [
        { cipher: '3des', digest: 'sha1', caps: ['DES3', 'SHA-1'], prio: 'P1' },
        { cipher: 'aes', digest: 'sha256', caps: ['AES', 'SHA-256'], prio: 'P3' },
    ];

    for (const arm of ARMS) {
        test(`REG-PROT-07[${arm.cipher}+${arm.digest}]: sscep getca writes the CA material with F-CA, sscep enroll with the challenge password is SUCCESS and the certificate lands under RA* as SCEP`,
            meta({
                id: 'REG-PROT-07', prio: arm.prio, issue: 'ilm#430', needs: 'sscep',
                rule: [
                    'ilm#430 steps 3 and 4 (T6-3, T6-4): sscep getca, then sscep enroll against pkiclient.exe → issued (pkistatus: SUCCESS); poll flags -n 1 -t 5 -T 15 per the ilm#430 note',
                    'protocols §7.2 r13: GetCACaps advertises POSTPKIOperation, SHA-1, SHA-256, SHA-512, DES3, AES, Renewal, SCEPStandard; GetCACert answers the CA certificate (and its chain)',
                    'protocols §7.2 r14–r16: PKCSReq with the profile challenge password issues; the certificate is issued through the activated RA profile (RFC 8894 §3.3.1, §4)',
                    'protocols §7.2 r2 / r10: the SCEP CA certificate is an ISSUED, VALID certificate whose RSA key items carry ENCRYPT + VERIFY / DECRYPT + SIGN (F-CA); activation reports the RA-profile URL',
                ],
            }),
            async ({ api }, testInfo) => {
                // F-CA (token, key, issuance ≤ 180 s) on the first test, getca, enroll (≤ 60 s) and the inventory read.
                test.setTimeout(240_000);
                const run = await test.step('Prerequisite: F-CA, RA*, an enabled SCEP profile with a challenge password activated on RA*', async () => scepRun(api));
                // Classic sscep speaks plain HTTP (no TLS client): a tier whose server-reported SCEP URL is https cannot be enrolled against.
                // The URL core reports (run.url), not BASE_URL, decides (merge item 6: a proxy may rewrite the scheme).
                test.skip(/^https:/i.test(run.url), 'the SCEP URL the server reports is https: classic sscep speaks plain HTTP only (needs an http endpoint or a TLS-capable sscep build)');
                const cwd = prepareWorkDir(testInfo.outputPath(`sscep-${arm.cipher}`));

                await test.step(`GetCACaps advertises ${arm.caps.join(' and ')}`, async () => {
                    const caps = await protocolGet(`${run.url}?operation=GetCACaps`);
                    expect(caps.status).toBe(200);
                    const keywords = parseGetCaCaps(caps.text);
                    for (const k of arm.caps) expect(keywords, `GetCACaps: ${caps.text}`).toContain(k);
                });

                const caFile = await test.step('sscep getca writes the CA material; its certificates include F-CA', async () => {
                    const got = sscepGetCa({ url: run.url, caFile: 'ca.crt', cwd });
                    expect(got.exitCode, describeSscep(got)).toBe(0);
                    expect(got.files.length, describeSscep(got)).toBeGreaterThan(0);
                    const withFca = got.files.find((f) => certificatesOfFile(f).some((c) => c.fingerprint === run.ca.certificate.fingerprint));
                    expect(withFca, `no CA file written by sscep carries F-CA ${run.ca.certificate.fingerprint}: ${got.files.map((f) => path.basename(f)).join(', ')}`).toBeTruthy();
                    return withFca!;
                });

                const cn = regName(`scep-${arm.cipher}-${Date.now().toString(36)}`);
                const csr = csrWithChallengePassword(cn, run.password);
                writeWorkFile(cwd, 'client.key', csr.privateKeyPem);
                writeWorkFile(cwd, 'client.csr', csr.pem);

                const enrolled = await test.step(`sscep enroll (-E ${arm.cipher} -S ${arm.digest}) → exit 0 and a certificate written (pkistatus: SUCCESS when printed)`, async () => {
                    const started = Date.now();
                    const res = sscepEnroll({ url: run.url, caCertFile: caFile, keyFile: 'client.key', csrFile: 'client.csr', certOutFile: 'client.crt', cipher: arm.cipher, digest: arm.digest, cwd, timeoutMs: 90_000, verbose: true });
                    // Ledger before any assertion: whatever the CA issued for this CN is this run's.
                    await recordCertificatesNamed(api, cn, SPEC, `issued via SCEP (sscep, ${arm.cipher} + ${arm.digest})`);
                    // Primary oracle: the client's exit code and the certificate it wrote (reviewer F6); the status text is
                    // secondary (sscep prints `pkistatus:` only in verbose mode and only when the CertRep parsed).
                    expect(res.exitCode, describeSscep(res)).toBe(0);
                    expect(res.certificatePem, `the certificate file was written: ${describeSscep(res)}`).toBeTruthy();
                    if (res.pkiStatus !== undefined) expect(res.pkiStatus, describeSscep(res)).toBe('SUCCESS');
                    else testInfo.annotations.push({ type: 'sscep-status', description: 'no pkistatus line in the output; exit code + certificate file are the oracle' });
                    expect(Date.now() - started, 'enroll answered within 60 s').toBeLessThanOrEqual(60_000);
                    return res.certificatePem!;
                });

                const facts = certificateFacts(enrolled);
                await test.step('The issued certificate carries the CSR key and the CN', async () => {
                    expect(facts.commonName).toBe(cn);
                    expect(facts.spkiBase64, 'certificate public key = CSR key').toBe(csr.spkiBase64);
                });

                await test.step('Inventory (by fingerprint): RA profile = RA*, protocol SCEP, SCEP profile uuid', async () => {
                    const row = await findByFingerprint(api, facts.fingerprint);
                    expect(row, `certificate ${facts.fingerprint} is in the inventory`).toBeTruthy();
                    const detail = await getCertificate(api, String(row!.uuid));
                    expect(detail.raProfile?.uuid).toBe(run.ra.uuid);
                    expect(String(detail.protocolInfo?.protocol ?? '')).toMatch(/scep/i);
                    expect(detail.protocolInfo?.protocolProfileUuid).toBe(run.scep.uuid);
                    expect(sha256Hex(Buffer.from(String(detail.certificateContent ?? ''), 'base64'))).toBe(facts.fingerprint);
                });
            });
    }
});
