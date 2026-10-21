/**
 * REG-CERT-07 / 08 — renew and rekey from the certificate detail dialogs: the Renew dialog issues a same-key
 * successor related as Renewal, a challenge-protected certificate needs the challenge, the Rekey dialog refuses a
 * same-key CSR and issues a new-key successor related as Rekey. Every certificate acted on was issued by this run; every
 * successor is recorded right after the answer; `assertOwnLive` runs before each dialog acts.
 */
import { expect, loginAsSmokeUser, test } from '../../fixtures/testFixtures';
import { CertificateAddPage } from '../../pages/CertificateAddPage';
import { CertificateDetailPage } from '../../pages/CertificateDetailPage';
import { CertificatePage } from '../../pages/CertificatePage';
import { RekeyDialog } from '../../pages/RekeyDialog';
import { RenewDialog } from '../../pages/RenewDialog';
import { historyMessages, historyOf, relationsOf } from '../../utils/regression/lifecycle/certificateHistory';
import { issueExisting } from '../../utils/regression/lifecycle/certificateOperations';
import { newChallenge } from '../../utils/regression/lifecycle/preRegistration';
import { csrFromKeyWithSubject, newKeyPair, csrFromKey, parseCertificate, publicKeyPemOf, sameSans, sansOfDetail } from '../../utils/regression/pkiBuilders';
import { issueOwnCertificate } from '../../utils/regression/ownCertificates';
import { assertOwnLive } from '../../utils/regression/ledger/ownership';
import { getCertificate, serverCreatedAfter } from '../../utils/regression/apiReads';
import { recordCertificatesNamed, recordDerivedKeyOf } from '../../utils/regression/issuedRecords';
import { recordCreated } from '../../utils/regression/ledger/ledger';
import { runName } from '../../utils/regression/ledger/runState';
import { testMeta, tags } from '../../utils/regression/tags';
import { LIFECYCLE_MS, SLOW_LIFECYCLE_MS } from '../../utils/regression/timeouts';
import { waitForCertificateState } from '../../utils/certificateUtils';
import { escapeRegExp } from '../../utils/regression/text';

const SPEC = 'REG-CERT-07';

test.describe('Renew and rekey in the web UI', { tag: tags.regression }, () => {
    test('the Renew dialog issues a same-key successor related as Renewal',
        testMeta({
            id: 'REG-CERT-07', row: 'renew', prio: 'P1', issue: 'ilm#429',
            rule: [
                'fe#1857 (Renew dialog, CSR optional only with a platform private key: an externally keyed certificate uploads one; same key)',
                'successor related as Renewal once issued (history "Renewed using RA Profile <name>")',
            ],
        }),
        async ({ page, api, env, ownRaProfile }) => {
            // One API issuance, the dialog, the successor's issuance (180 s each) and the tab checks.
            test.setTimeout(SLOW_LIFECYCLE_MS);
            const ra = ownRaProfile;
            const a = await test.step('Issue certificate A through the API (own)', async () => issueOwnCertificate(api, ra, SPEC, { suffix: 'ui07' }));
            const aDetail = await getCertificate(api, a.uuid);
            const certPage = new CertificatePage(page);
            const detail = new CertificateDetailPage(page);
            const renew = new RenewDialog(page);

            await test.step('Open the detail of A; Renew dialog with "Register instead of renewing now" off and a same-key CSR', async () => {
                await assertOwnLive(api, 'certificates', a, 'REG-CERT-07 renew (UI)');
                await loginAsSmokeUser(page, env);
                await certPage.goToDetail(a.uuid);
                await detail.assertToolbar({ renew: 'enabled' });
                await renew.open();
                await renew.assertRegisterOff();
                await renew.pasteCsr(csrFromKeyWithSubject(a.keys, String(aDetail.subjectDn), sansOfDetail(aDetail.subjectAlternativeNames)).pem);
            });

            const createdAfter = await serverCreatedAfter(api);
            const b = await test.step('Submit → 200 with the successor uuid (recorded)', async () => {
                const answer = await renew.submit();
                if (answer.uuid) recordCreated('certificates', { uuid: answer.uuid, name: a.cn }, SPEC, 'renew successor (UI dialog, REG-CERT-07)', { raProfile: ra.uuid, authority: ra.authorityUuid, predecessor: a.uuid });
                expect(answer.status).toBe(200);
                expect(answer.uuid, 'the renew answer names the successor').toMatch(/^[0-9a-f-]{36}$/);
                await expect(renew.dialog).toBeHidden();
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
                await detail.openTab('Details');
                await detail.assertState('Issued');
            });

            await test.step('Related Certificates tab of A lists the successor as Renewal', async () => {
                await detail.goToDetailTab(a.uuid, 'Related Certificates');
                await detail.assertRelated({ uuid: b, role: 'Successor', type: 'Renewal' });
            });

            await test.step('History tab of A: "Renewed using RA Profile <name>"', async () => {
                await detail.goToDetailTab(a.uuid, 'History');
                await certPage.assertHistoryTabHasEntry(new RegExp(`Renewed using RA Profile ${escapeRegExp(ra.name)}`));
            });
        });

    test('after a challenged registration the Renew dialog requires the challenge',
        testMeta({
            id: 'REG-CERT-07', row: 'challenge', prio: 'P1', issue: 'ilm#429',
            rule: [
                'fe#1857 (challenge-gated renew: the dialog shows a required Challenge field while the registration authorization is ACTIVE; the renew path verifies the secret)',
                'after the first issuance the authorization is retained for renew / rekey',
            ],
        }),
        async ({ page, api, env, ownRaProfile }) => {
            test.setTimeout(LIFECYCLE_MS);
            const ra = ownRaProfile;
            const certPage = new CertificatePage(page);
            const detail = new CertificateDetailPage(page);
            const addPage = new CertificateAddPage(page);
            const renew = new RenewDialog(page);
            const secret = newChallenge();
            const cn = `${runName(`ui07c-${Date.now().toString(36)}`)}.example.test`;

            // The register route is not on the guard's create list yet (guard request, API-CERT-21): the pre-registration goes
            // through the Add Certificate form, like REG-CERT-12.
            const uuid = await test.step('Pre-register through the form (Pre-register, CN, challenge) → Registered', async () => {
                await loginAsSmokeUser(page, env);
                await certPage.goToList();
                await certPage.openIssuePage();
                await addPage.chooseRequestTypeRegister();
                await certPage.selectRaProfile(ra.name);
                await addPage.fillRequestCommonName(cn);
                await addPage.fillChallenge(secret);
                let id: string;
                try {
                    id = await addPage.submitPreRegistration();
                } finally {
                    // Ledger before assertion, whether the redirect came or not: every certificate of this run-prefixed CN.
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
                await detail.openTab('Details');
                await detail.assertState('Issued');
                await renew.open();
                await expect(renew.challenge).toBeVisible();
                // The FE marks the field as required with the red asterisk of its label, not with an HTML `required` attribute.
                await expect(renew.dialog.getByTestId('label-renewAuthorizationSecret').locator('.text-danger')).toBeVisible();
                await expect(renew.submitButton, 'submit disabled while the challenge is empty').toBeDisabled();
            });
        });

    test('the Rekey dialog refuses a same-key CSR and issues a new-key successor related as Rekey',
        testMeta({
            id: 'REG-CERT-08', prio: 'P1', issue: 'ilm#429',
            rule: [
                'a rekey CSR must carry a different key and the same subject: 422 "…Public key of certificate and CSR are same"; fe#2264 (Rekey dialog, Key Source External)',
                'successor related as Rekey, different key fingerprint, same SAN set (history "Rekeyed using RA Profile <name>")',
            ],
        }),
        async ({ page, api, env, ownRaProfile }) => {
            test.setTimeout(SLOW_LIFECYCLE_MS);
            const ra = ownRaProfile;
            const a = await test.step('Issue certificate A through the API (own)', async () => issueOwnCertificate(api, ra, SPEC, { suffix: 'ui08' }));
            const aDetail = await getCertificate(api, a.uuid);
            const certPage = new CertificatePage(page);
            const detail = new CertificateDetailPage(page);
            const rekey = new RekeyDialog(page);

            await test.step('Negative: a CSR on the SAME key → the dialog shows "Public key of certificate and CSR are same" and no successor exists', async () => {
                await assertOwnLive(api, 'certificates', a, 'REG-CERT-08 rekey (UI)');
                await loginAsSmokeUser(page, env);
                await certPage.goToDetail(a.uuid);
                await rekey.open();
                // The ISSUED subject on the SAME key: only the key rule can fire (core compares the normalized X500 names).
                await rekey.fillExternal(csrFromKeyWithSubject(a.keys, String(aDetail.subjectDn), sansOfDetail(aDetail.subjectAlternativeNames)).pem);
                const answer = await rekey.submit();
                if (answer.uuid) recordCreated('certificates', { uuid: answer.uuid, name: a.cn }, SPEC, 'same-key rekey accepted (REG-CERT-08 negative)', { raProfile: ra.uuid, authority: ra.authorityUuid, predecessor: a.uuid });
                expect(answer.status, answer.text.slice(0, 300)).toBe(422);
                await expect(rekey.error).toBeVisible();
                await expect(rekey.error).toContainText('Public key of certificate and CSR are same');
                expect((await relationsOf(api, a.uuid)).successors, 'no successor after the refusal').toEqual([]);
                await rekey.close();
            });

            const createdAfter = await serverCreatedAfter(api);
            const successor = await test.step('Positive: a NEW key, the same CN and SAN → 200 with the successor uuid (recorded)', async () => {
                const csr = csrFromKeyWithSubject(newKeyPair(), String(aDetail.subjectDn), sansOfDetail(aDetail.subjectAlternativeNames));
                await rekey.open();
                await rekey.fillExternal(csr.pem);
                const answer = await rekey.submit();
                if (answer.uuid) recordCreated('certificates', { uuid: answer.uuid, name: a.cn }, SPEC, 'rekey successor (UI dialog, REG-CERT-08)', { raProfile: ra.uuid, authority: ra.authorityUuid, predecessor: a.uuid });
                expect(answer.status, answer.text.slice(0, 300)).toBe(200);
                expect(answer.uuid).toMatch(/^[0-9a-f-]{36}$/);
                await expect(rekey.dialog).toBeHidden();
                return { uuid: answer.uuid!, csr };
            });

            await test.step('The successor is Issued (Rekey): a different key fingerprint, the same SAN set; A stays Issued', async () => {
                await waitForCertificateState(api, successor.uuid, 'issued', 180_000);
                await recordDerivedKeyOf(api, successor.uuid, createdAfter, SPEC);
                const bDetail = await getCertificate(api, successor.uuid);
                expect(bDetail.fingerprint).not.toBe(aDetail.fingerprint);
                expect(publicKeyPemOf(parseCertificate(bDetail.certificateContent))).toBe(successor.csr.publicKeyPem);
                expect(sameSans(sansOfDetail(bDetail.subjectAlternativeNames), sansOfDetail(aDetail.subjectAlternativeNames)), 'B SAN set = A SAN set').toBe(true);
                expect((await getCertificate(api, a.uuid)).state).toBe('issued');
                await detail.goToDetailTab(a.uuid, 'Related Certificates');
                await detail.assertRelated({ uuid: successor.uuid, role: 'Successor', type: 'Rekey' });
            });

            await test.step('History tab of A: "Rekeyed using RA Profile <name>"', async () => {
                expect(historyMessages(await historyOf(api, a.uuid))).toContainEqual(expect.stringContaining(`Rekeyed using RA Profile ${ra.name}`));
                await detail.goToDetailTab(a.uuid, 'History');
                await certPage.assertHistoryTabHasEntry(new RegExp(`Rekeyed using RA Profile ${escapeRegExp(ra.name)}`));
            });
        });
});
