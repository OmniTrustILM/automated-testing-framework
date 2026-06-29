import { Page, Locator, expect } from '@playwright/test';
import { Logger } from '../utils/Logger';

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
        const pickOption = async (trigger: Locator, label: string, optionLabel: string) => {
            await expect(trigger, `Filter ${label} trigger should be enabled`).toBeEnabled();
            await trigger.click();
            const option = this.page.getByRole('option', { name: optionLabel, exact: true });
            await option.waitFor({ state: 'visible' });
            await option.click();
        };
        await pickOption(this.filterGroupTrigger, 'Group', opts.group);
        await pickOption(this.filterFieldTrigger, 'Field', opts.field);
        await pickOption(this.filterConditionsTrigger, 'Condition', opts.condition);

        await this.filterValueInput.click();  // focus first — FE removes readonly on focus
        await this.filterValueInput.fill(opts.value);
        await this.addFilterButton.click();
    }

    async bulkDelete(logName: string) {
        logger.info(`Attempting bulk delete for ${logName}`);

        if (!(await this.hasData())) {
            logger.info(`No data found to delete for ${logName}`);
            return;
        }

        if (await this.selectAllCheckbox.isVisible()) {
            await this.selectAllCheckbox.check();
            logger.info(`Selected all items for ${logName}`);

            await expect(this.deleteButton).toBeVisible();
            await this.deleteButton.click();
            logger.info(`Clicked delete button for ${logName}`);

            await expect(this.confirmModal).toBeVisible();
            await this.confirmDeleteButton.click();

            await expect(this.confirmModal).not.toBeVisible();
            logger.info(`Confirmed deletion for ${logName}`);
        } else {
            logger.warn(`Select all checkbox not visible for ${logName}`);
        }
    }
}
