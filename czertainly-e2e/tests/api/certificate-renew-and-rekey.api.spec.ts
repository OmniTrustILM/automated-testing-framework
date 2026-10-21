/**
 * Renew (same key) and rekey (new key, same subject) of an own issued certificate: only from the issued state, the
 * successor is related to the original. A CSR is always sent (MS ADCS NG cannot renew without one).
 * Shared-tier safety: the successor is recorded right after the call and deleted by the run-end teardown.
 */
import { expect, test } from '../../fixtures/testFixtures';
import { historyMessages, historyOf, relationsOf } from '../../utils/regression/lifecycle/certificateHistory';
import { rekeyOwnCertificate, renewOwnCertificate } from '../../utils/regression/lifecycle/certificateOperations';
import { csrFromKeyWithSubject, newKeyPair, parseCertificate, publicKeyPemOf, sameSans, sansOfDetail } from '../../utils/regression/pkiBuilders';
import { issueOwnCertificate } from '../../utils/regression/ownCertificates';
import { getCertificate } from '../../utils/regression/apiReads';
import { recordDerivedKeyOf } from '../../utils/regression/issuedRecords';
import { testMeta, tags } from '../../utils/regression/tags';
import { LIFECYCLE_MS } from '../../utils/regression/timeouts';
import { waitForCertificateState } from '../../utils/certificateUtils';

const SPEC = 'API-CERT-04';

test.describe('Certificate renew and rekey through the v2 API', { tag: tags.api }, () => {
    test('renewing with a CSR on the same key issues a successor related as renewal',
        testMeta({
            id: 'API-CERT-04', prio: 'P1', issue: 'ilm#429',
            rule: [
                'renew keeps the key; the original stays ISSUED; the successor is issued asynchronously; a supplied CSR must carry the certificate\'s key',
                'PENDING → RENEWAL on issuance: same DN, issuer and key fingerprint; one successor per call; history "Renewed using RA Profile <name>" / "Issued using RA Profile <name>"',
                'MS ADCS NG needs a PKCS#10 to renew: the CSR is always sent',
            ],
        }),
        async ({ api, ownRaProfile }) => {
            // Two issuances (180 s each) plus the reads.
            test.setTimeout(LIFECYCLE_MS);
            const ra = ownRaProfile;
            const a = await test.step('Issue certificate A (own, external CSR)', async () => issueOwnCertificate(api, ra, SPEC, { suffix: 'c04' }));
            const aDetail = await getCertificate(api, a.uuid);

            const renew = await test.step('POST …/{A}/renew with a CSR on the SAME key → 200 {uuid B}', async () => {
                // The CSR carries the ISSUED subject (the CA may have completed it) and the same key.
                const csr = csrFromKeyWithSubject(a.keys, String(aDetail.subjectDn), sansOfDetail(aDetail.subjectAlternativeNames));
                const r = await renewOwnCertificate(api, a, ra, SPEC, { csrDerBase64: csr.derBase64, note: 'API-CERT-04 renew successor' });
                expect(r.status, r.text.slice(0, 300)).toBe(200);
                expect(r.successor?.uuid, 'the answer names the successor').toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/);
                expect((r.json as { certificateData?: unknown }).certificateData ?? '').toBe('');
                return r;
            });
            const b = renew.successor!;

            await test.step('B reaches issued; A stays issued', async () => {
                await waitForCertificateState(api, b.uuid, 'issued', 180_000);
                await recordDerivedKeyOf(api, b.uuid, renew.createdAfter, SPEC);
                expect((await getCertificate(api, a.uuid)).state).toBe('issued');
            });

            await test.step('B: the same public key, subject DN and SAN set as A; a different serial', async () => {
                const bDetail = await getCertificate(api, b.uuid);
                expect(bDetail.state).toBe('issued');
                expect(publicKeyPemOf(parseCertificate(bDetail.certificateContent)), 'B public key = A public key').toBe(publicKeyPemOf(parseCertificate(aDetail.certificateContent)));
                expect(bDetail.subjectDn).toBe(aDetail.subjectDn);
                expect(sameSans(sansOfDetail(bDetail.subjectAlternativeNames), sansOfDetail(aDetail.subjectAlternativeNames)), 'B SAN set = A SAN set').toBe(true);
                expect(bDetail.serialNumber).not.toBe(aDetail.serialNumber);
            });

            await test.step('Relation A → B is renewal', async () => {
                const rel = await relationsOf(api, a.uuid);
                const link = rel.successors.find((s) => s.uuid === b.uuid);
                expect(link, `A lists B among its successors (${rel.successors.length})`).toEqual(expect.objectContaining({ uuid: b.uuid }));
                expect(link!.relationType).toBe('renewal');
                expect((await relationsOf(api, b.uuid)).predecessors.map((p) => p.uuid)).toContain(a.uuid);
            });

            await test.step('Histories: A "Renewed using RA Profile <name>", B "Issued using RA Profile <name>"', async () => {
                expect(historyMessages(await historyOf(api, a.uuid))).toContainEqual(expect.stringContaining(`Renewed using RA Profile ${ra.name}`));
                expect(historyMessages(await historyOf(api, b.uuid))).toContainEqual(expect.stringContaining(`Issued using RA Profile ${ra.name}`));
            });
        });

    test('rekeying with a new key and the same subject issues a successor related as rekey',
        testMeta({
            id: 'API-CERT-05', prio: 'P1', issue: 'ilm#429',
            rule: [
                'a rekey CSR carries a different public key and the same subject; PENDING → REKEY: same DN and issuer, different key',
                'history "Rekeyed using RA Profile <name>"; the original stays ISSUED',
            ],
        }),
        async ({ api, ownRaProfile }) => {
            test.setTimeout(LIFECYCLE_MS);
            const ra = ownRaProfile;
            const a = await test.step('Issue certificate A (own, external CSR)', async () => issueOwnCertificate(api, ra, SPEC, { suffix: 'c05' }));
            const aDetail = await getCertificate(api, a.uuid);

            const rekey = await test.step('POST …/{A}/rekey with a NEW key, same CN and SAN → 200 {uuid B}', async () => {
                // A new key, the ISSUED subject DN and SAN set (core compares the normalized X500 names).
                const csr = csrFromKeyWithSubject(newKeyPair(), String(aDetail.subjectDn), sansOfDetail(aDetail.subjectAlternativeNames));
                const r = await rekeyOwnCertificate(api, a, ra, SPEC, { csrDerBase64: csr.derBase64, note: 'API-CERT-05 rekey successor' });
                expect(r.status, r.text.slice(0, 300)).toBe(200);
                expect(r.successor?.uuid, 'the answer names the successor').toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/);
                return { ...r, csr };
            });
            const b = rekey.successor!;

            await test.step('B reaches issued with the new key; A stays issued', async () => {
                await waitForCertificateState(api, b.uuid, 'issued', 180_000);
                await recordDerivedKeyOf(api, b.uuid, rekey.createdAfter, SPEC);
                const bDetail = await getCertificate(api, b.uuid);
                expect(bDetail.fingerprint).not.toBe(aDetail.fingerprint);
                expect(publicKeyPemOf(parseCertificate(bDetail.certificateContent)), 'B public key = the new CSR key').toBe(rekey.csr.publicKeyPem);
                expect(publicKeyPemOf(parseCertificate(bDetail.certificateContent))).not.toBe(publicKeyPemOf(parseCertificate(aDetail.certificateContent)));
                expect(sameSans(sansOfDetail(bDetail.subjectAlternativeNames), sansOfDetail(aDetail.subjectAlternativeNames)), 'B SAN set = A SAN set').toBe(true);
                expect(bDetail.subjectDn).toBe(aDetail.subjectDn);
                expect((await getCertificate(api, a.uuid)).state).toBe('issued');
            });

            await test.step('Relation A → B is rekey; A history "Rekeyed using RA Profile <name>"', async () => {
                const link = (await relationsOf(api, a.uuid)).successors.find((s) => s.uuid === b.uuid);
                expect(link, 'A lists B among its successors').toEqual(expect.objectContaining({ uuid: b.uuid }));
                expect(link!.relationType).toBe('rekey');
                expect(historyMessages(await historyOf(api, a.uuid))).toContainEqual(expect.stringContaining(`Rekeyed using RA Profile ${ra.name}`));
            });
        });
});
