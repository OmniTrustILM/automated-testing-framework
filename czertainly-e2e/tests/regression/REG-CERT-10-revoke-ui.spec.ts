/**
 * REG-CERT-10 — revoke from the detail dialog with Key compromise (ilm#429 step 4; cert-lifecycle rules §4.4 UI row,
 * §4.2 RV-1, RV-2, RV-5; §7.6). The certificate was issued by this run through the API; the browser is not behind the
 * API guard, so `assertOwnLive` runs before the dialog acts; the run-end teardown deletes the revoked certificate.
 */
import { expect, loginAsSmokeUser, test } from '../../fixtures/testFixtures';
import { CertificateLifecyclePage } from '../../pages/CertificateLifecyclePage';
import { historyMessages, historyOf, issueOwnCertificate, REVOKE_REASONS, revokedText } from '../../utils/regression/lifecycle';
import { assertOwnLive } from '../../utils/regression/ownObjects';
import { ensureRaProfileOrSkip, getCertificate } from '../../utils/regression/regressionApi';
import { meta } from '../../utils/regression/tags';
import { waitForCertificateState } from '../../utils/certificateUtils';

const SPEC = 'REG-CERT-10';

test.describe('@regression REG-CERT-10 revoke from the detail dialog', () => {
    test('REG-CERT-10: the Revoke dialog offers exactly the nine reasons; Key compromise revokes the certificate (Revoked after reload, Revoke disabled, History "Certificate revoked. Reason: Key compromise")',
        meta({
            id: 'REG-CERT-10', prio: 'P1', issue: 'ilm#429',
            rule: [
                'cert-lifecycle §4.2 RV-2 (the nine CertificateRevocationReason labels), RV-1 (revoke of an ISSUED certificate: 204, completion through the authority)',
                'cert-lifecycle §4.2 RV-5 (history "Certificate revoked. Reason: Key compromise"), RV-11 (REVOKED is terminal), §7.6 (Revoke enabled only for Issued)',
            ],
        }),
        async ({ page, api, env }) => {
            // One API issuance (180 s), the dialog, the revocation (120 s) and the tab checks.
            test.setTimeout(420_000);
            const ra = await test.step('Prerequisite: the run RA profile (CA-agnostic, enabled)', async () => ensureRaProfileOrSkip(api, SPEC, (reason) => test.skip(true, reason)));
            const cert = await test.step('Issue an own certificate through the API', async () => issueOwnCertificate(api, ra, SPEC, { suffix: 'ui10' }));
            const certPage = new CertificateLifecyclePage(page);

            await test.step('Open the detail; the Revoke dialog offers exactly the nine reason labels', async () => {
                await assertOwnLive(api, 'certificates', cert, 'REG-CERT-10 revoke (UI)');
                await loginAsSmokeUser(page, env);
                await certPage.goToDetail(cert.uuid);
                await certPage.assertToolbar({ revoke: 'enabled' });
                await certPage.openRevokeDialog();
                await certPage.assertRevokeReasons(REVOKE_REASONS.map((r) => r.label));
            });

            await test.step('Choose Key compromise and submit → 204', async () => {
                await certPage.chooseRevokeReason('Key compromise');
                expect(await certPage.submitRevoke()).toBe(204);
                await expect(certPage.revokeDialog).toBeHidden();
            });

            await test.step('State revoked (API) → after reload the Details show Revoked and the toolbar Revoke is disabled', async () => {
                await waitForCertificateState(api, cert.uuid, 'revoked', 120_000);
                await certPage.goToDetail(cert.uuid);
                await page.reload();
                await certPage.assertState('Revoked');
                await certPage.assertToolbar({ revoke: 'disabled', renew: 'disabled', rekey: 'disabled' });
                expect((await getCertificate(api, cert.uuid)).state).toBe('revoked');
            });

            await test.step('History: "Certificate revoked. Reason: Key compromise"', async () => {
                expect(historyMessages(await historyOf(api, cert.uuid))).toContainEqual(expect.stringContaining(revokedText('Key compromise')));
                await certPage.openDetailTab(cert.uuid, 'History');
                await certPage.assertHistoryTabHasEntry(/Certificate revoked\. Reason: Key compromise/);
            });
        });
});
