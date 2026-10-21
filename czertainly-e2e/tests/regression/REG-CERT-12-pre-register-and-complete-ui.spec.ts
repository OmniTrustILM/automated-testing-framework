/**
 * REG-CERT-12 / 13 — pre-register a certificate in the Add Certificate form and complete it from the detail dialog:
 * the form shows Challenge and Issuance window instead of key and CSR, the registration is Active with the default window
 * and the secret is shown nowhere; the Complete dialog refuses a wrong secret (one failed attempt) and issues with the
 * right one. The registration settings are read, never set; every certificate is recorded right after Create.
 */
import { expect, loginAsSmokeUser, test } from '../../fixtures/testFixtures';
import { CertificateAddPage } from '../../pages/CertificateAddPage';
import { CertificateDetailPage } from '../../pages/CertificateDetailPage';
import { CertificatePage } from '../../pages/CertificatePage';
import { CompleteRegistrationDialog } from '../../pages/CompleteRegistrationDialog';
import { historyMessages, historyOf } from '../../utils/regression/lifecycle/certificateHistory';
import { msBetween, newChallenge, registrationDefaults } from '../../utils/regression/lifecycle/preRegistration';
import { newKeyPair, csrFromKey, parseCertificate, publicKeyPemOf } from '../../utils/regression/pkiBuilders';
import { assertOwnLive } from '../../utils/regression/ledger/ownership';
import { getCertificate, serverCreatedAfter } from '../../utils/regression/apiReads';
import { recordCertificatesNamed, recordDerivedKeyOf } from '../../utils/regression/issuedRecords';
import { runName } from '../../utils/regression/ledger/runState';
import { testMeta, tags } from '../../utils/regression/tags';
import { ISSUE_MS, LIFECYCLE_MS } from '../../utils/regression/timeouts';
import { waitForCertificateState } from '../../utils/certificateUtils';

const SPEC = 'REG-CERT-12';

test.describe('Pre-register and complete in the web UI', { tag: tags.regression }, () => {
    test('a pre-registration with a challenge is Registered with an Active registration and hides the secret',
        testMeta({
            id: 'REG-CERT-12', prio: 'P1', issue: 'ilm#429',
            rule: [
                'fe#1693 / fe#1944 (Pre-register hides key and CSR, shows the optional Challenge and Issuance window; Complete enabled for REGISTERED with an ACTIVE registration; the action is called "Pre-register", not "Request later")',
                'the secret is stored encrypted and never returned; expiresAt = now + defaultIssuanceWindowDays; the authorization row exists only with a secret; platform-level: registered at once',
            ],
        }),
        async ({ page, api, env, ownRaProfile }) => {
            test.setTimeout(ISSUE_MS);
            const ra = ownRaProfile;
            const defaults = await registrationDefaults(api);
            const certPage = new CertificatePage(page);
            const detail = new CertificateDetailPage(page);
            const addPage = new CertificateAddPage(page);
            const secret = newChallenge();
            const cn = `${runName(`ui12-${Date.now().toString(36)}`)}.example.test`;

            await test.step('Add Certificate → Pre-register: Key Source and CSR hidden, Challenge and Issuance window shown', async () => {
                await loginAsSmokeUser(page, env);
                await certPage.goToList();
                await certPage.openIssuePage();
                await addPage.chooseRequestTypeRegister();
                await certPage.selectRaProfile(ra.name);
                await addPage.assertRegisterFields();
            });

            const createdAfter = await serverCreatedAfter(api);
            const uuid = await test.step('CN in Request Attributes, a 12+ character challenge, Create → the detail of a Registered certificate', async () => {
                await addPage.fillRequestCommonName(cn);
                await addPage.fillChallenge(secret);
                let id: string;
                try {
                    id = await addPage.submitPreRegistration();
                } finally {
                    // Ledger before assertion, whether the redirect came or not.
                    await recordCertificatesNamed(api, cn, SPEC, 'pre-registered via UI with a challenge (REG-CERT-12)');
                }
                await waitForCertificateState(api, id, 'registered', 30_000, { failOn: ['failed', 'rejected', 'issued'] });
                return id;
            });

            await test.step('Details after reload: Registered; Registration widget Active, Failed attempts 0, Expires ≈ now + the default window; Complete enabled', async () => {
                await certPage.goToDetail(uuid);
                await page.reload();
                await detail.openTab('Details');
                await detail.assertState('Registered');
                await detail.assertRegistration({ state: 'Active', failedAttempts: 0 });
                await expect(detail.registrationRow('expires')).not.toHaveText(/^(n\/a)?$/);
                await detail.assertToolbar({ complete: 'enabled' });
                const stored = await getCertificate(api, uuid);
                expect(stored.registration?.state).toBe('active');
                const expected = new Date(Date.parse(createdAfter ?? new Date().toISOString()) + defaults.defaultIssuanceWindowDays * 24 * 3600 * 1000);
                expect(msBetween(String(stored.registration?.expiresAt), expected), `expiresAt within 5 min of now + ${defaults.defaultIssuanceWindowDays} days`).toBeLessThanOrEqual(5 * 60 * 1000);
            });

            await test.step('The challenge appears nowhere: not on the page, not in the detail JSON, not in the history', async () => {
                expect(await page.content(), 'the page never shows the secret').not.toContain(secret);
                expect(JSON.stringify(await getCertificate(api, uuid))).not.toContain(secret);
                expect(historyMessages(await historyOf(api, uuid)).join('\n')).not.toContain(secret);
            });

            await test.step('Pre-register without a challenge → Registered without a Registration widget', async () => {
                const plainCn = `${runName(`ui12p-${Date.now().toString(36)}`)}.example.test`;
                await certPage.goToList();
                await certPage.openIssuePage();
                await addPage.chooseRequestTypeRegister();
                await certPage.selectRaProfile(ra.name);
                await addPage.fillRequestCommonName(plainCn);
                let id: string;
                try {
                    id = await addPage.submitPreRegistration();
                } finally {
                    await recordCertificatesNamed(api, plainCn, SPEC, 'pre-registered via UI without a challenge (REG-CERT-12)');
                }
                await waitForCertificateState(api, id, 'registered', 30_000, { failOn: ['failed', 'rejected', 'issued'] });
                expect((await getCertificate(api, id)).registration ?? null).toBeNull();
                await certPage.goToDetail(id);
                await page.reload();
                await detail.openTab('Details');
                await detail.assertState('Registered');
                await detail.assertNoRegistration();
            });
        });

    test('the Complete dialog counts a wrong secret and issues with the right secret and a CSR',
        testMeta({
            id: 'REG-CERT-13', prio: 'P1', issue: 'ilm#429',
            rule: [
                'wrong secret: 422 "The certificate registration challenge is invalid.", failedAttempts + 1, state stays REGISTERED; a verified secret resets the counter (Complete dialog)',
                'complete = issue with the operator\'s CSR and the secret; after the first issuance the authorization is retained, attempts 0',
            ],
        }),
        async ({ page, api, env, ownRaProfile }) => {
            // The UI registration, two dialog rounds and the issuance (180 s).
            test.setTimeout(LIFECYCLE_MS);
            const ra = ownRaProfile;
            const certPage = new CertificatePage(page);
            const detail = new CertificateDetailPage(page);
            const addPage = new CertificateAddPage(page);
            const complete = new CompleteRegistrationDialog(page);
            const secret = newChallenge();
            const cn = `${runName(`ui13-${Date.now().toString(36)}`)}.example.test`;
            const csr = csrFromKey(newKeyPair(), cn);

            const uuid = await test.step('Fixture: a challenge-protected pre-registration through the form', async () => {
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
                    await recordCertificatesNamed(api, cn, SPEC, 'pre-registered via UI with a challenge (REG-CERT-13)');
                }
                await waitForCertificateState(api, id, 'registered', 30_000, { failOn: ['failed', 'rejected', 'issued'] });
                return id;
            });
            const own = { uuid, name: cn, kind: 'own' as const };

            await test.step('Complete with a WRONG secret → the dialog alert "The certificate registration challenge is invalid."; Failed attempts 1; still Registered', async () => {
                await assertOwnLive(api, 'certificates', own, 'REG-CERT-13 complete (UI)');
                await certPage.goToDetail(uuid);
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
                await waitForCertificateState(api, uuid, 'issued', 180_000);
                await recordDerivedKeyOf(api, uuid, createdAfter, SPEC);
                await certPage.goToDetail(uuid);
                await page.reload();
                await detail.openTab('Details');
                await detail.assertState('Issued');
                await detail.assertRegistration({ state: 'Active', failedAttempts: 0 });
                const stored = await getCertificate(api, uuid);
                expect(stored.registration?.failedAttempts ?? 0).toBe(0);
                expect(publicKeyPemOf(parseCertificate(stored.certificateContent))).toBe(csr.publicKeyPem);
            });
        });
});
