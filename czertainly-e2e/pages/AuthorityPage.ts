/**
 * AuthorityPage — Page Object Model for authorities (REG-CFG-02).
 *
 * Encapsulates:
 *   - the Authorities list and the authority detail
 *   - the add page (a page, not a dialog): name, provider connector, CA selection, CA host and name
 *
 * The connector checks its connectivity before it answers (up to 90 s), so the create answer goes back to the spec
 * before the redirect is waited for. CA values come from the caller, never stored here.
 */
import { expect, Locator, Page } from '@playwright/test';
import type { CreateAnswer } from './ui/createAnswer';
import { submitCreate, waitForDetailRoute } from './ui/detailRoute';
import { customAttributesDefined, fillRequiredCustomAttributes, fillText } from './ui/form';
import { chooseOption } from './ui/select';
import { AUTHORITY_CREATE_MS } from '../utils/regression/timeouts';

export interface ManualCaFields {
    name: string;
    /** The name of the authority connector. */
    connectorName: string;
    caHost: string;
    caName: string;
}

export class AuthorityPage {
    readonly page: Page;
    readonly main: Locator;

    // Authorities list
    readonly addAuthorityButton: Locator;

    // Add authority page
    readonly nameInput: Locator;
    readonly connectorTrigger: Locator;
    readonly caSelectionMethodTrigger: Locator;
    readonly caHostInput: Locator;
    readonly caNameInput: Locator;
    readonly createButton: Locator;

    constructor(page: Page) {
        this.page = page;
        this.main = page.locator('main');

        // Authorities list
        this.addAuthorityButton = this.main.getByTestId('plus-button').first();

        // Add authority page
        this.nameInput = this.main.getByTestId('text-input-name');
        this.connectorTrigger = page.getByTestId('select-authorityProviderSelect-trigger');
        this.caSelectionMethodTrigger = page.getByTestId('select-__attributes__authority__.data_caSelectMethodSelect-trigger');
        this.caHostInput = this.main.getByTestId('text-input-__attributes__authority__.data_caHost').or(this.main.getByLabel(/^CA host/)).first();
        this.caNameInput = this.main.getByTestId('text-input-__attributes__authority__.data_caName').or(this.main.getByLabel(/^CA name/)).first();
        this.createButton = this.main.getByTestId('progress-button').last();
    }

    async goToList(): Promise<void> {
        await this.page.goto('/administrator/#/authorities');
        await expect(this.main).toBeVisible();
    }

    async openAddPage(): Promise<void> {
        await this.addAuthorityButton.click();
        await expect(this.page).toHaveURL(/\/authorities\/add/);
    }

    /** Fills the add page for the connector's manual CA entry (and any required custom attribute) without submitting. */
    async fillManualCaForm(fields: ManualCaFields): Promise<void> {
        await fillText(this.nameInput, fields.name);
        await chooseOption(this.page, this.connectorTrigger, fields.connectorName);
        await chooseOption(this.page, this.caSelectionMethodTrigger, 'Enter CA host and name manually');
        await fillText(this.caHostInput, fields.caHost);
        await fillText(this.caNameInput, fields.caName);
        await fillRequiredCustomAttributes(this.page, this.main, 'qa-reg', await customAttributesDefined(this.page, 'authorities'));
    }

    /**
     * Clicks Create and returns the answer of `POST /api/v1/authorities` (status, new uuid, request body); waits for the connector's check.
     */
    async submitCreateForm(): Promise<CreateAnswer> {
        return submitCreate(this.page, this.createButton, { endpoint: '/api/v1/authorities', timeout: AUTHORITY_CREATE_MS });
    }

    /** Waits for the redirect to the new authority's detail and returns its uuid. Call it after the ledger line. */
    async waitForDetail(): Promise<string> {
        return waitForDetailRoute(this.page, 'authorities', { timeout: AUTHORITY_CREATE_MS });
    }

    async assertDetailShows(name: string): Promise<void> {
        await expect(this.main).toContainText(name);
    }
}
