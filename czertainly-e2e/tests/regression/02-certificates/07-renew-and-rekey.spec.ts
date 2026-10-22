/**
 * REG-CERT-07, REG-CERT-08 — Renew and rekey from the certificate detail dialogs (release checklist: Certificates 7 and 8). ilm#429.
 *
 * WHAT: 1. Detail → Renew with a same-key CSR (REG-CERT-07, row renew) → the successor is Issued with the same public key; the
 *          Related Certificates tab lists it as a Renewal and the History tab says "Renewed using RA Profile <name>".
 *       2. A challenge-protected pre-registration, completed through the API (row challenge) → the Renew dialog shows a
 *          required Challenge field and the submit button stays disabled while it is empty.
 *       3. Detail → Rekey with a CSR on the same key (REG-CERT-08) → refused (422, "Public key of certificate and CSR are same"),
 *          no successor exists.
 *       4. Rekey with a new key, same subject and SANs → the successor is Issued with a different fingerprint and the same SAN
 *          set, related as Rekey; the History tab says "Rekeyed using RA Profile <name>".
 * WHY: renew and rekey are the lifecycle actions an operator uses on an issued certificate; a rekey must change the key, a
 *      renew must keep it, and a challenge-protected certificate must ask for its challenge.
 * HOW: every certificate acted on is issued by this run through the API (or pre-registered in the form); every successor is
 *      recorded in the ledger right after the dialog's answer, before any assertion, and its platform-made key after the
 *      issuance; the live ownership check runs before each dialog acts. The authority is the run's own RA profile; timeouts cover the
 *      issuances (180 s each).
 */
import { expect, test } from '../../../fixtures/regressionFixtures';
import { CertificateAddPage } from '../../../pages/CertificateAddPage';
import { submitFormCreateRecorded } from '../../../utils/regression/ui/certificateFormCreate';
import { CertificateDetailPage } from '../../../pages/CertificateDetailPage';
import { CertificatePage } from '../../../pages/CertificatePage';
import { RekeyDialog } from '../../../pages/RekeyDialog';
import { RenewDialog } from '../../../pages/RenewDialog';
import { historyMessages, historyOf, relationsOf } from '../../../utils/regression/lifecycle/certificateHistory';
import { issueExisting } from '../../../utils/regression/lifecycle/certificateOperations';
import { newChallenge } from '../../../utils/regression/lifecycle/preRegistration';
import { csrFromKeyWithSubject, newKeyPair, csrFromKey, parseCertificate, publicKeyPemOf, sameSans, sansOfDetail } from '../../../utils/regression/pkiBuilders';
import { getCertificate, serverCreatedAfter } from '../../../utils/regression/apiReads';
import { recordDerivedKeyOf } from '../../../utils/regression/issuedRecords';
import { ownCommonName } from '../../../utils/regression/ledger/runState';
import { waitIssued } from '../../../utils/regression/ownCertificates';
import { testMeta, tags } from '../../../utils/regression/tags';
import { LIFECYCLE_MS, REGISTERED_WAIT_MS, SLOW_LIFECYCLE_MS } from '../../../utils/regression/timeouts';
import { waitForCertificateState } from '../../../utils/regression/wait/certificateState';
import { escapeRegExp } from '../../../utils/regression/text';


test.describe('Renew and rekey in the web UI', { tag: tags.regression }, () => {
    test('the Renew dialog issues a same-key successor related as Renewal',
        testMeta({
            id: 'REG-CERT-07', row: 'renew', prio: 'P1', issue: 'ilm#429',
            rule: [
                'fe#1857 (Renew dialog, CSR optional only with a platform private key: an externally keyed certificate uploads one; same key)',
                'successor related as Renewal once issued (history "Renewed using RA Profile <name>")',
            ],
        }),
        async ({ signedIn: page, api, own, live, ownRaProfile }) => {
            // One API issuance, the dialog, the successor's issuance (180 s each) and the tab checks.
            test.setTimeout(SLOW_LIFECYCLE_MS);
            const ra = ownRaProfile;
            const a = await test.step('Issue certificate A through the API (own)', async () => own.certificate.issue(ra, { suffix: 'ui07' }));
            const aDetail = await getCertificate(api, a.uuid);
            const certPage = new CertificatePage(page);
            const detail = new CertificateDetailPage(page);
            const renew = new RenewDialog(page);

            await test.step('Open the detail of A; Renew dialog with "Register instead of renewing now" off and a same-key CSR', async () => {
                await live('certificates', a);
                await detail.goToDetail(a.uuid);
                await detail.assertToolbar({ renew: 'enabled' });
                await renew.open();
                await renew.assertRegisterOff();
                await renew.pasteCsr(csrFromKeyWithSubject(a.keys, String(aDetail.subjectDn), sansOfDetail(aDetail.subjectAlternativeNames)).pem);
            });

            const createdAfter = await serverCreatedAfter(api);
            const b = await test.step('Submit → 200 with the successor uuid (recorded)', async () => {
                const answer = await renew.submit();
                own.record('certificates', answer, { name: a.cn, note: 'renew successor (UI dialog)', parents: { raProfile: ra.uuid, authority: ra.authorityUuid, predecessor: a.uuid } });
                expect(answer.status).toBe(200);
                expect(answer.uuid, 'the renew answer names the successor').toMatch(/^[0-9a-f-]{36}$/);
                await expect(renew.dialog).toBeHidden();
                return answer.uuid!;
            });

            await test.step('The successor reaches Issued with the same public key; A stays Issued', async () => {
                await waitIssued(api, b);
                await recordDerivedKeyOf(api, b, createdAfter, own.spec);
                const bDetail = await getCertificate(api, b);
                expect(publicKeyPemOf(parseCertificate(bDetail.certificateContent))).toBe(a.csr.publicKeyPem);
                expect((await getCertificate(api, a.uuid)).state).toBe('issued');
                await detail.openFresh(a.uuid);
                await detail.assertState('Issued');
            });

            await test.step('Related Certificates tab of A lists the successor as Renewal', async () => {
                await detail.goToDetail(a.uuid, { tab: 'Related Certificates' });
                await detail.assertRelated({ uuid: b, role: 'Successor', type: 'Renewal' });
            });

            await test.step('History tab of A: "Renewed using RA Profile <name>"', async () => {
                await detail.goToDetail(a.uuid, { tab: 'History' });
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
        async ({ signedIn: page, api, own, live, ownRaProfile }) => {
            test.setTimeout(LIFECYCLE_MS);
            const ra = ownRaProfile;
            const certPage = new CertificatePage(page);
            const detail = new CertificateDetailPage(page);
            const addPage = new CertificateAddPage(page);
            const renew = new RenewDialog(page);
            const secret = newChallenge();
            const cn = ownCommonName('ui07c');

            // The register route is not on the guard's create allow-list, so the pre-registration goes
            // through the Add Certificate form, like REG-CERT-12.
            const uuid = await test.step('Pre-register through the form (Pre-register, CN, challenge) → Registered', async () => {
                await certPage.goToList();
                await certPage.openIssuePage();
                await addPage.chooseRequestTypeRegister();
                await certPage.selectRaProfile(ra.name);
                await addPage.fillRequestCommonName(cn);
                await addPage.fillChallenge(secret);
                await submitFormCreateRecorded(addPage, own, 'register', { cn: cn, note: 'pre-registered via UI with a challenge', ra: ra });
                // This row accepts the "accepted with warnings" panel (the certificate is opened from it).
                const id = (await addPage.waitForCreatedCertificate({ acceptWarnings: true })).uuid;
                await waitForCertificateState(api, id, 'registered', REGISTERED_WAIT_MS, { failOn: ['failed', 'rejected', 'issued'] });
                return id;
            });

            const createdAfter = await serverCreatedAfter(api);
            await test.step('Complete through the API with the right secret and a CSR → Issued (authorization retained)', async () => {
                const pending = { uuid, name: cn, kind: 'own' as const };
                const a = await issueExisting(api, pending, ra, { request: csrFromKey(newKeyPair(), cn).derBase64, authorizationSecret: secret });
                expect(a.status, a.text.slice(0, 300)).toBe(200);
                await waitIssued(api, uuid);
                await recordDerivedKeyOf(api, uuid, createdAfter, own.spec);
                expect((await getCertificate(api, uuid)).registration?.state).toBe('active');
            });

            await test.step('The Renew dialog shows a required Challenge field', async () => {
                await detail.openFresh(uuid);
                await detail.assertState('Issued');
                await live('certificates', { uuid, name: cn });
                await renew.open();
                await renew.assertChallengeRequired();
                await expect(renew.submitButton, 'submit disabled while the challenge is empty').toBeDisabled();
            });
        });

    test('the Rekey dialog refuses a same-key CSR and issues a new-key successor related as Rekey',
        testMeta({
            id: 'REG-CERT-08', prio: 'P2', issue: 'ilm#429',
            rule: [
                'a rekey CSR must carry a different key and the same subject: 422 "…Public key of certificate and CSR are same"; fe#2264 (Rekey dialog, Key Source External)',
                'successor related as Rekey, different key fingerprint, same SAN set (history "Rekeyed using RA Profile <name>")',
            ],
        }),
        async ({ signedIn: page, api, own, live, ownRaProfile }) => {
            test.setTimeout(SLOW_LIFECYCLE_MS);
            const ra = ownRaProfile;
            const a = await test.step('Issue certificate A through the API (own)', async () => own.certificate.issue(ra, { suffix: 'ui08' }));
            const aDetail = await getCertificate(api, a.uuid);
            const certPage = new CertificatePage(page);
            const detail = new CertificateDetailPage(page);
            const rekey = new RekeyDialog(page);

            await test.step('Negative: a CSR on the SAME key → the dialog shows "Public key of certificate and CSR are same" and no successor exists', async () => {
                await live('certificates', a);
                await detail.goToDetail(a.uuid);
                await rekey.open();
                // The ISSUED subject on the SAME key: only the key rule can fire (core compares the normalized X500 names).
                await rekey.fillExternal(csrFromKeyWithSubject(a.keys, String(aDetail.subjectDn), sansOfDetail(aDetail.subjectAlternativeNames)).pem);
                const answer = await rekey.submit();
                // A refusal is expected: an accepted same-key rekey is recorded first (own.record throws after the line is written).
                if (answer.uuid) own.record('certificates', answer, { name: a.cn, note: 'same-key rekey accepted (negative probe)', parents: { raProfile: ra.uuid, authority: ra.authorityUuid, predecessor: a.uuid } });
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
                own.record('certificates', answer, { name: a.cn, note: 'rekey successor (UI dialog)', parents: { raProfile: ra.uuid, authority: ra.authorityUuid, predecessor: a.uuid } });
                expect(answer.status, answer.text.slice(0, 300)).toBe(200);
                expect(answer.uuid).toMatch(/^[0-9a-f-]{36}$/);
                await expect(rekey.dialog).toBeHidden();
                return { uuid: answer.uuid!, csr };
            });

            await test.step('The successor is Issued (Rekey): a different key fingerprint, the same SAN set; A stays Issued', async () => {
                await waitIssued(api, successor.uuid);
                await recordDerivedKeyOf(api, successor.uuid, createdAfter, own.spec);
                const bDetail = await getCertificate(api, successor.uuid);
                expect(bDetail.fingerprint).not.toBe(aDetail.fingerprint);
                expect(publicKeyPemOf(parseCertificate(bDetail.certificateContent))).toBe(successor.csr.publicKeyPem);
                expect(sameSans(sansOfDetail(bDetail.subjectAlternativeNames), sansOfDetail(aDetail.subjectAlternativeNames)), 'B SAN set = A SAN set').toBe(true);
                expect((await getCertificate(api, a.uuid)).state).toBe('issued');
                await detail.goToDetail(a.uuid, { tab: 'Related Certificates' });
                await detail.assertRelated({ uuid: successor.uuid, role: 'Successor', type: 'Rekey' });
            });

            await test.step('History tab of A: "Rekeyed using RA Profile <name>"', async () => {
                expect(historyMessages(await historyOf(api, a.uuid))).toContainEqual(expect.stringContaining(`Rekeyed using RA Profile ${ra.name}`));
                await detail.goToDetail(a.uuid, { tab: 'History' });
                await certPage.assertHistoryTabHasEntry(new RegExp(`Rekeyed using RA Profile ${escapeRegExp(ra.name)}`));
            });
        });
});
