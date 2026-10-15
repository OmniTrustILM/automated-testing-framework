/**
 * API-CERT-04 / 05 — renew (same key) and rekey (new key, same subject) of an own issued certificate (ilm#429 steps 2 and
 * 3; cert-lifecycle rules §3.2 RR-1, RR-5, RR-6, RR-7, RR-8, RR-11, RR-14). A CSR is always sent (RR-14: MS ADCS NG
 * cannot renew without one); the successor is recorded right after the call and deleted by the run-end teardown.
 */
import { expect, test } from '../../fixtures/testFixtures';
import { csrFromKeyWithSubject, historyMessages, historyOf, issueOwnCertificate, newKeyPair, rekeyOwn, relationsOf, renewOwn } from '../../utils/regression/lifecycle';
import { parseCertificate, publicKeyPemOf, sameSans, sansOfDetail } from '../../utils/regression/pki';
import { ensureRaProfileOrSkip, getCertificate, recordDerivedKeyOf } from '../../utils/regression/regressionApi';
import { meta, tags } from '../../utils/regression/tags';
import { waitForCertificateState } from '../../utils/certificateUtils';

const SPEC = 'API-CERT-04';

test.describe('API-CERT-04 renew and rekey', { tag: tags.api }, () => {
    test('API-CERT-04: renew with a CSR on the same key issues a successor related as renewal; the original stays issued and the histories name the operation',
        meta({
            id: 'API-CERT-04', prio: 'P1', issue: 'ilm#429',
            rule: [
                'cert-lifecycle §3.2 RR-1 (renew keeps the key; the original stays ISSUED; the successor is issued asynchronously), RR-5 (a supplied CSR must carry the certificate\'s key)',
                'cert-lifecycle §3.2 RR-7 (PENDING → RENEWAL on issuance: same DN, issuer and key fingerprint), RR-8 (one successor per call), RR-11 (history "Renewed using RA Profile <name>" / "Issued using RA Profile <name>")',
                'cert-lifecycle §3.2 RR-14 (MS ADCS NG needs a PKCS#10 to renew: the CSR is always sent)',
            ],
        }),
        async ({ api }) => {
            // Two issuances (180 s each) plus the reads.
            test.setTimeout(420_000);
            const ra = await test.step('Prerequisite: the run RA profile (CA-agnostic, enabled)', async () => ensureRaProfileOrSkip(api, SPEC, (reason) => test.skip(true, reason)));
            const a = await test.step('Issue certificate A (own, external CSR)', async () => issueOwnCertificate(api, ra, SPEC, { suffix: 'c04' }));
            const aDetail = await getCertificate(api, a.uuid);

            const renew = await test.step('POST …/{A}/renew with a CSR on the SAME key → 200 {uuid B}', async () => {
                // The CSR carries the ISSUED subject (the CA may have completed it) and the same key (RR-5).
                const csr = csrFromKeyWithSubject(a.keys, String(aDetail.subjectDn), sansOfDetail(aDetail.subjectAlternativeNames));
                const r = await renewOwn(api, a, ra, SPEC, { csrDerBase64: csr.derBase64, note: 'API-CERT-04 renew successor' });
                expect(r.status, r.text.slice(0, 300)).toBe(200);
                expect(r.successor, 'the answer names the successor').toBeTruthy();
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
                expect(link, `A lists B among its successors (${rel.successors.length})`).toBeTruthy();
                expect(link!.relationType).toBe('renewal');
                expect((await relationsOf(api, b.uuid)).predecessors.map((p) => p.uuid)).toContain(a.uuid);
            });

            await test.step('Histories: A "Renewed using RA Profile <name>", B "Issued using RA Profile <name>"', async () => {
                expect(historyMessages(await historyOf(api, a.uuid))).toContainEqual(expect.stringContaining(`Renewed using RA Profile ${ra.name}`));
                expect(historyMessages(await historyOf(api, b.uuid))).toContainEqual(expect.stringContaining(`Issued using RA Profile ${ra.name}`));
            });
        });

    test('API-CERT-05: rekey with a new key and the same subject and SAN issues a successor related as rekey with a different key; the original stays issued',
        meta({
            id: 'API-CERT-05', prio: 'P1', issue: 'ilm#429',
            rule: [
                'cert-lifecycle §3.2 RR-6 (a rekey CSR carries a different public key and the same subject), RR-7 (PENDING → REKEY: same DN and issuer, different key)',
                'cert-lifecycle §3.2 RR-11 (history "Rekeyed using RA Profile <name>"), RR-1 (the original stays ISSUED)',
            ],
        }),
        async ({ api }) => {
            test.setTimeout(420_000);
            const ra = await test.step('Prerequisite: the run RA profile (CA-agnostic, enabled)', async () => ensureRaProfileOrSkip(api, SPEC, (reason) => test.skip(true, reason)));
            const a = await test.step('Issue certificate A (own, external CSR)', async () => issueOwnCertificate(api, ra, SPEC, { suffix: 'c05' }));
            const aDetail = await getCertificate(api, a.uuid);

            const rekey = await test.step('POST …/{A}/rekey with a NEW key, same CN and SAN → 200 {uuid B}', async () => {
                // A new key, the ISSUED subject DN and SAN set (core compares the normalized X500 names, RR-6).
                const csr = csrFromKeyWithSubject(newKeyPair(), String(aDetail.subjectDn), sansOfDetail(aDetail.subjectAlternativeNames));
                const r = await rekeyOwn(api, a, ra, SPEC, { csrDerBase64: csr.derBase64, note: 'API-CERT-05 rekey successor' });
                expect(r.status, r.text.slice(0, 300)).toBe(200);
                expect(r.successor, 'the answer names the successor').toBeTruthy();
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
                expect(link, 'A lists B among its successors').toBeTruthy();
                expect(link!.relationType).toBe('rekey');
                expect(historyMessages(await historyOf(api, a.uuid))).toContainEqual(expect.stringContaining(`Rekeyed using RA Profile ${ra.name}`));
            });
        });
});
