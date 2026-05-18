import { Page, Locator, expect } from '@playwright/test';
import { Logger } from '../utils/Logger';
import { DEF_CERTIFICATE_TABLE_HEADERS, CERTIFICATE_DETAILS_TABS } from '../utils/constants';

import { Navigation } from './Navigation';
const logger = new Logger('DiscoveryPage');

export class DiscoveryPage {
    readonly page: Page;
    private readonly navigation: Navigation;

    readonly main: Locator;
    readonly addDiscoveryButton: Locator;
    readonly modal: Locator;
    readonly nameInput: Locator;
    readonly providerTrigger: Locator;
    readonly kindTrigger: Locator;
    readonly targetInput: Locator;
    readonly parallelInput: Locator;
    readonly createButton: Locator;
    readonly providerStatusRow: Locator;
    readonly statusRow: Locator;
    readonly certificateTable: Locator;

    constructor(page: Page) {
        this.page = page;
        this.navigation = new Navigation(page);
        this.main = page.locator('main');
        this.addDiscoveryButton = this.main.getByTestId('plus-button');

        this.modal = page.locator('div[role="dialog"]').filter({ hasText: /create discovery/i }).first();
        this.nameInput = this.modal.getByTestId('text-input-name');

        const providerContainer = this.modal.getByTestId('select-discoveryProviderSelect');
        this.providerTrigger = providerContainer.locator('button').first();

        this.kindTrigger = this.modal.getByTestId('select-storeKindSelect-trigger');

        this.targetInput = this.modal.getByTestId('text-input-__attributes__discovery__.ip').first();
        this.parallelInput = this.modal.getByLabel(/parallel executions/i).first();

        this.createButton = this.modal.getByTestId('progress-button');
        this.providerStatusRow = this.main.locator('tr[data-id="providerStatus"]');
        this.statusRow = this.main.locator('tr[data-id="status"]');

        this.certificateTable = this.main.getByTestId('paged-custom-table').locator('table');
    }

    async goToPage() {
        await this.navigation.openViaSidebar('Discoveries', /discoveries/i);
        await expect(this.main).toBeVisible();
        await expect(this.main.getByRole('heading', { name: /discovery store/i })).toBeVisible();
    }

    async createDiscovery(name: string, provider: string, kind: string, target: string, parallel: string = '10') {
        logger.info(`Creating discovery: ${name}`);
        await this.addDiscoveryButton.click();
        await expect(this.modal).toBeVisible();

        await this.nameInput.waitFor({ state: 'visible' });
        await this.nameInput.scrollIntoViewIfNeeded();
        await this.nameInput.click({ force: true });
        await this.nameInput.fill(name);

        await this.providerTrigger.click();
        const providerOption = this.page
            .locator('#discoveryProviderSelect-listbox')
            .getByRole('option', { name: provider });
        await providerOption.waitFor({ state: 'visible' });
        await providerOption.click();

        await expect(this.modal.getByTestId('label-storeKindSelect')).toBeVisible();
        await this.kindTrigger.click();
        await this.page.getByRole('option', { name: kind }).click();

        await this.targetInput.scrollIntoViewIfNeeded();
        await expect(this.targetInput).toBeVisible();
        await this.targetInput.click();
        await this.targetInput.fill(target);

        if (await this.parallelInput.isVisible()) {
            await this.parallelInput.scrollIntoViewIfNeeded();
            await this.parallelInput.click();
            await this.parallelInput.fill(parallel);
        }

        await this.createButton.click();
        await expect(this.page).toHaveURL(/\/discoveries\/detail\/[a-f0-9-]+/);
    }

    async waitForCompletion(timeout: number = 300000, pollInterval: number = 5000) {
        logger.info('Waiting for discovery completion...');
        await expect.poll(async () => {
            await this.page.reload();
            await expect(this.main).toBeVisible();

            try {
                await expect(this.providerStatusRow).toBeVisible({ timeout: 5000 });
                await expect(this.statusRow).toBeVisible({ timeout: 5000 });

                const providerStatusBadge = this.providerStatusRow.locator('[data-testid="badge"]');
                const statusBadge = this.statusRow.locator('[data-testid="badge"]');

                const providerText = (await providerStatusBadge.textContent())?.trim();
                const statusText = (await statusBadge.textContent())?.trim();

                return providerText === 'Completed' && statusText === 'Completed';
            } catch {
                return false;
            }
        }, {
            message: 'Discovery did not reach Completed status',
            timeout: timeout,
            intervals: [pollInterval],
        }).toBeTruthy();
        logger.info('Discovery completed successfully.');
    }

    async verifyDiscoveredCertificates() {
        logger.info('Verifying discovered certificates table...');
        await this.certificateTable.scrollIntoViewIfNeeded();
        await expect(this.certificateTable).toBeVisible();

        const rows = this.certificateTable.locator('tbody tr');
        await expect(async () => {
            expect(await rows.count()).toBe(2);
        }, "Wait for certificate rows").toPass();

        const headers = this.certificateTable.locator('thead tr th');
        await expect(headers, 'Headers should match expected certificate table headers').toContainText(
            DEF_CERTIFICATE_TABLE_HEADERS.map((h) => new RegExp(h, 'i')),
        );

        const firstRow = rows.first();
        await expect(firstRow.locator('td').nth(0)).not.toBeEmpty();

        const rowText = await firstRow.textContent();
        expect(rowText).toMatch(/(?:\w{2}:)+\w{2}/); // Fingerprint-like
        expect(rowText).toMatch(/\d{4}-\d{2}-\d{2}/); // Date-like
    }

    async openCertificateDetailsAndVerify() {
        logger.info('Opening certificate details...');
        const firstCertLink = this.certificateTable.locator('tbody tr').first().locator('a').first();
        const certName = (await firstCertLink.textContent())?.trim();

        await firstCertLink.click();
        await expect(this.page).toHaveURL(/\/certificates\/detail\/[a-f0-9-]+/);
        await expect(this.page.locator('h1, h2, h3').filter({ hasText: certName }).first()).toBeVisible();

        const tablist = this.page.getByRole('tablist');
        if (await tablist.isVisible()) {
            for (const tabName of CERTIFICATE_DETAILS_TABS) {
                const tab = tablist.getByRole('tab', { name: tabName });
                if (await tab.isVisible()) {
                    await tab.click();
                    await expect(this.page.locator('main')).not.toContainText(/internal server error/i);
                    await expect(this.page.locator('main')).not.toContainText(/unexpected error/i);
                }
            }
        }
    }
}