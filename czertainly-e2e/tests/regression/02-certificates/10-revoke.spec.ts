/**
 * REG-CERT-10 — Revoke from the certificate detail dialog (release checklist: Certificates 10). ilm#429.
 *
 * WHAT: 1. Detail → Revoke → the dialog offers exactly the nine revocation reasons.
 *       2. Choose Key compromise, submit → 204; the certificate becomes Revoked.
 *       3. After a reload the Details show Revoked and Revoke, Renew and Rekey are disabled.
 *       4. The History tab says "Certificate revoked. Reason: Key compromise".
 * WHY: revocation is terminal and must offer the full reason list; a red test means a reason is missing, the revoke does not
 *      complete through the authority, or the lifecycle actions stay enabled on a revoked certificate.
 * HOW: the certificate is issued by this run through the API (own RA profile) and checked as own with the live ownership check before
 *      the dialog acts; the state is read from the API and from the UI after a reload.
 */
import { expect, test } from '../../../fixtures/regressionFixtures';
import { CertificateDetailPage } from '../../../pages/CertificateDetailPage';
import { CertificatePage } from '../../../pages/CertificatePage';
import { RevokeDialog } from '../../../pages/RevokeDialog';
import { historyMessages, historyOf } from '../../../utils/regression/lifecycle/certificateHistory';
import { REVOKE_REASONS, revokedText } from '../../../utils/regression/lifecycle/certificateLabels';
import { getCertificate } from '../../../utils/regression/apiReads';
import { testMeta, tags } from '../../../utils/regression/tags';
import { LIFECYCLE_MS } from '../../../utils/regression/timeouts';
import { waitRevoked } from '../../../utils/regression/ownCertificates';

test.describe('Revoke in the web UI', { tag: tags.regression }, () => {
    test('the Revoke dialog offers the nine reasons and Key compromise revokes the certificate',
        testMeta({
            id: 'REG-CERT-10', prio: 'P1', issue: 'ilm#429',
            rule: [
                'the nine CertificateRevocationReason labels; revoke of an ISSUED certificate: 204, completion through the authority',
                'history "Certificate revoked. Reason: Key compromise"; REVOKED is terminal; Revoke is enabled only for Issued',
            ],
        }),
        async ({ signedIn: page, api, own, live, ownRaProfile }) => {
            // One API issuance (180 s), the dialog, the revocation (120 s) and the tab checks.
            test.setTimeout(LIFECYCLE_MS);
            const ra = ownRaProfile;
            const cert = await test.step('Issue an own certificate through the API', async () => own.certificate.issue(ra, { suffix: 'ui10' }));
            const certPage = new CertificatePage(page);
            const detail = new CertificateDetailPage(page);
            const revoke = new RevokeDialog(page);

            await test.step('Open the detail; the Revoke dialog offers exactly the nine reason labels', async () => {
                await live('certificates', cert);
                await detail.goToDetail(cert.uuid);
                await detail.assertToolbar({ revoke: 'enabled' });
                await revoke.open();
                await revoke.assertReasons(REVOKE_REASONS.map((r) => r.label));
            });

            await test.step('Choose Key compromise and submit → 204', async () => {
                await revoke.chooseReason('Key compromise');
                expect((await revoke.submit()).status).toBe(204);
                await expect(revoke.dialog).toBeHidden();
            });

            await test.step('State revoked (API) → after reload the Details show Revoked and the toolbar Revoke is disabled', async () => {
                await waitRevoked(api, cert.uuid);
                await detail.openFresh(cert.uuid);
                await detail.assertState('Revoked');
                await detail.assertToolbar({ revoke: 'disabled', renew: 'disabled', rekey: 'disabled' });
                expect((await getCertificate(api, cert.uuid)).state).toBe('revoked');
            });

            await test.step('History: "Certificate revoked. Reason: Key compromise"', async () => {
                expect(historyMessages(await historyOf(api, cert.uuid))).toContainEqual(expect.stringContaining(revokedText('Key compromise')));
                await detail.goToDetail(cert.uuid, { tab: 'History' });
                await certPage.assertHistoryTabHasEntry(/Certificate revoked\. Reason: Key compromise/);
            });
        });
});
