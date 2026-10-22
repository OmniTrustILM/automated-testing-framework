/**
 * DiscoveryPage — the discovery list and its create dialog.
 *
 * WHAT: the discovery list and its "Create Discovery" dialog (provider, kind, targets, ports, parallel executions).
 * WHY: SMK-003 drives it with positional arguments and checks the result table; REG-DISC-01 creates through the
 *       form and gets the uuid with the create request. The detail page is `DiscoveryDetailPage`.
 * HOW: the dialog by its accessible name and its selects through their trigger buttons (one implementation); the
 *       create form returns the answer of the create request and `waitForDetailRoute` waits for the redirect, so a spec
 *       records the new run before it waits. The methods the smoke suite calls (`goToPage`, the positional
 *       `createDiscovery`, `assertCompletedStatusBadges`, `openResultsTab`, `verifyDiscoveredCertificates`,
 *       `openCertificateDetailsAndVerify`) keep their names and their strict checks.
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

/** The create form of a v1 discovery: the targets (`ip`: comma-separated hosts, ranges or CIDR), optional ports and parallelism. */
export interface DiscoveryForm {
    name: string;
    /** The connector registration NAME. */
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
    readonly modal: Locator;
    readonly nameInput: Locator;
    readonly providerTrigger: Locator;
    readonly kindTrigger: Locator;
    readonly targetInput: Locator;
    readonly parallelInput: Locator;
    readonly createButton: Locator;
    readonly resultsTab: Locator;
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
        // `exact` keeps this off the "Results" widget title on the Details tab.
        this.resultsTab = this.main.getByRole('tab', { name: 'Results', exact: true });
        this.certificateTable = this.main.getByTestId('paged-custom-table').locator('table');
    }

    /** The list by URL. */
    async goToList(): Promise<void> {
        await this.page.goto('/administrator/#/discoveries');
        await expect(this.main.getByRole('heading', { name: /discovery store/i })).toBeVisible();
    }

    /** The list through the sidebar (the smoke spec's navigation). */
    async goToPage() {
        await this.navigation.openViaSidebar('Discoveries', /discoveries/i);
        await expect(this.main).toBeVisible();
        await expect(this.main.getByRole('heading', { name: /discovery store/i })).toBeVisible();
    }

    /**
     * The discovery rows: List → Create → the form → Create; returns the answer of the create request (status, new uuid, the
     * request the form sent) without waiting for the redirect: record the uuid, then `waitForDetailRoute()`.
     * The smoke form (positional arguments) fills the dialog from the open list and returns the uuid only.
     */
    async createDiscovery(form: DiscoveryForm): Promise<CreateAnswer>;
    async createDiscovery(name: string, provider: string, kind: string, target: string, parallel?: string): Promise<string>;
    async createDiscovery(first: DiscoveryForm | string, provider?: string, kind?: string, target?: string, parallel = '10'): Promise<CreateAnswer | string> {
        if (typeof first !== 'string') return this.createFromForm(first);
        return this.createFromSmokeArguments(first, provider!, kind!, target!, parallel);
    }

    private async createFromForm(o: DiscoveryForm): Promise<CreateAnswer> {
        logger.info(`creating the discovery ${o.name} through the form`);
        await this.goToList();
        await this.addDiscoveryButton.click();
        const dialog = this.page.getByRole('dialog', { name: /create discovery/i });
        await expect(dialog).toBeVisible();
        await fillText(dialog.getByTestId('text-input-name'), o.name);
        await chooseOption(this.page, dialog.getByTestId('select-discoveryProviderSelect-trigger'), o.provider);
        await expect(dialog.getByTestId('label-storeKindSelect')).toBeVisible();
        await chooseOption(this.page, dialog.getByTestId('select-storeKindSelect-trigger'), o.kind);
        const ip = dialog.getByTestId('text-input-__attributes__discovery__.ip');
        await expect(ip).toBeVisible();
        await fillText(ip, o.hosts);
        if (o.ports) await fillText(dialog.getByTestId('text-input-__attributes__discovery__.port'), o.ports);
        if (o.parallel !== undefined) await fillText(dialog.getByTestId('text-input-__attributes__discovery__.data_parallel_executions'), String(o.parallel));
        const submit = dialog.getByTestId('progress-button');
        await expect(submit).toBeEnabled();
        return submitCreate(this.page, dialog, { endpoint: '/v1/discoveries' });
    }

    /** Waits for the redirect to the new discovery's detail page after a successful create and returns its uuid. */
    async waitForDetailRoute(): Promise<string> {
        return waitForDetailRoute(this.page, 'discoveries');
    }

    private async createFromSmokeArguments(name: string, provider: string, kind: string, target: string, parallel: string): Promise<string> {
        logger.info(`Creating discovery: ${name}`);
        await this.addDiscoveryButton.click();
        await expect(this.modal).toBeVisible();

        await this.nameInput.waitFor({ state: 'visible' });
        await this.nameInput.scrollIntoViewIfNeeded();
        await this.nameInput.click({ force: true });
        await this.nameInput.fill(name);

        await chooseOption(this.page, this.providerTrigger, provider);

        await expect(this.modal.getByTestId('label-storeKindSelect')).toBeVisible();
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

    // Discovered certificates live on the Results tab, not on Details.
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