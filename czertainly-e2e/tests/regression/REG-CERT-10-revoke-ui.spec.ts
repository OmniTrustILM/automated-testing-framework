/**
 * REG-CERT-10 — revoke from the certificate detail dialog: the dialog offers exactly the nine revocation reasons and
 * Key compromise revokes the certificate (Revoked after reload, the lifecycle actions disabled, the history names the
 * reason). The certificate was issued by this run through the API; `assertOwnLive` runs before the dialog acts.
 */
import { expect, loginAsSmokeUser, test } from '../../fixtures/testFixtures';
import { CertificateDetailPage } from '../../pages/CertificateDetailPage';
import { CertificatePage } from '../../pages/CertificatePage';
import { RevokeDialog } from '../../pages/RevokeDialog';
import { historyMessages, historyOf } from '../../utils/regression/lifecycle/certificateHistory';
import { REVOKE_REASONS, revokedText } from '../../utils/regression/lifecycle/certificateLabels';
import { issueOwnCertificate } from '../../utils/regression/ownCertificates';
import { assertOwnLive } from '../../utils/regression/ledger/ownership';
import { getCertificate } from '../../utils/regression/apiReads';
import { testMeta, tags } from '../../utils/regression/tags';
import { LIFECYCLE_MS } from '../../utils/regression/timeouts';
import { waitForCertificateState } from '../../utils/certificateUtils';

const SPEC = 'REG-CERT-10';

test.describe('Revoke in the web UI', { tag: tags.regression }, () => {
    test('the Revoke dialog offers the nine reasons and Key compromise revokes the certificate',
        testMeta({
            id: 'REG-CERT-10', prio: 'P1', issue: 'ilm#429',
            rule: [
                'the nine CertificateRevocationReason labels; revoke of an ISSUED certificate: 204, completion through the authority',
                'history "Certificate revoked. Reason: Key compromise"; REVOKED is terminal; Revoke is enabled only for Issued',
            ],
        }),
        async ({ page, api, env, ownRaProfile }) => {
            // One API issuance (180 s), the dialog, the revocation (120 s) and the tab checks.
            test.setTimeout(LIFECYCLE_MS);
            const ra = ownRaProfile;
            const cert = await test.step('Issue an own certificate through the API', async () => issueOwnCertificate(api, ra, SPEC, { suffix: 'ui10' }));
            const certPage = new CertificatePage(page);
            const detail = new CertificateDetailPage(page);
            const revoke = new RevokeDialog(page);

            await test.step('Open the detail; the Revoke dialog offers exactly the nine reason labels', async () => {
                await assertOwnLive(api, 'certificates', cert, 'REG-CERT-10 revoke (UI)');
                await loginAsSmokeUser(page, env);
                await certPage.goToDetail(cert.uuid);
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
                await waitForCertificateState(api, cert.uuid, 'revoked', 120_000);
                await certPage.goToDetail(cert.uuid);
                await page.reload();
                await detail.openTab('Details');
                await detail.assertState('Revoked');
                await detail.assertToolbar({ revoke: 'disabled', renew: 'disabled', rekey: 'disabled' });
                expect((await getCertificate(api, cert.uuid)).state).toBe('revoked');
            });

            await test.step('History: "Certificate revoked. Reason: Key compromise"', async () => {
                expect(historyMessages(await historyOf(api, cert.uuid))).toContainEqual(expect.stringContaining(revokedText('Key compromise')));
                await detail.goToDetailTab(cert.uuid, 'History');
                await certPage.assertHistoryTabHasEntry(/Certificate revoked\. Reason: Key compromise/);
            });
        });
});
