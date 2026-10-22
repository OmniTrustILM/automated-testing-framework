/**
 * AuthorityPage — the Authorities list and the add-authority page.
 *
 * WHAT: the Authorities list, the add page (name, provider connector, the connector's CA-selection method, CA host and CA name,
 *       required custom attributes) and the authority detail.
 * WHY: REG-CFG-02 creates a Microsoft ADCS authority with a manually entered CA host and name; the connector checks its
 *      connectivity before it answers, which takes up to 90 s, so the answer goes back to the spec before the redirect is
 *      waited for.
 * HOW: the form is a page, not a dialog, so its scope is `main`; the selects go through their trigger buttons; the CA host and
 *      name inputs by their attribute test id or their label; the CA values come from the caller and are never stored here.
 */
import { expect, Locator, Page } from '@playwright/test';
import type { CreateAnswer } from './ui/createAnswer';
import { submitCreate, waitForDetailRoute } from './ui/detailRoute';
import { customAttributesDefined, fillRequiredCustomAttributes, fillText } from './ui/form';
import { chooseOption } from './ui/select';
import { toolbarButton } from './ui/toolbar';
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

    constructor(page: Page) {
        this.page = page;
        this.main = page.locator('main');
    }

    async goToList(): Promise<void> {
        await this.page.goto('administrator/#/authorities');
        await expect(this.main).toBeVisible();
    }

    /** The list's "+" → the add page is open. */
    async openAddPage(): Promise<void> {
        await toolbarButton(this.page, 'plus').click();
        await expect(this.page).toHaveURL(/\/authorities\/add/);
    }

    /** Fills the add page for the connector's manual CA entry (and any required custom attribute) without submitting. */
    async fillManualCaForm(fields: ManualCaFields): Promise<void> {
        const main = this.main;
        await fillText(main.getByTestId('text-input-name'), fields.name);
        await chooseOption(this.page, this.page.getByTestId('select-authorityProviderSelect-trigger'), fields.connectorName);
        await chooseOption(this.page, this.page.getByTestId('select-__attributes__authority__.data_caSelectMethodSelect-trigger'), 'Enter CA host and name manually');
        const host = main.getByTestId('text-input-__attributes__authority__.data_caHost').or(main.getByLabel(/^CA host/)).first();
        const caName = main.getByTestId('text-input-__attributes__authority__.data_caName').or(main.getByLabel(/^CA name/)).first();
        await fillText(host, fields.caHost);
        await fillText(caName, fields.caName);
        await fillRequiredCustomAttributes(this.page, main, 'qa-reg', await customAttributesDefined(this.page, 'authorities'));
    }

    /**
     * Clicks Create and returns the answer of `POST /api/v1/authorities` (status, new uuid, request body); waits for the connector's
     * check.
     */
    async submitCreateForm(): Promise<CreateAnswer> {
        return submitCreate(this.page, this.main, { endpoint: '/api/v1/authorities', timeout: AUTHORITY_CREATE_MS });
    }

    /** Waits for the redirect to the new authority's detail and returns its uuid. Call it after the ledger line. */
    async waitForDetail(): Promise<string> {
        return waitForDetailRoute(this.page, 'authorities', { timeout: AUTHORITY_CREATE_MS });
    }

    /** The detail page shows the authority's name. */
    async assertDetailShows(name: string): Promise<void> {
        await expect(this.main).toContainText(name);
    }
}
