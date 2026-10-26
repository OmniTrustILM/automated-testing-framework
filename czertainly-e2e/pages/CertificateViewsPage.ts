/**
 * CertificateViewsPage — Page Object for the saved-view strip of the Certificate Inventory.
 *
 * WHAT: opens the inventory on its Standard tab, edits the table (columns, a filter, a sort),
 * saves the table as a view, and drives a view's actions: duplicate, rename, open by default,
 * delete. Reads back the tabs, which one is active, the column headers and the filter badges.
 *
 * WHY: the ilm#133 UI scenarios (S1-S7, S9-S11) all go through the same strip and the same
 * table; the order of the steps and the quirks of the controls live here rather than in the tests.
 *
 * HOW: test ids as the FE renders them (`view-tabs-*`, `add-column-menu-trigger`, `select-*`).
 * A tab's accessible name carries a "Opens by default" prefix when it is the default view and a
 * "(unsaved changes)" suffix when the table has drifted from it, so tabs are found by a pattern
 * that allows both. Text inputs are clicked before fill and selects are driven through their
 * `-trigger` button (see knowledge/automation/fe-playwright-patterns.md). The inventory is opened
 * by URL and Standard is selected explicitly, because another view may be the default.
 */

import { Page, Locator, expect } from '@playwright/test';
import { Logger } from '../utils/Logger';

const logger = new Logger('CertificateViewsPage');

const STANDARD_COLUMN_COUNT = 16;

function escapeRegExp(text: string): string {
    return text.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

export class CertificateViewsPage {
    readonly page: Page;
    readonly main: Locator;
    readonly dialog: Locator;
    readonly summary: Locator;

    constructor(page: Page) {
        this.page = page;
        this.main = page.locator('main');
        this.dialog = page.getByRole('dialog');
        this.summary = page.getByTestId('view-tabs-summary');
    }

    /** The tab of a view by its name, whatever its pin or unsaved marker. Standard is `tab('Standard')`. */
    tab(name: string): Locator {
        const pattern = new RegExp(`^(Opens by default )?${escapeRegExp(name)}( \\(unsaved changes\\))?$`);
        return this.page.getByRole('tablist', { name: 'Saved views' }).getByRole('tab', { name: pattern });
    }

    /** A column header by its label. Standard and a stored view spell some labels differently ("Serial number" / "Serial Number"), so case is ignored. */
    columnHeader(label: string): Locator {
        return this.main.getByRole('columnheader', { name: new RegExp(`^${escapeRegExp(label)}$`, 'i') });
    }

    pin(tabName: string): Locator {
        return this.tab(tabName).getByRole('img', { name: 'Opens by default' });
    }

    filterBadge(text: string): Locator {
        return this.main.getByRole('button', { name: new RegExp(`${escapeRegExp(text)}.*Remove badge`) });
    }

    /** Opens the inventory and waits for the strip; the view the page opens on is left as it is. */
    async goToInventory(): Promise<void> {
        await this.page.goto('/administrator/#/certificates');
        await expect(this.page.getByTestId('view-tabs-tab-standard')).toBeVisible();
    }

    /** Opens the inventory on Standard, whatever the user's default view is. */
    async openOnStandard(): Promise<void> {
        await this.goToInventory();
        await this.selectTab('Standard');
    }

    async reload(): Promise<void> {
        await this.page.reload();
        await expect(this.page.getByTestId('view-tabs-tab-standard')).toBeVisible();
    }

    async selectTab(name: string): Promise<void> {
        await this.tab(name).click();
        await expect(this.tab(name)).toHaveAttribute('aria-selected', 'true');
    }

    /** Ticks or unticks a column of the Property group in the Add column menu. */
    async setColumn(label: string, shown: boolean): Promise<void> {
        await this.page.getByTestId('add-column-menu-trigger').click();
        const box = this.page.getByRole('checkbox', { name: `${label} Property` });
        if (shown) await box.check();
        else await box.uncheck();
        await this.page.keyboard.press('Escape');
        await expect(this.columnHeader(label)).toHaveCount(shown ? 1 : 0);
    }

    /** Adds a filter on a Property field with a text condition, e.g. ('Common Name', 'equals', 'x'). */
    async addFilter(field: string, condition: string, value: string): Promise<void> {
        await this.page.getByTestId('select-group-trigger').click();
        await this.page.getByRole('option', { name: 'Property', exact: true }).click();
        await this.page.getByTestId('select-field-trigger').click();
        await this.page.getByRole('option', { name: field, exact: true }).click();
        await this.page.getByTestId('select-conditions-trigger').click();
        await this.page.getByRole('option', { name: condition, exact: true }).click();
        const input = this.page.getByRole('textbox', { name: 'Filter Value' });
        await input.click();
        await input.fill(value);
        await this.page.getByRole('button', { name: 'Add', exact: true }).click();
        await expect(this.filterBadge(`'${field}' ${condition} '${value}'`)).toBeVisible();
    }

    /** Sorts ascending by a column: one click on its title. */
    async sortBy(column: string): Promise<void> {
        await this.columnHeader(column).getByRole('button', { name: column, exact: true }).click();
        await expect(this.columnHeader(column)).toHaveAttribute('aria-sort', 'ascending');
    }

    /** Saves the table as a new view from Standard ("Save as view…") and waits for its tab to be the active one. */
    async saveAsNewView(name: string): Promise<void> {
        logger.info(`Saving the table as view ${name}`);
        await this.page.getByTestId('view-tabs-summary-save').click();
        await this.nameDialog(name, 'view-tabs-create-input');
        await expect(this.tab(name)).toHaveAttribute('aria-selected', 'true');
    }

    /** Writes the table's changes into the active stored view ("Save to view") and waits for the platform to accept them. */
    async saveToActiveView(): Promise<void> {
        const saved = this.page.waitForResponse((resp) =>
            resp.request().method() === 'PUT' && resp.url().includes('/api/v1/listViews/'));
        await this.page.getByTestId('view-tabs-summary-save').click();
        expect((await saved).ok()).toBe(true);
    }

    async openActions(tabName: string): Promise<void> {
        await this.page.getByRole('button', { name: `Actions for ${tabName}`, exact: true }).click();
    }

    menuItem(title: string): Locator {
        return this.page.getByRole('menuitem', { name: title, exact: true });
    }

    /** Duplicates the active view; the copy becomes the active tab. */
    async duplicate(tabName: string): Promise<void> {
        await this.openActions(tabName);
        await this.menuItem('Duplicate').click();
        await expect(this.tab(`${tabName} (copy)`)).toBeVisible();
    }

    async rename(tabName: string, newName: string): Promise<void> {
        await this.openActions(tabName);
        await this.menuItem('Rename…').click();
        await this.nameDialog(newName, 'view-tabs-rename-input');
        await expect(this.tab(newName)).toBeVisible();
    }

    async setDefault(tabName: string, isDefault: boolean): Promise<void> {
        await this.openActions(tabName);
        await this.menuItem(isDefault ? 'Open this view by default' : 'Stop opening this view by default').click();
        await expect(this.pin(tabName)).toHaveCount(isDefault ? 1 : 0);
    }

    /** Deletes the view whose tab is active and confirms the dialog. */
    async deleteActive(tabName: string): Promise<void> {
        await this.openActions(tabName);
        await this.menuItem('Delete view').click();
        await this.dialog.getByRole('button', { name: 'Delete', exact: true }).click();
        await expect(this.tab(tabName)).toHaveCount(0);
    }

    async expectStandardColumns(): Promise<void> {
        await expect(this.page.getByTestId('view-tabs-summary-columns')).toHaveText(`${STANDARD_COLUMN_COUNT} columns`);
    }

    /** The name field of the create and rename dialogs is readonly until focused: click, fill, confirm. */
    private async nameDialog(name: string, inputTestId: string): Promise<void> {
        const input = this.dialog.getByTestId(inputTestId);
        await input.click();
        await input.fill(name);
        await this.dialog.getByRole('button').last().click();
        await expect(this.dialog).toBeHidden();
    }
}
