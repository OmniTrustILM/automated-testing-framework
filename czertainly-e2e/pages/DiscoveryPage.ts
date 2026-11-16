/**
 * DiscoveryPage — the discovery list and its Create Discovery dialog (SMK-003).
 */
import { Page, Locator, expect } from '@playwright/test';
import { Logger } from '../utils/Logger';
import { DEF_CERTIFICATE_TABLE_HEADERS, CERTIFICATE_DETAILS_TABS } from '../utils/constants';

import { Navigation } from './Navigation';
import type { CreateAnswer } from './ui/createAnswer';
import { submitCreate, waitForDetailRoute } from './ui/detailRoute';
import { fillText } from './ui/form';
import { chooseOption } from './ui/select';
const logger = new Logger('DiscoveryPage');

/** The create form of a v1 discovery: `hosts` are comma-separated hosts, ranges or CIDR; `provider` is the connector's name. */
export interface DiscoveryForm {
    name: string;
    provider: string;
    kind: string;
    hosts: string;
    ports?: string;
    parallel?: number;
}

export class DiscoveryPage {
    readonly page: Page;
    private readonly navigation: Navigation;

    readonly main: Locator;
    readonly addDiscoveryButton: Locator;
    readonly discoveryStoreHeading: Locator;
    readonly modal: Locator;
    readonly nameInput: Locator;
    readonly providerTrigger: Locator;
    readonly kindLabel: Locator;
    readonly kindTrigger: Locator;
    readonly targetInput: Locator;
    readonly portInput: Locator;
    readonly parallelInput: Locator;
    readonly parallelExecutionsInput: Locator;
    readonly createButton: Locator;
    readonly resultsTab: Locator;
    readonly certificateTable: Locator;

    constructor(page: Page) {
        this.page = page;
        this.navigation = new Navigation(page);
        this.main = page.locator('main');
        this.addDiscoveryButton = this.main.getByTestId('plus-button');
        this.discoveryStoreHeading = this.main.getByRole('heading', { name: /discovery store/i });

        this.modal = page.locator('div[role="dialog"]').filter({ hasText: /create discovery/i }).first();
        this.nameInput = this.modal.getByTestId('text-input-name');

        const providerContainer = this.modal.getByTestId('select-discoveryProviderSelect');
        this.providerTrigger = providerContainer.locator('button').first();

        this.kindLabel = this.modal.getByTestId('label-storeKindSelect');
        this.kindTrigger = this.modal.getByTestId('select-storeKindSelect-trigger');

        this.targetInput = this.modal.getByTestId('text-input-__attributes__discovery__.ip').first();
        this.portInput = this.modal.getByTestId('text-input-__attributes__discovery__.port');
        this.parallelInput = this.modal.getByLabel(/parallel executions/i).first();
        this.parallelExecutionsInput = this.modal.getByTestId('text-input-__attributes__discovery__.data_parallel_executions');

        this.createButton = this.modal.getByTestId('progress-button');
        // `exact` keeps this off the "Results" widget title on the Details tab.
        this.resultsTab = this.main.getByRole('tab', { name: 'Results', exact: true });
        this.certificateTable = this.main.getByTestId('paged-custom-table').locator('table');
    }

    async goToPage() {
        await this.navigation.openViaSidebar('sidebar-discoveries', /discoveries/i);
        await expect(this.main).toBeVisible();
        await expect(this.discoveryStoreHeading).toBeVisible();
    }

    /** The list by its route, not by the sidebar. */
    async goToList(): Promise<void> {
        await this.page.goto('/administrator/#/discoveries');
        await expect(this.discoveryStoreHeading).toBeVisible();
    }

    /** List → Create → the form → Create; returns the create answer before the redirect (record it, then `waitForDetailRoute`). */
    async createFromForm(o: DiscoveryForm): Promise<CreateAnswer> {
        logger.info(`creating the discovery ${o.name} through the form`);
        await this.goToList();
        await this.addDiscoveryButton.click();
        await expect(this.modal).toBeVisible();
        await fillText(this.nameInput, o.name);
        await chooseOption(this.page, this.providerTrigger, o.provider);
        await expect(this.kindLabel).toBeVisible();
        await chooseOption(this.page, this.kindTrigger, o.kind);
        await expect(this.targetInput).toBeVisible();
        await fillText(this.targetInput, o.hosts);
        if (o.ports) await fillText(this.portInput, o.ports);
        if (o.parallel !== undefined) await fillText(this.parallelExecutionsInput, String(o.parallel));
        await expect(this.createButton).toBeEnabled();
        return submitCreate(this.page, this.createButton, { endpoint: '/v1/discoveries' });
    }

    async waitForDetailRoute(): Promise<string> {
        return waitForDetailRoute(this.page, 'discoveries');
    }

    async createDiscovery(name: string, provider: string, kind: string, target: string, parallel: string = '10'): Promise<string> {
        logger.info(`Creating discovery: ${name}`);
        await this.addDiscoveryButton.click();
        await expect(this.modal).toBeVisible();

        await this.nameInput.waitFor({ state: 'visible' });
        await this.nameInput.scrollIntoViewIfNeeded();
        await this.nameInput.click({ force: true });
        await this.nameInput.fill(name);

        // Exact (chooseOption matches a plain name exactly): a connector registered as v1 and v2 is listed as "<name>" and "<name>-v2".
        await chooseOption(this.page, this.providerTrigger, provider);

        await expect(this.kindLabel).toBeVisible();
        await chooseOption(this.page, this.kindTrigger, kind);

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
        return waitForDetailRoute(this.page, 'discoveries');
    }

    async assertCompletedStatusBadges(): Promise<void> {
        logger.info('Asserting UI shows Completed status badges (provider + overall)');
        const providerBadge = this.main.locator('tr[data-id="providerStatus"] [data-testid="badge"]');
        const statusBadge = this.main.locator('tr[data-id="status"] [data-testid="badge"]');
        await expect(providerBadge).toHaveText('Completed');
        await expect(statusBadge).toHaveText('Completed');
    }

    async openResultsTab(): Promise<void> {
        logger.info('Opening Results tab');
        await this.resultsTab.click();
        await expect(this.resultsTab).toHaveAttribute('aria-selected', 'true');
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
                const tab = tablist.getByRole('tab', { name: tabName, exact: true });
                if (await tab.isVisible()) {
                    await tab.click();
                    await expect(this.page.locator('main')).not.toContainText(/internal server error/i);
                    await expect(this.page.locator('main')).not.toContainText(/unexpected error/i);
                }
            }
        }
    }
}