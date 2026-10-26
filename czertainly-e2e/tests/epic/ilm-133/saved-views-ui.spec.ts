/**
 * Epic ilm#133 (custom columns) — saved views on the Certificate Inventory through the UI:
 * S1-S7, S9, S10, S11.
 *
 * WHAT: a user saves a column set as a view, switches between a view and Standard, duplicates,
 * renames, marks as default and deletes views, and sees the default view open on load.
 *
 * WHY: the view strip is the user-facing half of the saved-view feature: the stored columns,
 * filter and ordering have to come back exactly when a tab is selected, and Standard must stay
 * the fixed platform fallback that cannot be renamed or deleted.
 *
 * S7, S9 and S10 change which view the user's inventory opens on, which is shared state of the
 * test user, so they are tagged @exclusive and run in the nightly window.
 *
 * HOW: every test builds its view through the UI under a unique prefix (a column added, so the
 * stored set differs from Standard) and afterEach deletes, through the list-view API, every view
 * of the user's certificate inventory whose name starts with that prefix - copies included. What
 * will not go is recorded in the cleanup ledger. Each test opens the inventory on Standard
 * explicitly, because a default view of the user would otherwise open first.
 */

import { test, expect, loginAsSmokeUser, getAuthenticatedApiContext } from '../../../fixtures/testFixtures';
import { CertificateViewsPage } from '../../../pages/CertificateViewsPage';
import * as listViewUtils from '../../../utils/listViewUtils';
import { attemptCleanup } from '../../../utils/cleanupLedger';
import { uniqueName } from '../../../utils/names';

/** A column Standard does not show, and a Standard column to take off, so a stored set differs from Standard. */
const ADDED_COLUMN = 'Fingerprint';
const REMOVED_COLUMN = 'Archived';

test.describe('@epic-133 saved views UI', () => {
    let prefix: string;

    test.beforeEach(async ({ page, env }) => {
        prefix = uniqueName('atf-ui');
        await loginAsSmokeUser(page, env);
    });

    test.afterEach(async ({ request, env }) => {
        const api = await getAuthenticatedApiContext(request, env);
        try {
            let views: listViewUtils.ListViewDto[] = [];
            await attemptCleanup({ resource: 'listView', name: `views ${prefix}*` },
                async () => { views = await listViewUtils.listViews(api, 'certificates'); });
            for (const view of views.filter((v) => v.name.startsWith(prefix))) {
                await attemptCleanup({ resource: 'listView', uuid: view.uuid, name: view.name },
                    () => listViewUtils.deleteView(api, view.uuid));
            }
        } finally {
            await api.dispose();
        }
    });

    /** Standard with one column added and one taken off, saved as a view; returns its name. */
    async function createColumnView(views: CertificateViewsPage, suffix = 'v'): Promise<string> {
        const name = `${prefix}-${suffix}`;
        await views.openOnStandard();
        await views.setColumn(ADDED_COLUMN, true);
        await views.setColumn(REMOVED_COLUMN, false);
        await views.saveAsNewView(name);
        return name;
    }

    test('S1: a column set saved as a view opens as the active tab with its columns', { tag: ['@epic-133', '@regression'] }, async ({ page }) => {
        const views = new CertificateViewsPage(page);
        const name = await createColumnView(views);

        await expect(views.tab(name)).toHaveAttribute('aria-selected', 'true');
        await expect(views.columnHeader(ADDED_COLUMN)).toHaveCount(1);
        await expect(views.columnHeader(REMOVED_COLUMN)).toHaveCount(0);
    });

    test('S2: switching from a view to Standard brings back the platform column set', { tag: ['@epic-133'] }, async ({ page }) => {
        const views = new CertificateViewsPage(page);
        const name = await createColumnView(views);

        await views.selectTab('Standard');

        await expect(views.columnHeader(ADDED_COLUMN)).toHaveCount(0);
        await expect(views.columnHeader(REMOVED_COLUMN)).toHaveCount(1);
        await views.expectStandardColumns();
        await expect(views.tab(name)).toHaveAttribute('aria-selected', 'false');
    });

    test('S3: a view applies its columns, filter and ordering together', { tag: ['@epic-133', '@regression'] }, async ({ page }) => {
        const views = new CertificateViewsPage(page);
        const name = `${prefix}-v`;
        const filterValue = `${prefix}-no-such-name`;

        await views.openOnStandard();
        await views.setColumn(ADDED_COLUMN, true);
        await views.addFilter('Common Name', 'equals', filterValue);
        await views.sortBy('Serial number');
        await views.saveAsNewView(name);

        await views.selectTab('Standard');
        await expect(views.filterBadge(filterValue)).toHaveCount(0);
        await expect(views.columnHeader(ADDED_COLUMN)).toHaveCount(0);
        await expect(views.columnHeader('Serial number')).not.toHaveAttribute('aria-sort', 'ascending');

        await views.selectTab(name);
        await expect(views.columnHeader(ADDED_COLUMN)).toHaveCount(1);
        await expect(views.filterBadge(`'Common Name' equals '${filterValue}'`)).toBeVisible();
        await expect(views.columnHeader('Serial number')).toHaveAttribute('aria-sort', 'ascending');
        // The stored filter really narrows the list: nothing is named like that.
        await expect(page.getByText('No items to show')).toBeVisible();
    });

    test('S4: a duplicate is named "<name> (copy)" and editing it leaves the original as it was', { tag: ['@epic-133'] }, async ({ page }) => {
        const views = new CertificateViewsPage(page);
        const name = await createColumnView(views);

        await views.duplicate(name);
        const copy = `${name} (copy)`;
        await expect(views.tab(copy)).toHaveAttribute('aria-selected', 'true');

        await views.setColumn(ADDED_COLUMN, false);
        await views.saveToActiveView();

        await views.selectTab(name);
        await expect(views.columnHeader(ADDED_COLUMN)).toHaveCount(1);
        await views.selectTab(copy);
        await expect(views.columnHeader(ADDED_COLUMN)).toHaveCount(0);
    });

    test('S5: a renamed view changes its tab label and still loads its columns', { tag: ['@epic-133'] }, async ({ page }) => {
        const views = new CertificateViewsPage(page);
        const name = await createColumnView(views);
        const renamed = `${prefix}-renamed`;

        await views.rename(name, renamed);

        await expect(views.tab(name)).toHaveCount(0);
        await views.selectTab('Standard');
        await views.selectTab(renamed);
        await expect(views.columnHeader(ADDED_COLUMN)).toHaveCount(1);
        await expect(views.columnHeader(REMOVED_COLUMN)).toHaveCount(0);
    });

    test('S6: deleting the active view removes its tab and the table falls back to Standard', { tag: ['@epic-133', '@regression'] }, async ({ page }) => {
        const views = new CertificateViewsPage(page);
        const name = await createColumnView(views);

        await views.deleteActive(name);

        await expect(views.tab('Standard')).toHaveAttribute('aria-selected', 'true');
        await expect(views.columnHeader(ADDED_COLUMN)).toHaveCount(0);
        await views.expectStandardColumns();
    });

    // Marks a default: the user's default view is shared with every other test of that user.
    test('S7: a view marked as default is shown as default', { tag: ['@epic-133', '@exclusive'] }, async ({ page }) => {
        const views = new CertificateViewsPage(page);
        const name = await createColumnView(views);

        await expect(views.pin(name)).toHaveCount(0);
        await views.setDefault(name, true);

        await expect(views.pin(name)).toBeVisible();
        // The pin moves off Standard, which carried it while no view was the default.
        await expect(views.pin('Standard')).toHaveCount(0);
        await views.openActions(name);
        await expect(views.menuItem('Stop opening this view by default')).toBeVisible();
    });

    // Marks a default: the user's default view is shared with every other test of that user.
    test('S9: the default view is the active tab after a reload', { tag: ['@epic-133', '@regression', '@exclusive'] }, async ({ page }) => {
        const views = new CertificateViewsPage(page);
        const name = await createColumnView(views);
        await views.setDefault(name, true);

        await views.reload();

        await expect(views.tab(name)).toHaveAttribute('aria-selected', 'true');
        await expect(views.columnHeader(ADDED_COLUMN)).toHaveCount(1);
    });

    // Clears a default: the user's default view is shared with every other test of that user.
    test('S10: without a default view, Standard is the active tab after a reload', { tag: ['@epic-133', '@exclusive'] }, async ({ page }) => {
        const views = new CertificateViewsPage(page);
        const name = await createColumnView(views);
        await views.setDefault(name, true);
        await views.setDefault(name, false);

        await views.reload();

        await expect(views.tab('Standard')).toHaveAttribute('aria-selected', 'true');
        await expect(views.tab(name)).toHaveAttribute('aria-selected', 'false');
        await expect(views.pin('Standard')).toBeVisible();
    });

    test('S11: the Standard tab offers no rename and no delete', { tag: ['@epic-133'] }, async ({ page }) => {
        const views = new CertificateViewsPage(page);
        await views.openOnStandard();

        await views.openActions('Standard');

        await expect(views.menuItem('Duplicate')).toBeVisible();
        await expect(views.menuItem('Rename…')).toHaveCount(0);
        await expect(views.menuItem('Delete view')).toHaveCount(0);
    });
});
