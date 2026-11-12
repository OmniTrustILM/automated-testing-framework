/**
 * TablePage — the smoke suite's generic list table.
 *
 * WHAT: the generic list table of the admin UI: the filter row (field, condition, value, Add), the rows, select-all and the
 *       bulk delete with its confirmation.
 * WHY: SMK-003 / 007 / 008 filter a list by the run's name and SMK-007 bulk-deletes its own rows; `bulkDelete` refuses a page
 *      that shows anything but the expected rows (atf#99), so a wrong filter can never delete a foreign object. The smoke suite
 *      calls these methods by name: they keep their names and their behaviour.
 * HOW: filter selects go through the Select helper; the delete button is found by its icon (it should be the toolbar test id: FE
 *      test-id request); never used by the regression suite, which has its own list widgets.
 */
import { Page, Locator, expect } from '@playwright/test';
import { Logger } from '../utils/Logger';
import { chooseOption } from './ui/select';

const logger = new Logger('TablePage');

export class TablePage {
    readonly page: Page;
    readonly table: Locator;
    readonly rows: Locator;
    readonly selectAllCheckbox: Locator;
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
        this.deleteButton = page.locator('button').filter({ has: page.locator('svg.lucide-trash-2') }).first();
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

    /**
     * Apply a Filter row (Group → Field → Condition → Value) to surface a row
     * in a large/paginated list. Filter dropdowns are sequentially gated — each
     * becomes enabled only after the previous is set. The Value input is readonly
     * until clicked, so we click before fill.
     */
    async applyFilter(opts: { group: string; field: string; condition: string; value: string }): Promise<void> {
        await chooseOption(this.page, this.filterGroupTrigger, opts.group);
        await chooseOption(this.page, this.filterFieldTrigger, opts.field);
        await chooseOption(this.page, this.filterConditionsTrigger, opts.condition);

        await this.filterValueInput.click();  // focus first — FE removes readonly on focus
        await this.filterValueInput.fill(opts.value);
        await this.addFilterButton.click();
    }

    /**
     * Deletes every row on the current page through "select all".
     *
     * "Select all" takes whatever the page shows, so the caller has to say what it expects to
     * delete: the exact number of rows, and text that each of them must contain (the test's own
     * name prefix, say). If the page shows anything else, this throws before ticking the box and
     * nothing is deleted. A cleanup that forgot to filter used to remove other tests' objects this
     * way (atf#99).
     */
    async bulkDelete(logName: string, expected: { rows: number; eachRowContains: string }) {
        logger.info(`Attempting bulk delete for ${logName}: ${expected.rows} row(s) containing "${expected.eachRowContains}"`);

        await expect(this.rows, `${logName}: the page must show exactly the rows to delete`).toHaveCount(expected.rows);
        const foreign = await this.rows.filter({ hasNotText: expected.eachRowContains }).count();
        if (foreign > 0) {
            throw new Error(`${logName}: ${foreign} row(s) on the page do not contain "${expected.eachRowContains}"; refusing to select all`);
        }

        await this.selectAllCheckbox.check();
        logger.info(`Selected all items for ${logName}`);

        await expect(this.deleteButton).toBeVisible();
        await this.deleteButton.click();
        logger.info(`Clicked delete button for ${logName}`);

        await expect(this.confirmModal).toBeVisible();
        await this.confirmDeleteButton.click();

        await expect(this.confirmModal).not.toBeVisible();
        logger.info(`Confirmed deletion for ${logName}`);
    }
}
