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

import { Page, Locator, expect } from '@playwright/test';
import { Logger } from '../utils/Logger';

const logger = new Logger('KeyPage');

/** Connector attribute fields are prefixed like this in the FE's test ids. */
const ATTR = '__attributes__cryptographicKey__.';

export class KeyPage {
    readonly page: Page;
    readonly main: Locator;
    readonly dialog: Locator;

    constructor(page: Page) {
        this.page = page;
        this.main = page.locator('main');
        this.dialog = page.getByRole('dialog');
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

    private async choose(selectId: string, option: string): Promise<void> {
        await this.dialog.getByTestId(`select-${selectId}-trigger`).click();
        await this.page.getByRole('option', { name: option, exact: true }).click();
        await expect(this.dialog.getByTestId(`select-${selectId}-trigger`)).toHaveText(option);
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
        await this.choose('tokenProfileSelect', options.tokenProfileName);
        await this.choose('typeSelect', 'Key pair');
        await this.type(`text-input-${ATTR}data_keyAlias`, options.alias);
        await this.choose(`${ATTR}data_keyAlgorithmSelect`, 'RSA');
        await this.choose(`${ATTR}data_rsaKeySizeSelect`, `RSA_${options.rsaSize}`);
    }

    /** Submits the form and returns the new key's UUID from the detail page the platform opens. */
    async submit(): Promise<string> {
        await this.dialog.getByTestId('progress-button').click();
        await expect(this.page).toHaveURL(/\/keys\/detail\/[0-9a-f-]{36}/, { timeout: 30_000 });
        const uuid = /\/keys\/detail\/([0-9a-f-]{36})/.exec(this.page.url())![1];
        logger.info(`Key created: ${uuid}`);
        return uuid;
    }

    /**
     * A row of the Key Details table, by the FE's `data-id`. Key items reuse ids such as `name`,
     * so the lookup stays inside the first property table on the page, which is Key Details.
     */
    row(dataId: string): Locator {
        return this.main.getByTestId('custom-table').first().locator(`tr[data-id="${dataId}"]`);
    }

    /** Switches the key-item tabs to "Public key" or "Private key". */
    async openKeyItem(name: 'Public key' | 'Private key'): Promise<void> {
        const tab = this.main.getByRole('tab', { name, exact: true });
        await tab.click();
        await expect(tab).toHaveAttribute('aria-selected', 'true');
    }

    /**
     * A row of the key item shown in the active tab. Both items' tables may stay in the DOM, so
     * only the visible one counts.
     */
    itemRow(dataId: string): Locator {
        return this.main.locator(`tr[data-id="${dataId}"]:visible`);
    }

    /** Enables the whole key from the Key Details toolbar. The platform enables it at once, no dialog. */
    async enableKey(): Promise<void> {
        logger.info('Enabling the key');
        await this.main.getByTestId('check-button').first().click();
    }
}
