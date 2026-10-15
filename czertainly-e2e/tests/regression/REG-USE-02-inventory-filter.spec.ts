/**
 * REG-USE-02 — See and filter certificates in the inventory (release checklist: Usage 2).
 *
 * Flow: upload one certificate named after the run (API; recorded in the ledger from the upload answer, before any
 * poll or assertion, review Q14) → Certificates list → filter
 * Property / Common Name / contains <run id> → a badge shows the filter, every row matches and the count equals
 * the API search → open the certificate → its tabs load → remove the badge → the full list is back.
 */
import { expect, loginAsSmokeUser, test } from '../../fixtures/testFixtures';
import { CertificatePage } from '../../pages/CertificatePage';
import { addInventoryTextFilter, filterBadges, waitForListRows } from '../../pages/RegressionUi';
import { findCertificateByFingerprint, generateSelfSignedCert } from '../../utils/certificateUtils';
import { searchCertificates, uploadOwnCertificate } from '../../utils/regression/regressionApi';
import { regName, RUN_ID } from '../../utils/regression/regressionRun';

const SPEC = 'REG-USE-02';

test.describe('@regression REG-USE-02 inventory and filters', () => {
    test('filter by Common Name, open the match, clear the filter', async ({ page, api, env }) => {
        const cn = regName(`inventory-${Date.now().toString(36)}`); // unique even when a run id is reused
        const certPage = new CertificatePage(page);

        await test.step('Data: upload a certificate named after the run (API), recorded from the upload answer', async () => {
            const { pem, fingerprint } = generateSelfSignedCert(cn, 30);
            const own = await uploadOwnCertificate(api, pem, cn, SPEC, 'uploaded (self-signed)');
            await expect.poll(async () => (await findCertificateByFingerprint(api, fingerprint))?.uuid ?? '', { timeout: 30_000 }).toBe(own.uuid);
        });

        await test.step('Open the inventory', async () => {
            await loginAsSmokeUser(page, env);
            await certPage.goToList();
            await waitForListRows(page);
        });

        const expected = await test.step(`Filter: Property / Common Name / contains ${RUN_ID}`, async () => {
            await addInventoryTextFilter(page, 'Common Name', 'contains', RUN_ID);
            await expect.poll(() => filterBadges(page)).toContain(`Property 'Common Name' contains '${RUN_ID}'`);
            const viaApi = await searchCertificates(api, [{ fieldSource: 'property', fieldIdentifier: 'COMMON_NAME', condition: 'CONTAINS', value: RUN_ID }], 100);
            expect(viaApi.length).toBeGreaterThan(0);
            return viaApi.length;
        });

        await test.step('Every row matches; the row count equals the API search', async () => {
            const rows = page.locator('main table tbody tr');
            await expect(rows.first()).toContainText(RUN_ID);
            await expect(rows).toHaveCount(Math.min(expected, 10));
            for (const text of await rows.allInnerTexts()) expect(text).toContain(RUN_ID);
            await expect(page.locator('main').getByRole('link', { name: cn, exact: true })).toBeVisible();
        });

        await test.step('Open the certificate; its tabs load', async () => {
            await certPage.openCertificateFromList(cn);
            await certPage.openTab('Details');
            await expect(page.locator('main tr[data-id="commonName"]')).toContainText(cn);
            await certPage.verifyOtherTabsOpenWithoutError(['Validation', 'History', 'Event History']);
        });

        await test.step('Back to the list, remove the badge → the filter is gone', async () => {
            await certPage.goToList();
            const badge = page.locator('main').getByRole('button', { name: /Remove badge$/ }).first();
            if (await badge.isVisible().catch(() => false)) {
                await badge.getByRole('button', { name: 'Remove badge' }).click();
            }
            await expect.poll(() => filterBadges(page)).not.toContain(`Property 'Common Name' contains '${RUN_ID}'`);
            await waitForListRows(page);
        });
    });
});
