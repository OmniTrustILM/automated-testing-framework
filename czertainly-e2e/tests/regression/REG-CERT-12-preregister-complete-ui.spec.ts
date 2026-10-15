/**
 * REG-CERT-12 / 13 — pre-register a certificate in the web UI and complete it from the detail dialog (ilm#429 step 8;
 * cert-lifecycle rules §6.4 UI rows, §6.2 PR-1, PR-3, PR-6, PR-7, PR-8, PR-11; fe#1693, fe#1944; §10 C1: the request
 * type is "Pre-register"). The registration settings are READ (never set) and the Expires oracle is computed from them.
 * Both registrations go through the Add Certificate form (the API register route waits for a guard change, API-CERT-21);
 * every certificate is recorded right after Create and deleted by the run-end teardown.
 */
import { expect, loginAsSmokeUser, test } from '../../fixtures/testFixtures';
import { CertificateLifecyclePage } from '../../pages/CertificateLifecyclePage';
import { historyMessages, historyOf, msBetween, newChallenge, newKeyPair, registrationDefaults } from '../../utils/regression/lifecycle';
import { assertOwnLive } from '../../utils/regression/ownObjects';
import { csrFromKey, parseCertificate, publicKeyPemOf } from '../../utils/regression/pki';
import { ensureRaProfileOrSkip, getCertificate, recordCertificatesNamed, recordDerivedKeyOf, serverCreatedAfter } from '../../utils/regression/regressionApi';
import { regName } from '../../utils/regression/regressionRun';
import { meta } from '../../utils/regression/tags';
import { waitForCertificateState } from '../../utils/certificateUtils';

const SPEC = 'REG-CERT-12';

test.describe('@regression REG-CERT-12 pre-register and complete in the web UI', () => {
    test('REG-CERT-12: Pre-register hides Key Source and CSR, shows Challenge and Issuance window; Create with a challenge → Registered with an Active registration (0 attempts, the default window), Complete enabled, the secret shown nowhere; without a challenge no Registration widget',
        meta({
            id: 'REG-CERT-12', prio: 'P1', issue: 'ilm#429',
            rule: [
                'cert-lifecycle §6.2 PR-11 / fe#1693 / fe#1944 (Pre-register hides key and CSR, shows the optional Challenge and Issuance window; Complete enabled for REGISTERED with an ACTIVE registration), §10 C1 ("Pre-register", not "Request later")',
                'cert-lifecycle §6.2 PR-1 (the secret is stored encrypted and never returned; expiresAt = now + defaultIssuanceWindowDays), PR-3 (the authorization row exists only with a secret), PR-5 (platform-level: registered at once)',
            ],
        }),
        async ({ page, api, env }) => {
            test.setTimeout(240_000);
            const ra = await test.step('Prerequisite: the run RA profile (CA-agnostic, enabled)', async () => ensureRaProfileOrSkip(api, SPEC, (reason) => test.skip(true, reason)));
            const defaults = await registrationDefaults(api);
            const certPage = new CertificateLifecyclePage(page);
            const secret = newChallenge();
            const cn = `${regName(`ui12-${Date.now().toString(36)}`)}.example.test`;

            await test.step('Add Certificate → Pre-register: Key Source and CSR hidden, Challenge and Issuance window shown', async () => {
                await loginAsSmokeUser(page, env);
                await certPage.goToList();
                await certPage.openIssuePage();
                await certPage.selectRequestTypeRegister();
                await certPage.selectRaProfile(ra.name);
                await certPage.assertRegisterFields();
            });

            const createdAfter = await serverCreatedAfter(api);
            const uuid = await test.step('CN in Request Attributes, a 12+ character challenge, Create → the detail of a Registered certificate', async () => {
                await certPage.fillRequestCommonName(cn);
                await certPage.fillChallenge(secret);
                let id: string;
                try {
                    id = await certPage.submitRegister();
                } finally {
                    // Ledger before assertion, whether the redirect came or not (Sonnet 2).
                    await recordCertificatesNamed(api, cn, SPEC, 'pre-registered via UI with a challenge (REG-CERT-12)');
                }
                await waitForCertificateState(api, id, 'registered', 30_000, { failOn: ['failed', 'rejected', 'issued'] });
                return id;
            });

            await test.step('Details after reload: Registered; Registration widget Active, Failed attempts 0, Expires ≈ now + the default window; Complete enabled', async () => {
                await certPage.goToDetail(uuid);
                await page.reload();
                await certPage.assertState('Registered');
                await certPage.assertRegistration({ state: 'Active', failedAttempts: 0 });
                await expect(certPage.registrationRow('expires')).not.toHaveText(/^(n\/a)?$/);
                await certPage.assertToolbar({ complete: 'enabled' });
                const detail = await getCertificate(api, uuid);
                expect(detail.registration?.state).toBe('active');
                const expected = new Date(Date.parse(createdAfter ?? new Date().toISOString()) + defaults.defaultIssuanceWindowDays * 24 * 3600 * 1000);
                expect(msBetween(String(detail.registration?.expiresAt), expected), `expiresAt within 5 min of now + ${defaults.defaultIssuanceWindowDays} days`).toBeLessThanOrEqual(5 * 60 * 1000);
            });

            await test.step('The challenge appears nowhere: not on the page, not in the detail JSON, not in the history', async () => {
                expect(await page.content(), 'the page never shows the secret').not.toContain(secret);
                expect(JSON.stringify(await getCertificate(api, uuid))).not.toContain(secret);
                expect(historyMessages(await historyOf(api, uuid)).join('\n')).not.toContain(secret);
            });

            await test.step('Pre-register without a challenge → Registered without a Registration widget', async () => {
                const plainCn = `${regName(`ui12p-${Date.now().toString(36)}`)}.example.test`;
                await certPage.goToList();
                await certPage.openIssuePage();
                await certPage.selectRequestTypeRegister();
                await certPage.selectRaProfile(ra.name);
                await certPage.fillRequestCommonName(plainCn);
                let id: string;
                try {
                    id = await certPage.submitRegister();
                } finally {
                    await recordCertificatesNamed(api, plainCn, SPEC, 'pre-registered via UI without a challenge (REG-CERT-12)');
                }
                await waitForCertificateState(api, id, 'registered', 30_000, { failOn: ['failed', 'rejected', 'issued'] });
                expect((await getCertificate(api, id)).registration ?? null).toBeNull();
                await certPage.goToDetail(id);
                await page.reload();
                await certPage.assertState('Registered');
                await certPage.assertNoRegistration();
            });
        });

    test('REG-CERT-13: the Complete dialog refuses a wrong secret ("The certificate registration challenge is invalid.", Failed attempts 1, still Registered) and issues with the right secret and a CSR (Issued, Failed attempts 0, the CSR key)',
        meta({
            id: 'REG-CERT-13', prio: 'P1', issue: 'ilm#429',
            rule: [
                'cert-lifecycle §6.2 PR-7 (wrong secret: 422 "The certificate registration challenge is invalid.", failedAttempts + 1, state stays REGISTERED; a verified secret resets the counter), §6.4 Complete dialog row',
                'cert-lifecycle §6.2 PR-6 (complete = issue with the operator\'s CSR and the secret), PR-8 (after the first issuance the authorization is retained, attempts 0)',
            ],
        }),
        async ({ page, api, env }) => {
            // The UI registration, two dialog rounds and the issuance (180 s).
            test.setTimeout(420_000);
            const ra = await test.step('Prerequisite: the run RA profile (CA-agnostic, enabled)', async () => ensureRaProfileOrSkip(api, SPEC, (reason) => test.skip(true, reason)));
            const certPage = new CertificateLifecyclePage(page);
            const secret = newChallenge();
            const cn = `${regName(`ui13-${Date.now().toString(36)}`)}.example.test`;
            const csr = csrFromKey(newKeyPair(), cn);

            const uuid = await test.step('Fixture: a challenge-protected pre-registration through the form', async () => {
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
                await certPage.openCompleteDialog();
                await certPage.fillComplete({ secret: `${secret}-wrong`, csrPem: csr.pem });
                const answer = await certPage.submitComplete();
                expect(answer.status, answer.text.slice(0, 300)).toBe(422);
                await expect(certPage.completeDialogError).toBeVisible();
                await expect(certPage.completeDialogError).toContainText('The certificate registration challenge is invalid.');
                await certPage.closeCompleteDialog();
                await page.reload();
                await certPage.assertState('Registered');
                await certPage.assertRegistration({ state: 'Active', failedAttempts: 1 });
                expect((await getCertificate(api, uuid)).registration?.failedAttempts).toBe(1);
            });

            const createdAfter = await serverCreatedAfter(api);
            await test.step('Complete with the RIGHT secret and the CSR → 200; after reload Issued, Failed attempts 0, the public key is the CSR key', async () => {
                await certPage.openCompleteDialog();
                await certPage.fillComplete({ secret, csrPem: csr.pem });
                const answer = await certPage.submitComplete();
                expect(answer.status, answer.text.slice(0, 300)).toBe(200);
                await waitForCertificateState(api, uuid, 'issued', 180_000);
                await recordDerivedKeyOf(api, uuid, createdAfter, SPEC);
                await certPage.goToDetail(uuid);
                await page.reload();
                await certPage.assertState('Issued');
                await certPage.assertRegistration({ state: 'Active', failedAttempts: 0 });
                const detail = await getCertificate(api, uuid);
                expect(detail.registration?.failedAttempts ?? 0).toBe(0);
                expect(publicKeyPemOf(parseCertificate(detail.certificateContent))).toBe(csr.publicKeyPem);
            });
        });
});
