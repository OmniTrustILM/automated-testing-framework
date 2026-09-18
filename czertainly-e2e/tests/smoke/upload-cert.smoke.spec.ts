/**
 *
 * WHAT: SMK-007 test covers certificate upload without issuance + certificate delete (single delete from the Certificate Details page + bulk delete from the list)
 * WHY: this is a separate flow from SMK-004 (we issue a certificate through RA profile there), and here we work with prepared certificates + batch delete in the risk zone (broke often in the past -> need to check for regression)
 * 
 * HOW: test flow:
 *      1. Login → Certificates list
 *      2. Upload 1 cert via UI-modal (UI-path upload validation) (note: we'll be using self-signed certs and generate them via node-forge, so no external fixtures)
 *      3. Upload 2 more certs via API (faster, hermetic)
 *      4. Filter by our unique CN-prefix (don't touch someone else inventory)
 *      5. Single delete via detail page → verify 2 remain
 *      6. Batch delete remaining via list toolbar → verify clean
 *      7. afterEach — API cleanup if test fails ahead of batch delete
 */

import { recordCleanupFailure, statusOf } from '../../utils/cleanupLedger';
import {
test, expect, loginAsSmokeUser, getAuthenticatedApiContext } from '../../fixtures/testFixtures';
import { CertificatePage } from '../../pages/CertificatePage';
import { TablePage } from '../../pages/TablePage';
import { Logger } from '../../utils/Logger';
import {
    generateSelfSignedCert,
    uploadCertificate,
    findCertificateByFingerprint,
    deleteCertificate,
} from '../../utils/certificateUtils';


const logger = new Logger('UploadCertSmokeTest');

test.describe('@smoke upload-cert', () => {
    // Track fingerprints of uploaded certs — for afterEach cleanup
    const uploadedFingerprints: string[] = [];

    test.afterEach(async ({ request, env }) => {
        if (uploadedFingerprints.length === 0) return;

        const api = await getAuthenticatedApiContext(request, env);
        try {
            for (const fingerprint of uploadedFingerprints) {
                try {
                    const found = await findCertificateByFingerprint(api, fingerprint);
                    if (found) {
                        await deleteCertificate(api, found.uuid);
                        logger.info(`Cleaned up leftover cert: ${fingerprint} → ${found.uuid}`);
                    }
                } catch (e) {
                    recordCleanupFailure({ resource: 'certificate', name: fingerprint, status: statusOf(e), message: String(e) });
                    logger.warn(`Cleanup failed for fingerprint ${fingerprint}: ${e}`);
                }
            }
        } finally {
            await api.dispose();
            uploadedFingerprints.length = 0;  // Reset for potential next run
        }
    });

    test('SMK-007: upload certificate and delete (single + batch)', async ({ page, request, env }) => {
        const certPage = new CertificatePage(page);
        const tablePage = new TablePage(page);
        const cnPrefix = `smoke-upload-${Date.now()}`;

        // 1. Generate 3 self-signed certs with unique CN sharing our timestamp prefix
        const cert1 = generateSelfSignedCert(`${cnPrefix}-1.example.com`);
        const cert2 = generateSelfSignedCert(`${cnPrefix}-2.example.com`);
        const cert3 = generateSelfSignedCert(`${cnPrefix}-3.example.com`);

        await loginAsSmokeUser(page, env);

        await test.step('Upload cert #1 via UI modal', async () => {
            await certPage.goToList();
            await certPage.openUploadModal();
            await certPage.pasteCertificatePem(cert1.pem);
            await certPage.submitUpload();
            uploadedFingerprints.push(cert1.fingerprint);
            logger.info(`Uploaded via UI: ${cert1.fingerprint}`);
        });

        await test.step('Upload certs #2 and #3 via API', async () => {
            const api = await getAuthenticatedApiContext(request, env);
            try {
                await uploadCertificate(api, cert2.pem);
                uploadedFingerprints.push(cert2.fingerprint);
                await uploadCertificate(api, cert3.pem);
                uploadedFingerprints.push(cert3.fingerprint);
                logger.info(`Uploaded via API: ${cert2.fingerprint}, ${cert3.fingerprint}`);
            } finally {
                await api.dispose();
            }
        });

        await test.step('Filter list by CN prefix and verify 3 certs visible', async () => {
            await page.reload();  // pick up newly uploaded certs — list doesn't auto-refresh
            await tablePage.applyFilter({
                group: 'Property',
                field: 'Common Name',
                condition: 'contains',
                value: cnPrefix,
            });
            await expect(tablePage.rows).toHaveCount(3, { timeout: 15000 });
        });

        await test.step('Delete cert #1 via detail page → verify 2 remain', async () => {
            // Click first cert's CN link → navigate to detail
            const firstRowLink = tablePage.rows.first().getByRole('link').first();
            await firstRowLink.click();
            await expect(page).toHaveURL(/\/certificates\/detail\//);

            // Delete from detail (trash icon → confirm)
            await certPage.deleteFromDetail();

            await expect(tablePage.rows).toHaveCount(2, { timeout: 10000 });
        });

        await test.step('Batch delete remaining 2 certs → verify all gone', async () => {
            await tablePage.bulkDelete('Certificates');

            // The deletion is asynchronous - the toast says the operation was *initiated* - and the
            // list does not always pick the result up on its own, the same way it does not pick up a
            // newly uploaded certificate. Reloading between attempts is what makes this wait for the
            // platform rather than for the page to refresh itself; a delete that genuinely failed
            // still fails here, because the rows never go away however often the list is re-read.
            await expect(async () => {
                await page.reload();
                await expect(tablePage.rows.filter({ hasText: cnPrefix })).toHaveCount(0, { timeout: 3000 });
            }).toPass({ timeout: 30000 });
        });
    });
});

