/**
 * KeyPage — Page Object for the Key Inventory: the Create Key modal and the key detail page.
 *
 * WHAT: opens Create Key, fills the "Generate new" form (name, Token Profile, key type and the
 * connector's attributes: alias, algorithm, RSA size), submits it, and reads the detail page the
 * platform lands on: the key's own rows, its attributes, and the rows of each key item.
 *
 * WHY: SMK-006 drives the form a user fills in. The connector attributes are rendered from the
 * provider's definitions, and the RSA size only appears once RSA is chosen, so the order of the
 * steps matters and lives here rather than in the test.
 *
 * HOW: test ids as the FE renders them. Selects are driven through their `-trigger` button, not
 * the hidden native <select>, and text inputs are clicked before fill (both see
 * reference_ilm_fe_playwright_patterns). The list is opened by URL, not through the sidebar.
 */

import { Locator, Page, expect } from '@playwright/test';
import { Logger } from '../utils/Logger';
import { waitForDetailRoute } from './ui/detailRoute';
import { chooseOption } from './ui/select';
import { widgetTitled } from './ui/widget';
import { PAGE_ROUTE_MS } from '../utils/regression/timeouts';

const logger = new Logger('KeyPage');

/** Connector attribute fields are prefixed like this in the admin UI's test ids. */
const ATTR = '__attributes__cryptographicKey__.';

export class KeyPage {
    readonly page: Page;
    readonly main: Locator;

    // Create Key dialog
    readonly dialog: Locator;
    readonly submitButton: Locator;

    // Key Details: the key-level rows and toolbar
    readonly keyDetails: Locator;
    readonly enableKeyButton: Locator;

    constructor(page: Page) {
        this.page = page;
        this.main = page.locator('main');

        // Create Key dialog
        this.dialog = page.getByRole('dialog', { name: 'Create Key', exact: true });
        this.submitButton = this.dialog.getByTestId('progress-button');

        // Key Details: the key-level rows and toolbar
        this.keyDetails = widgetTitled(this.main, 'Key Details');
        this.enableKeyButton = this.keyDetails.getByTestId('check-button');
    }

    async goToList(): Promise<void> {
        await this.page.goto('/administrator/#/keys');
        await expect(this.main.getByTestId('plus-button')).toBeVisible();
    }

    async openCreateModal(): Promise<void> {
        logger.info('Opening Create Key');
        await this.main.getByTestId('plus-button').click();
        await expect(this.dialog.getByTestId('text-input-name')).toBeVisible();
    }

    private async type(testId: string, value: string): Promise<void> {
        const input = this.dialog.getByTestId(testId);
        await input.click();
        await input.fill(value);
    }

    /** Fills "Generate new" for an RSA key pair. Each select reveals the next field. */
    async fillRsaKeyPair(options: { name: string; tokenProfileName: string; alias: string; rsaSize: '1024' | '2048' | '4096' }): Promise<void> {
        logger.info(`Filling Create Key: ${options.name} on ${options.tokenProfileName}, RSA ${options.rsaSize}`);
        await this.type('text-input-name', options.name);
        await chooseOption(this.page, this.dialog.getByTestId('select-tokenProfileSelect-trigger'), options.tokenProfileName);
        await chooseOption(this.page, this.dialog.getByTestId('select-typeSelect-trigger'), 'Key pair');
        await this.type(`text-input-${ATTR}data_keyAlias`, options.alias);
        await chooseOption(this.page, this.dialog.getByTestId(`select-${ATTR}data_keyAlgorithmSelect-trigger`), 'RSA');
        await chooseOption(this.page, this.dialog.getByTestId(`select-${ATTR}data_rsaKeySizeSelect-trigger`), `RSA_${options.rsaSize}`);
    }

    /** Submits the form and returns the new key's UUID from the detail page the platform opens. */
    async submit(): Promise<string> {
        await this.submitButton.click();
        const uuid = await waitForDetailRoute(this.page, 'keys', { timeout: PAGE_ROUTE_MS });
        logger.info(`Key created: ${uuid}`);
        return uuid;
    }

    /**
     * A row of the Key Details table, by the admin UI's `data-id`. Key items reuse ids such as `name`, so the lookup
     * stays inside the Key Details widget.
     */
    row(dataId: string): Locator {
        return this.keyDetails.locator(`tr[data-id="${dataId}"]`);
    }

    /** Switches the key-item tabs to "Public key" or "Private key". */
    async openKeyItem(name: 'Public key' | 'Private key'): Promise<void> {
        const tab = this.main.getByRole('tab', { name, exact: true });
        await tab.click();
        await expect(tab).toHaveAttribute('aria-selected', 'true');
    }

    /** A row of the key item shown in the active tab. Both items' tables may stay in the DOM, so only the visible one counts. */
    itemRow(dataId: string): Locator {
        return this.main.locator(`tr[data-id="${dataId}"]:visible`);
    }

    /** Enables the whole key from the Key Details toolbar. The platform enables it at once, no dialog. */
    async enableKey(): Promise<void> {
        logger.info('Enabling the key');
        await this.enableKeyButton.click();
    }
}
