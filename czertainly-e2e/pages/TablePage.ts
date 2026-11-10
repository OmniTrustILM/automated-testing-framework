/**
 * TablePage — the smoke suite's generic list table (SMK-003, 007, 008).
 * `bulkDelete` refuses a page that shows anything but the expected rows, so a wrong filter never deletes a foreign object.
 */
import { Page, Locator, expect } from '@playwright/test';
import { Logger } from '../utils/Logger';
import { PageHeader } from './ui/pageHeader';
import { chooseOption } from './ui/select';

const logger = new Logger('TablePage');

export class TablePage {
    readonly page: Page;
    readonly table: Locator;
    readonly rows: Locator;
    readonly selectAllCheckbox: Locator;
    /** Delete: the page header's menu entry (fe-administrator#2426), else the trash button of the list toolbar. */
    readonly header: PageHeader;
    readonly deleteButton: Locator;
    readonly confirmModal: Locator;
    readonly confirmDeleteButton: Locator;

    // Filter row controls — appear on every list page (Connectors, Keys, Certificates, …).
    readonly filterGroupTrigger: Locator;
    readonly filterFieldTrigger: Locator;
    readonly filterConditionsTrigger: Locator;
    readonly filterValueInput: Locator;
    readonly addFilterButton: Locator;

    constructor(page: Page) {
        this.page = page;
        this.table = page.locator('table');
        this.rows = this.table.locator('tbody tr');
        this.selectAllCheckbox = this.table.locator('thead input[type="checkbox"]').first();
        this.header = new PageHeader(page);
        const trashButton = page.locator('button').filter({ has: page.locator('svg.lucide-trash-2') }).first();
        this.deleteButton = this.header.action('delete', trashButton);
        this.confirmModal = page.locator('div[role="dialog"]');
        this.confirmDeleteButton = this.confirmModal.locator('button').filter({ hasText: /delete|confirm|yes/i }).first();

        const main = page.locator('main');
        this.filterGroupTrigger = main.getByTestId('select-group-trigger');
        this.filterFieldTrigger = main.getByTestId('select-field-trigger');
        this.filterConditionsTrigger = main.getByTestId('select-conditions-trigger');
        this.filterValueInput = main.getByTestId('text-input-valueSelect');
        this.addFilterButton = main.locator('#addFilter');
    }

    async visit(url: string) {
        await this.page.goto(url);
        await expect(this.page.locator('main')).toBeVisible();
    }

    async hasData(): Promise<boolean> {
        try {
            await expect(this.table).toBeVisible({ timeout: 10000 });
        } catch {
            return false;
        }

        await this.page.waitForTimeout(2000);

        const count = await this.rows.count();
        if (count === 0) return false;

        const firstRowText = await this.rows.first().textContent();
        if (firstRowText?.includes('No data')) return false;

        return true;
    }

    /** The filter dropdowns are gated in sequence; the Value input is readonly until clicked. */
    async applyFilter(opts: { group: string; field: string; condition: string; value: string }): Promise<void> {
        await chooseOption(this.page, this.filterGroupTrigger, opts.group);
        await chooseOption(this.page, this.filterFieldTrigger, opts.field);
        await chooseOption(this.page, this.filterConditionsTrigger, opts.condition);

        await this.filterValueInput.click();  // focus first — FE removes readonly on focus
        await this.filterValueInput.fill(opts.value);
        await this.addFilterButton.click();
    }

    /** "Select all" takes whatever the page shows, so this throws before ticking unless the rows match `expected`. */
    async bulkDelete(logName: string, expected: { rows: number; eachRowContains: string }) {
        logger.info(`Attempting bulk delete for ${logName}: ${expected.rows} row(s) containing "${expected.eachRowContains}"`);

        await expect(this.rows, `${logName}: the page must show exactly the rows to delete`).toHaveCount(expected.rows);
        const foreign = await this.rows.filter({ hasNotText: expected.eachRowContains }).count();
        if (foreign > 0) {
            throw new Error(`${logName}: ${foreign} row(s) on the page do not contain "${expected.eachRowContains}"; refusing to select all`);
        }

        await this.selectAllCheckbox.check();
        logger.info(`Selected all items for ${logName}`);

        await this.header.click(this.deleteButton);
        logger.info(`Clicked delete button for ${logName}`);

        await expect(this.confirmModal).toBeVisible();
        await this.confirmDeleteButton.click();

        await expect(this.confirmModal).not.toBeVisible();
        logger.info(`Confirmed deletion for ${logName}`);
    }
}
