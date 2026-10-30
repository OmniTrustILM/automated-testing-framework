/**
 * REG-CERT-12, REG-CERT-13 — Pre-register a certificate and complete it (release checklist: Certificates 12 and 13; ilm#429).
 *
 * Pre-register with and without a challenge, then complete: a wrong secret is refused and the certificate stays Registered;
 * the right secret and a CSR issue it with the CSR's public key. The challenge appears nowhere: not on the page, not in the
 * detail JSON, not in the history.
 *
 * The registration settings are read, never set. Every certificate is recorded in the ledger from the Create answer, before
 * anything is asserted. The authority is the run's own RA profile; the Complete dialog acts only after the live check.
 */
import { expect, test } from '../../../fixtures/regressionFixtures';
import { CertificateAddPage } from '../../../pages/CertificateAddPage';
import { submitFormCreateRecorded } from '../../../utils/regression/ui/certificateFormCreate';
import { CertificateDetailPage } from '../../../pages/CertificateDetailPage';
import { CertificatePage } from '../../../pages/CertificatePage';
import { CompleteRegistrationDialog } from '../../../pages/CompleteRegistrationDialog';
import { historyMessages, historyOf } from '../../../utils/regression/lifecycle/certificateHistory';
import { msBetween, newChallenge, registrationDefaults } from '../../../utils/regression/lifecycle/preRegistration';
import { newKeyPair, csrFromKey, parseCertificate, publicKeyPemOf } from '../../../utils/regression/pkiBuilders';
import { apiJsonWithDate, getCertificate, serverCreatedAfter } from '../../../utils/regression/apiReads';
import { ownCommonName } from '../../../utils/regression/ledger/runState';
import { waitIssued } from '../../../utils/regression/ownCertificates';
import { testMeta, tags } from '../../../utils/regression/tags';
import { ISSUE_MS, LIFECYCLE_MS, REGISTERED_WAIT_MS, REGISTRATION_EXPIRY_TOLERANCE_MS } from '../../../utils/regression/timeouts';
import { waitForCertificateState } from '../../../utils/regression/wait/certificateState';


test.describe('Pre-register and complete in the web UI', { tag: tags.regression }, () => {
    test('a pre-registration with a challenge is Registered with an Active registration and hides the secret',
        testMeta({
            id: 'REG-CERT-12', prio: 'P1', issue: 'ilm#429',
            rule: [
                'fe#1693 / fe#1944 (Pre-register hides key and CSR, shows the optional Challenge and Issuance window; Complete enabled for REGISTERED with an ACTIVE registration; the action is called "Pre-register", not "Request later")',
                'the secret is stored encrypted and never returned; expiresAt = now + defaultIssuanceWindowDays; the authorization row exists only with a secret; platform-level: registered at once',
            ],
        }),
        async ({ signedIn: page, api, own, live, ownRaProfile }) => {
            test.setTimeout(ISSUE_MS);
            const ra = ownRaProfile;
            const defaults = await registrationDefaults(api);
            const certPage = new CertificatePage(page);
            const detail = new CertificateDetailPage(page);
            const addPage = new CertificateAddPage(page);
            const secret = newChallenge();
            const cn = ownCommonName('ui12');

            await test.step('Add Certificate → Pre-register: Key Source and CSR hidden, Challenge and Issuance window shown', async () => {
                await certPage.goToList();
                await certPage.openIssuePage();
                await addPage.chooseRequestTypeRegister();
                await certPage.selectRaProfile(ra.name);
                await addPage.assertRegisterFields();
            });

            // "Now" of the expiry rule is the server's clock (the Date header of a read made right before Create, the runner's clock
            // when the answer has none), so a runner whose clock is off does not use up the tolerance.
            const clock = await apiJsonWithDate(api, 'GET', '/api/v1/settings/platform');
            const serverNow = (clock.serverAt ?? clock.startedAt).getTime();
            const uuid = await test.step('CN in Request Attributes, a 12+ character challenge, Create → the detail of a Registered certificate', async () => {
                await addPage.fillRequestCommonName(cn);
                await addPage.fillChallenge(secret);
                await submitFormCreateRecorded(addPage, own, 'register', { cn: cn, note: 'pre-registered via UI with a challenge', ra: ra });
                // This row accepts the "accepted with warnings" panel (the certificate is opened from it).
                const id = (await addPage.waitForCreatedCertificate({ acceptWarnings: true })).uuid;
                await waitForCertificateState(api, id, 'registered', REGISTERED_WAIT_MS, { failOn: ['failed', 'rejected', 'issued'] });
                return id;
            });

            await test.step('Details after reload: Registered; Registration widget Active, Failed attempts 0, Expires ≈ now + the default window; Complete enabled', async () => {
                await detail.openFresh(uuid);
                await detail.assertState('Registered');
                await detail.assertRegistration({ state: 'Active', failedAttempts: 0 });
                await expect(detail.registrationRow('expires')).not.toHaveText(/^(n\/a)?$/);
                await detail.assertToolbar({ complete: 'enabled' });
                const stored = await getCertificate(api, uuid);
                expect(stored.registration?.state).toBe('active');
                const expected = new Date(serverNow + defaults.defaultIssuanceWindowDays * 24 * 3600 * 1000);
                expect(msBetween(String(stored.registration?.expiresAt), expected), `expiresAt within 5 min of now + ${defaults.defaultIssuanceWindowDays} days`).toBeLessThanOrEqual(REGISTRATION_EXPIRY_TOLERANCE_MS);
            });

            await test.step('The challenge appears nowhere: not on the page, not in the detail JSON, not in the history', async () => {
                expect(await page.content(), 'the page never shows the secret').not.toContain(secret);
                expect(JSON.stringify(await getCertificate(api, uuid))).not.toContain(secret);
                expect(historyMessages(await historyOf(api, uuid)).join('\n')).not.toContain(secret);
            });
        });

    test('a pre-registration without a challenge is Registered and shows no Registration widget',
        testMeta({
            id: 'REG-CERT-12', row: 'without a challenge', prio: 'P1', issue: 'ilm#429',
            rule: [
                'the authorization row exists only with a secret: a registration without a challenge has no Registration widget (fe#1693 / fe#1944)',
            ],
        }),
        async ({ signedIn: page, api, own, ownRaProfile }) => {
            test.setTimeout(ISSUE_MS);
            const ra = ownRaProfile;
            const certPage = new CertificatePage(page);
            const detail = new CertificateDetailPage(page);
            const addPage = new CertificateAddPage(page);

            await test.step('Add Certificate → Pre-register without a challenge → Registered without a Registration widget', async () => {
                const plainCn = ownCommonName('ui12p');
                await certPage.goToList();
                await certPage.openIssuePage();
                await addPage.chooseRequestTypeRegister();
                await certPage.selectRaProfile(ra.name);
                await addPage.fillRequestCommonName(plainCn);
                await submitFormCreateRecorded(addPage, own, 'register', { cn: plainCn, note: 'pre-registered via UI without a challenge', ra: ra });
                // This row accepts the "accepted with warnings" panel (the certificate is opened from it).
                const id = (await addPage.waitForCreatedCertificate({ acceptWarnings: true })).uuid;
                await waitForCertificateState(api, id, 'registered', REGISTERED_WAIT_MS, { failOn: ['failed', 'rejected', 'issued'] });
                expect((await getCertificate(api, id)).registration ?? null).toBeNull();
                await detail.openFresh(id);
                await detail.assertState('Registered');
                await detail.assertNoRegistration();
            });
        });

    test('the Complete dialog counts a wrong secret and issues with the right secret and a CSR',
        testMeta({
            id: 'REG-CERT-13', prio: 'P2', issue: 'ilm#429',
            rule: [
                'wrong secret: 422 "The certificate registration challenge is invalid.", failedAttempts + 1, state stays REGISTERED; a verified secret resets the counter (Complete dialog)',
                'complete = issue with the operator\'s CSR and the secret; after the first issuance the authorization is retained, attempts 0',
            ],
        }),
        async ({ signedIn: page, api, own, live, ownRaProfile }) => {
            // The UI registration, two dialog rounds and the issuance (180 s).
            test.setTimeout(LIFECYCLE_MS);
            const ra = ownRaProfile;
            const certPage = new CertificatePage(page);
            const detail = new CertificateDetailPage(page);
            const addPage = new CertificateAddPage(page);
            const complete = new CompleteRegistrationDialog(page);
            const secret = newChallenge();
            const cn = ownCommonName('ui13');
            const csr = csrFromKey(newKeyPair(), cn);

            const uuid = await test.step('Fixture: a challenge-protected pre-registration through the form', async () => {
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
            const pending = { uuid, name: cn, kind: 'own' as const };

            await test.step('Complete with a WRONG secret → the dialog alert "The certificate registration challenge is invalid."; Failed attempts 1; still Registered', async () => {
                await live('certificates', pending);
                await detail.goToDetail(uuid);
                await page.reload();
                await complete.open();
                await complete.fill({ secret: `${secret}-wrong`, csrPem: csr.pem });
                const answer = await complete.submit();
                expect(answer.status, answer.text.slice(0, 300)).toBe(422);
                await expect(complete.error).toBeVisible();
                await expect(complete.error).toContainText('The certificate registration challenge is invalid.');
                await complete.close();
                await page.reload();
                await detail.openTab('Details');
                await detail.assertState('Registered');
                await detail.assertRegistration({ state: 'Active', failedAttempts: 1 });
                expect((await getCertificate(api, uuid)).registration?.failedAttempts).toBe(1);
            });

            const createdAfter = await serverCreatedAfter(api);
            await test.step('Complete with the RIGHT secret and the CSR → 200; after reload Issued, Failed attempts 0, the public key is the CSR key', async () => {
                await complete.open();
                await complete.fill({ secret, csrPem: csr.pem });
                const answer = await complete.submit();
                expect(answer.status, answer.text.slice(0, 300)).toBe(200);
                await waitIssued(api, uuid);
                await own.derivedKey(uuid, createdAfter);
                await detail.openFresh(uuid);
                await detail.assertState('Issued');
                await detail.assertRegistration({ state: 'Active', failedAttempts: 0 });
                const stored = await getCertificate(api, uuid);
                expect(stored.registration?.failedAttempts ?? 0).toBe(0);
                expect(publicKeyPemOf(parseCertificate(stored.certificateContent))).toBe(csr.publicKeyPem);
            });
        });
});
