/**
 * REG-USE-02 — the certificate inventory filtered by Common Name (release checklist: Usage 2): one certificate named
 * after the run is uploaded (recorded from the upload answer), the filter badge shows, every row matches and the count
 * equals the API search; the certificate's tabs load, and removing the badge clears the filter.
 */
import { expect, loginAsSmokeUser, test } from '../../fixtures/testFixtures';
import { CertificatePage } from '../../pages/CertificatePage';
import { addInventoryTextFilter, filterBadges, waitForListRows } from '../../pages/ui/list';
import { findCertificateByFingerprint, generateSelfSignedCert } from '../../utils/certificateUtils';
import { searchCertificates } from '../../utils/regression/apiReads';
import { uploadOwnCertificate } from '../../utils/regression/ownCertificates';
import { runName, runId } from '../../utils/regression/ledger/runState';
import { testMeta, tags } from '../../utils/regression/tags';

const SPEC = 'REG-USE-02';

test.describe('Certificate inventory filter', { tag: tags.regression }, () => {
    test('a Common Name filter shows only the matching certificates and can be removed again',
        testMeta({
            id: 'REG-USE-02', prio: 'P1', issue: 'ilm#428',
            rule: ['release checklist Usage 2: a Property / Common Name / contains filter shows a badge, every row matches and the count equals the API search'],
        }),
        async ({ page, api, env }) => {
            const cn = runName(`inventory-${Date.now().toString(36)}`); // unique even when a run id is reused
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

            const expected = await test.step(`Filter: Property / Common Name / contains ${runId()}`, async () => {
                await addInventoryTextFilter(page, 'Common Name', 'contains', runId());
                await expect.poll(() => filterBadges(page)).toContain(`Property 'Common Name' contains '${runId()}'`);
                const viaApi = await searchCertificates(api, [{ fieldSource: 'property', fieldIdentifier: 'COMMON_NAME', condition: 'CONTAINS', value: runId() }], 100);
                expect(viaApi.length).toBeGreaterThan(0);
                return viaApi.length;
            });

            await test.step('Every row matches; the row count equals the API search', async () => {
                const rows = page.locator('main table tbody tr');
                await expect(rows.first()).toContainText(runId());
                await expect(rows).toHaveCount(Math.min(expected, 10));
                for (const text of await rows.allInnerTexts()) expect(text).toContain(runId());
                await expect(page.locator('main').getByRole('link', { name: cn, exact: true })).toBeVisible();
            });

            await test.step('Open the certificate; its tabs load', async () => {
                await certPage.openCertificateFromList(cn);
                await certPage.openTab('Details');
                await expect(page.locator('main tr[data-id="commonName"]')).toContainText(cn);
                await certPage.assertTabsOpenWithoutError(['Validation', 'History', 'Event History']);
            });

            await test.step('Back to the list, remove the badge → the filter is gone', async () => {
                await certPage.goToList();
                const badge = page.locator('main').getByRole('button', { name: /Remove badge$/ }).first();
                if (await badge.isVisible()) {
                    await badge.getByRole('button', { name: 'Remove badge' }).click();
                }
                await expect.poll(() => filterBadges(page)).not.toContain(`Property 'Common Name' contains '${runId()}'`);
                await waitForListRows(page);
            });
        });
});
