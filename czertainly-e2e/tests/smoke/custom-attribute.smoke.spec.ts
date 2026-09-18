/**
 * WHAT: SMK-008 - Custom Attribute full lifecycle — create definition → assign value to a certificate → unassign value → re-assign → delete definition
 * UI as a main flow, API for setup/cleanup
 * Cascade verification: custom attribute should be automatically deleted from a cert after we delete the definition
 * WHY: Custom Attributes are widely used by customers for typed metadata on resources (Owner Team, Environment, etc.).
 * We're running regression tests on the main operations — create, assign/unassign, and delete + cascade behavior on definition removal
 * HOW: 
 *  1. Setup: upload one self-signed cert via API (reuse generateSelfSignedCert + uploadCertificate from SMK-007)
 *  2. Create attribute definition via UI (Settings → Custom Attributes → +): name/label + resources=certificates + content type=String
 *  3. Verify definition in Settings list
 *  4. Assign value via UI: cert detail → Attributes tab → select attribute → enter value → Save
 *  5. Verify value shown in Custom Attributes table in cert
 *  6. Unassign value from the cert in UI
 *  7. Verify value was deleted
 *  8. Re-assign the value
 *  9. Delete definition (Settings → search → checkbox → trash → confirm)
 *  10. Verify definition was deleted from the list
 *  11. Verify cascade: the value should be automatically deleted from the cert details 
 *  12. afterEach: best-effort API cleanup — delete cert + delete definition if it still exists
*/

import { recordCleanupFailure, statusOf } from '../../utils/cleanupLedger';
import { test, expect, loginAsSmokeUser, getAuthenticatedApiContext } from '../../fixtures/testFixtures';
import { CertificatePage } from '../../pages/CertificatePage';
import { TablePage } from '../../pages/TablePage';
import { CustomAttributesPage } from '../../pages/CustomAttributesPage';
import {
    generateSelfSignedCert,
    uploadCertificate,
    findCertificateByFingerprint,
    deleteCertificate,
} from '../../utils/certificateUtils';
import {
    findCustomAttributeByName,
    deleteCustomAttribute,
} from '../../utils/customAttributeUtils';
import { Logger } from '../../utils/Logger';

const logger = new Logger('CustomAttributeSmokeTest');

test.describe('@smoke custom-attribute', () => {
    // Track for cleanup
    let uploadedFingerprint: string | undefined;
    let createdAttributeName: string | undefined;

    test.afterEach(async ({ request, env }) => {
        const api = await getAuthenticatedApiContext(request, env);
        try {
            // Cleanup cert
            if (uploadedFingerprint) {
                try {
                    const found = await findCertificateByFingerprint(api, uploadedFingerprint);
                    if (found) {
                        await deleteCertificate(api, found.uuid);
                        logger.info(`Cleaned up leftover cert: ${uploadedFingerprint}`);
                    }
                } catch (e) {
                    recordCleanupFailure({ resource: 'certificate', name: uploadedFingerprint, status: statusOf(e), message: String(e) });
                    logger.warn(`Cert cleanup failed for ${uploadedFingerprint}: ${e}`);
                }
            }

            // Cleanup custom attribute definition
            if (createdAttributeName) {
                try {
                    const found = await findCustomAttributeByName(api, createdAttributeName);
                    if (found) {
                        await deleteCustomAttribute(api, found.uuid);
                        logger.info(`Cleaned up leftover custom attribute: ${createdAttributeName}`);
                    }
                } catch (e) {
                    recordCleanupFailure({ resource: 'customAttribute', name: createdAttributeName, status: statusOf(e), message: String(e) });
                    logger.warn(`Custom attribute cleanup failed for ${createdAttributeName}: ${e}`);
                }
            }
        } finally {
            await api.dispose();
            // Reset for potential re-run
            uploadedFingerprint = undefined;
            createdAttributeName = undefined;
        }
    });

    test('SMK-008: Custom Attribute lifecycle (create → assign → unassign → re-assign → delete)', async ({ page, request, env }) => {
        const cn = `smoke-ca-${Date.now()}.example.com`;
        const attrName = `smoke-attr-${Date.now()}`;
        const attrLabel = attrName;  // keep same for simplicity
        const attrValue = 'test-value-from-smoke';

        const certPage = new CertificatePage(page);
        const tablePage = new TablePage(page);
        const customAttrsPage = new CustomAttributesPage(page);

        await test.step('Setup: upload cert via API', async () => {
            const { pem, fingerprint } = generateSelfSignedCert(cn);
            const api = await getAuthenticatedApiContext(request, env);
            try {
                await uploadCertificate(api, pem);
                uploadedFingerprint = fingerprint;
                logger.info(`Uploaded cert: ${fingerprint}`);
            } finally {
                await api.dispose();
            }
        });

        await loginAsSmokeUser(page, env);

        await test.step('Create Custom Attribute definition via UI', async () => {
            await customAttrsPage.goToList();
            await customAttrsPage.openCreateModal();
            await customAttrsPage.fillAndSubmitCreate({
                name: attrName,
                label: attrLabel,
                resource: 'Certificate',
                contentType: 'String',
            });
            createdAttributeName = attrName;
            logger.info(`Created custom attribute: ${attrName}`);
        });

        let certDetailUuid = '';

        await test.step('Navigate to cert detail and open Attributes tab', async () => {
            await certPage.goToList();
            await tablePage.applyFilter({
                group: 'Property',
                field: 'Common Name',
                condition: 'contains',
                value: cn,
            });
            const firstRowLink = tablePage.rows.first().getByRole('link').first();
            await firstRowLink.click();
            await expect(page).toHaveURL(/\/certificates\/detail\//);
            certDetailUuid = new URL(page.url()).hash.split('/').pop() ?? '';
            expect(certDetailUuid, 'the detail URL carries the certificate uuid').not.toBe('');
            await certPage.openTab('Attributes');
        });

        await test.step('Assign custom attribute value to cert', async () => {
            await certPage.assignCustomAttributeValue(attrName, attrValue);
            // Verify value shown in Custom Attributes table
            const row = certPage.main.locator('tr').filter({ hasText: attrName });
            await expect(row).toContainText(attrValue);
        });

        await test.step('Unassign value from cert', async () => {
            await certPage.unassignCustomAttributeValue(attrName);
            // Method already asserts row gone; leaving here for explicit test intent
        });

        await test.step('Re-assign value to cert', async () => {
            await certPage.assignCustomAttributeValue(attrName, attrValue);
            const row = certPage.main.locator('tr').filter({ hasText: attrName });
            await expect(row).toContainText(attrValue);
        });

        await test.step('Delete Custom Attribute definition via UI', async () => {
            await customAttrsPage.goToList();
            await customAttrsPage.deleteByName(attrName);
            // Verify definition removed — no row with our attribute name visible
            await expect(customAttrsPage.main.locator('tr').filter({ hasText: attrName })).not.toBeVisible();
        });

        await test.step('Verify cascade: value gone from cert Attributes tab', async () => {
            // Straight to the certificate whose detail page this test already opened. Going back
            // through the list would re-apply a filter that is still there from the first visit,
            // which the platform rejects with "a filter with the same name and condition already
            // exists" - an error the test used to provoke on every run and never look at. The
            // filter itself is exercised above; getting here a second time is only transport.
            await certPage.goToDetail(certDetailUuid);
            await certPage.openTab('Attributes');
            const row = certPage.main.locator('tr').filter({ hasText: attrName });
            await expect(row).not.toBeVisible();
        });
    });
});
