/**
 * REG-CERT-07 / 08 — renew and rekey from the certificate detail dialogs (ilm#429 steps 2 and 3; cert-lifecycle rules
 * §3.4 UI row, §3.2 RR-1, RR-5, RR-6, RR-7, RR-11; fe#1857, fe#2264). Every certificate the dialogs act on was issued
 * by this run through the API (so the test holds its key pair for the same-key renew CSR and the same-key rekey
 * negative); every successor the dialog creates is recorded right after the response and deleted by the run-end
 * teardown. The browser is not behind the API guard: `assertOwnLive` runs before each dialog acts.
 */
import { expect, loginAsSmokeUser, test } from '../../fixtures/testFixtures';
import { CertificateLifecyclePage } from '../../pages/CertificateLifecyclePage';
import { csrFromKeyWithSubject, historyMessages, historyOf, issueExisting, issueOwnCertificate, newChallenge, newKeyPair, relationsOf } from '../../utils/regression/lifecycle';
import { assertOwnLive } from '../../utils/regression/ownObjects';
import { csrFromKey, parseCertificate, publicKeyPemOf, sameSans, sansOfDetail } from '../../utils/regression/pki';
import { ensureRaProfileOrSkip, getCertificate, recordCertificatesNamed, recordDerivedKeyOf, serverCreatedAfter } from '../../utils/regression/regressionApi';
import { recordCreated, regName } from '../../utils/regression/regressionRun';
import { meta } from '../../utils/regression/tags';
import { waitForCertificateState } from '../../utils/certificateUtils';

const SPEC = 'REG-CERT-07';
const escapeRe = (s: string) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

test.describe('@regression REG-CERT-07 renew and rekey from the detail dialogs', () => {
    test('REG-CERT-07[renew]: the Renew dialog (register off, CSR on the same key) issues a successor listed as Renewal; the original stays Issued and its History says "Renewed using RA Profile <name>"',
        meta({
            id: 'REG-CERT-07', prio: 'P1', issue: 'ilm#429',
            rule: [
                'cert-lifecycle §3.4 UI row / fe#1857 (Renew dialog, CSR optional only with a platform private key: an externally keyed certificate uploads one), §3.2 RR-1 / RR-5 (same key)',
                'cert-lifecycle §3.2 RR-7 (successor related as Renewal once issued), RR-11 (history "Renewed using RA Profile <name>")',
            ],
        }),
        async ({ page, api, env }) => {
            // One API issuance, the dialog, the successor's issuance (180 s each) and the tab checks.
            test.setTimeout(480_000);
            const ra = await test.step('Prerequisite: the run RA profile (CA-agnostic, enabled)', async () => ensureRaProfileOrSkip(api, SPEC, (reason) => test.skip(true, reason)));
            const a = await test.step('Issue certificate A through the API (own)', async () => issueOwnCertificate(api, ra, SPEC, { suffix: 'ui07' }));
            const aDetail = await getCertificate(api, a.uuid);
            const certPage = new CertificateLifecyclePage(page);

            await test.step('Open the detail of A; Renew dialog with "Register instead of renewing now" off and a same-key CSR', async () => {
                await assertOwnLive(api, 'certificates', a, 'REG-CERT-07 renew (UI)');
                await loginAsSmokeUser(page, env);
                await certPage.goToDetail(a.uuid);
                await certPage.assertToolbar({ renew: 'enabled' });
                await certPage.openRenewDialog();
                await certPage.assertRenewRegisterOff();
                await certPage.pasteRenewCsr(csrFromKeyWithSubject(a.keys, String(aDetail.subjectDn), sansOfDetail(aDetail.subjectAlternativeNames)).pem);
            });

            const createdAfter = await serverCreatedAfter(api);
            const b = await test.step('Submit → 200 with the successor uuid (recorded)', async () => {
                const answer = await certPage.submitRenew();
                if (answer.uuid) recordCreated('certificates', { uuid: answer.uuid, name: a.cn }, SPEC, 'renew successor (UI dialog, REG-CERT-07)', { raProfile: ra.uuid, authority: ra.authorityUuid, predecessor: a.uuid });
                expect(answer.status).toBe(200);
                expect(answer.uuid, 'the renew answer names the successor').toMatch(/^[0-9a-f-]{36}$/);
                await expect(certPage.renewDialog).toBeHidden();
                return answer.uuid!;
            });

            await test.step('The successor reaches Issued with the same public key; A stays Issued', async () => {
                await waitForCertificateState(api, b, 'issued', 180_000);
                await recordDerivedKeyOf(api, b, createdAfter, SPEC);
                const bDetail = await getCertificate(api, b);
                expect(publicKeyPemOf(parseCertificate(bDetail.certificateContent))).toBe(a.csr.publicKeyPem);
                expect((await getCertificate(api, a.uuid)).state).toBe('issued');
                await certPage.goToDetail(a.uuid);
                await page.reload();
                await certPage.assertState('Issued');
            });

            await test.step('Related Certificates tab of A lists the successor as Renewal', async () => {
                await certPage.assertRelated(a.uuid, { uuid: b, role: 'Successor', type: 'Renewal' });
            });

            await test.step('History tab of A: "Renewed using RA Profile <name>"', async () => {
                await certPage.openDetailTab(a.uuid, 'History');
                await certPage.assertHistoryTabHasEntry(new RegExp(`Renewed using RA Profile ${escapeRe(ra.name)}`));
            });
        });

    test('REG-CERT-07[challenge]: a certificate completed from a challenge-protected registration shows a required Challenge field in the Renew dialog',
        meta({
            id: 'REG-CERT-07', prio: 'P1', issue: 'ilm#429',
            rule: [
                'cert-lifecycle §3.4 UI row / fe#1857 (challenge-gated renew: the dialog shows a required Challenge field while the registration authorization is ACTIVE), §3.2 RR-3 (the renew path verifies the secret)',
                'cert-lifecycle §6.2 PR-8 (after the first issuance the authorization is retained for renew / rekey)',
            ],
        }),
        async ({ page, api, env }) => {
            test.setTimeout(420_000);
            const ra = await test.step('Prerequisite: the run RA profile (CA-agnostic, enabled)', async () => ensureRaProfileOrSkip(api, SPEC, (reason) => test.skip(true, reason)));
            const certPage = new CertificateLifecyclePage(page);
            const secret = newChallenge();
            const cn = `${regName(`ui07c-${Date.now().toString(36)}`)}.example.test`;

            // The register route is not on the guard's create list yet (guard request, API-CERT-21): the pre-registration goes
            // through the Add Certificate form, like REG-CERT-12.
            const uuid = await test.step('Pre-register through the form (Pre-register, CN, challenge) → Registered', async () => {
                await loginAsSmokeUser(page, env);
                await certPage.goToList();
                await certPage.openIssuePage();
                await certPage.selectRequestTypeRegister();
                await certPage.selectRaProfile(ra.name);
                await certPage.fillRequestCommonName(cn);
                await certPage.fillChallenge(secret);
                let id: string;
                try {
                    id = await certPage.submitRegister();
                } finally {
                    // Ledger before assertion, whether the redirect came or not (Sonnet 2): every certificate of this run-prefixed CN.
                    await recordCertificatesNamed(api, cn, SPEC, 'pre-registered via UI with a challenge (REG-CERT-07 challenge variant)');
                }
                await waitForCertificateState(api, id, 'registered', 30_000, { failOn: ['failed', 'rejected', 'issued'] });
                return id;
            });

            const createdAfter = await serverCreatedAfter(api);
            await test.step('Complete through the API with the right secret and a CSR → Issued (authorization retained)', async () => {
                const own = { uuid, name: cn, kind: 'own' as const };
                const a = await issueExisting(api, own, ra, { request: csrFromKey(newKeyPair(), cn).derBase64, authorizationSecret: secret });
                expect(a.status, a.text.slice(0, 300)).toBe(200);
                await waitForCertificateState(api, uuid, 'issued', 180_000);
                await recordDerivedKeyOf(api, uuid, createdAfter, SPEC);
                expect((await getCertificate(api, uuid)).registration?.state).toBe('active');
            });

            await test.step('The Renew dialog shows a required Challenge field', async () => {
                await certPage.goToDetail(uuid);
                await page.reload();
                await certPage.assertState('Issued');
                await certPage.openRenewDialog();
                await expect(certPage.renewChallenge).toBeVisible();
                // The FE marks the field as required with the red asterisk of its label, not with an HTML `required` attribute.
                await expect(certPage.renewDialog.getByTestId('label-renewAuthorizationSecret').locator('.text-danger')).toBeVisible();
                await expect(certPage.renewDialog.getByTestId('renewSubmit'), 'submit disabled while the challenge is empty').toBeDisabled();
            });
        });

    test('REG-CERT-08: the Rekey dialog refuses a CSR on the same key ("Public key of certificate and CSR are same", no successor) and issues a new-key CSR as a Rekey successor; History says "Rekeyed using RA Profile <name>"',
        meta({
            id: 'REG-CERT-08', prio: 'P1', issue: 'ilm#429',
            rule: [
                'cert-lifecycle §3.2 RR-6 (a rekey CSR must carry a different key and the same subject: 422 "…Public key of certificate and CSR are same"), fe#2264 (Rekey dialog, Key Source External)',
                'cert-lifecycle §3.2 RR-7 (successor related as Rekey, different key fingerprint, same SAN set), RR-11 (history "Rekeyed using RA Profile <name>")',
            ],
        }),
        async ({ page, api, env }) => {
            test.setTimeout(480_000);
            const ra = await test.step('Prerequisite: the run RA profile (CA-agnostic, enabled)', async () => ensureRaProfileOrSkip(api, SPEC, (reason) => test.skip(true, reason)));
            const a = await test.step('Issue certificate A through the API (own)', async () => issueOwnCertificate(api, ra, SPEC, { suffix: 'ui08' }));
            const aDetail = await getCertificate(api, a.uuid);
            const certPage = new CertificateLifecyclePage(page);

            await test.step('Negative: a CSR on the SAME key → the dialog shows "Public key of certificate and CSR are same" and no successor exists', async () => {
                await assertOwnLive(api, 'certificates', a, 'REG-CERT-08 rekey (UI)');
                await loginAsSmokeUser(page, env);
                await certPage.goToDetail(a.uuid);
                await certPage.openRekeyDialog();
                // The ISSUED subject on the SAME key: only the key rule can fire (RR-6; core compares the normalized X500 names).
                await certPage.fillRekeyExternal(csrFromKeyWithSubject(a.keys, String(aDetail.subjectDn), sansOfDetail(aDetail.subjectAlternativeNames)).pem);
                const answer = await certPage.submitRekey();
                if (answer.uuid) recordCreated('certificates', { uuid: answer.uuid, name: a.cn }, SPEC, 'same-key rekey accepted (REG-CERT-08 negative)', { raProfile: ra.uuid, authority: ra.authorityUuid, predecessor: a.uuid });
                expect(answer.status, answer.text.slice(0, 300)).toBe(422);
                await expect(certPage.rekeyDialogError).toBeVisible();
                await expect(certPage.rekeyDialogError).toContainText('Public key of certificate and CSR are same');
                expect((await relationsOf(api, a.uuid)).successors, 'no successor after the refusal').toEqual([]);
                await certPage.closeRekeyDialog();
            });

            const createdAfter = await serverCreatedAfter(api);
            const rekey = await test.step('Positive: a NEW key, the same CN and SAN → 200 with the successor uuid (recorded)', async () => {
                const csr = csrFromKeyWithSubject(newKeyPair(), String(aDetail.subjectDn), sansOfDetail(aDetail.subjectAlternativeNames));
                await certPage.openRekeyDialog();
                await certPage.fillRekeyExternal(csr.pem);
                const answer = await certPage.submitRekey();
                if (answer.uuid) recordCreated('certificates', { uuid: answer.uuid, name: a.cn }, SPEC, 'rekey successor (UI dialog, REG-CERT-08)', { raProfile: ra.uuid, authority: ra.authorityUuid, predecessor: a.uuid });
                expect(answer.status, answer.text.slice(0, 300)).toBe(200);
                expect(answer.uuid).toMatch(/^[0-9a-f-]{36}$/);
                await expect(certPage.rekeyDialog).toBeHidden();
                return { uuid: answer.uuid!, csr };
            });

            await test.step('The successor is Issued (Rekey): a different key fingerprint, the same SAN set; A stays Issued', async () => {
                await waitForCertificateState(api, rekey.uuid, 'issued', 180_000);
                await recordDerivedKeyOf(api, rekey.uuid, createdAfter, SPEC);
                const bDetail = await getCertificate(api, rekey.uuid);
                expect(bDetail.fingerprint).not.toBe(aDetail.fingerprint);
                expect(publicKeyPemOf(parseCertificate(bDetail.certificateContent))).toBe(rekey.csr.publicKeyPem);
                expect(sameSans(sansOfDetail(bDetail.subjectAlternativeNames), sansOfDetail(aDetail.subjectAlternativeNames)), 'B SAN set = A SAN set').toBe(true);
                expect((await getCertificate(api, a.uuid)).state).toBe('issued');
                await certPage.assertRelated(a.uuid, { uuid: rekey.uuid, role: 'Successor', type: 'Rekey' });
            });

            await test.step('History tab of A: "Rekeyed using RA Profile <name>"', async () => {
                expect(historyMessages(await historyOf(api, a.uuid))).toContainEqual(expect.stringContaining(`Rekeyed using RA Profile ${ra.name}`));
                await certPage.openDetailTab(a.uuid, 'History');
                await certPage.assertHistoryTabHasEntry(new RegExp(`Rekeyed using RA Profile ${escapeRe(ra.name)}`));
            });
        });
});
