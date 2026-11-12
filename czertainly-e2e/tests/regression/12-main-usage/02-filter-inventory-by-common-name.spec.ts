/**
 * REG-USE-02 — The certificate inventory filtered by Common Name (release checklist: Usage 2). ilm#428.
 *
 * WHAT: 1. Upload a self-signed certificate named after the run.
 *       2. Inventory → Property / Common Name / contains <run id> → the badge shows.
 *       3. Every row matches and the row count equals the API search.
 *       4. Open the certificate: Details names it and the Validation, History and Event History tabs load without an error.
 *       5. Back to the list, remove the badge → the filter is gone.
 * WHY: the inventory filter is the everyday way to find a certificate; the badge, the rows and the API must agree.
 * HOW: the certificate is own, uploaded through the API and recorded from the upload answer before anything is asserted; the filter value
 *      is the run id, so only objects of this run match. Nothing else is changed.
 */
import { expect, test } from '../../../fixtures/regressionFixtures';
import { CertificateListPage } from '../../../pages/CertificateListPage';
import { CertificatePage } from '../../../pages/CertificatePage';
import { addInventoryTextFilter, filterBadges, waitForListRows } from '../../../pages/ui/list';
import { findCertificateByFingerprint, generateSelfSignedCert } from '../../../utils/certificateUtils';
import { searchCertificates } from '../../../utils/regression/apiReads';
import { runId, ownName } from '../../../utils/regression/ledger/runState';
import { testMeta, tags } from '../../../utils/regression/tags';
import { INVENTORY_APPEAR_MS } from '../../../utils/regression/timeouts';

test.describe('Certificate inventory filter', { tag: tags.regression }, () => {
    test('a Common Name filter shows only the matching certificates and can be removed again',
        testMeta({
            id: 'REG-USE-02', prio: 'P1', issue: 'ilm#428',
            rule: ['release checklist Usage 2: a Property / Common Name / contains filter shows a badge, every row matches and the count equals the API search'],
        }),
        async ({ signedIn: page, api, own, live }) => {
            const cn = ownName('inventory'); // unique even when a run id is reused
            const certPage = new CertificatePage(page);
            const list = new CertificateListPage(page);

            const uploaded = await test.step('Data: upload a certificate named after the run (API), recorded from the upload answer', async () => {
                const { pem, fingerprint } = generateSelfSignedCert(cn, 30);
                const made = await own.certificate.upload(pem, cn, 'uploaded (self-signed)');
                await expect.poll(async () => (await findCertificateByFingerprint(api, fingerprint))?.uuid ?? '', { timeout: INVENTORY_APPEAR_MS }).toBe(made.uuid);
                return made;
            });

            await test.step('Open the inventory', async () => {
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
                await expect(list.rows.first()).toContainText(runId());
                await expect(list.rows).toHaveCount(Math.min(expected, 10));
                for (const text of await list.rows.allInnerTexts()) expect(text, 'every row shown carries the run id').toContain(runId());
                await expect(await list.rowByCommonName(cn), 'the own certificate is one row of the filtered list').toHaveCount(1);
            });

            await test.step('Open the certificate; its tabs load', async () => {
                await live('certificates', uploaded);
                await certPage.openCertificateFromList(cn);
                await certPage.assertUploadedCertificateDetails(cn);
                await certPage.assertTabsOpenWithoutError(['Validation', 'History', 'Event History']);
            });

            await test.step('Back to the list, remove the badge → the filter is gone', async () => {
                await certPage.goToList();
                const badge = `Property 'Common Name' contains '${runId()}'`;
                // The filter may or may not survive the navigation, and the persisted badge can render a moment after the list: each poll
                // round removes the badge when it is shown, then reads again; the step ends only once a read finds it gone after the list
                // settled.
                await waitForListRows(page);
                await expect.poll(async () => {
                    if ((await filterBadges(page)).includes(badge)) await list.filter.removeBadge(badge);
                    return filterBadges(page);
                }, { message: 'the common-name badge is gone', timeout: 30_000 }).not.toContain(badge);
                await waitForListRows(page);
            });
        });
});
