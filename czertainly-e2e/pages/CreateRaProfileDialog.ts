/**
 * CreateRaProfileDialog — the "Create RA Profile" dialog (REG-CFG-03).
 *
 * Name, authority, certificate template and the required custom attributes, then Create. The create answer goes back
 * to the spec before the page redirects, so the RA profile is on the ledger first.
 */
import { expect, Locator, Page } from '@playwright/test';
import type { CreateAnswer } from './ui/createAnswer';
import { submitCreate } from './ui/detailRoute';
import { customAttributesDefined, fillRequiredCustomAttributes, fillText } from './ui/form';
import { chooseOption, selectTriggerByLabel } from './ui/select';
import { UUID } from './ui/waitForResponse';

export class CreateRaProfileDialog {
    readonly page: Page;

    // Create RA Profile dialog
    readonly dialog: Locator;
    readonly nameInput: Locator;
    readonly authorityTrigger: Locator;
    /** Enabled once the authority's RA-profile attributes have loaded. */
    readonly connectorAttributesTab: Locator;
    readonly certificateTemplateTrigger: Locator;
    readonly createButton: Locator;

    constructor(page: Page) {
        this.page = page;

        // Create RA Profile dialog
        this.dialog = page.getByRole('dialog', { name: 'Create RA Profile' });
        this.nameInput = this.dialog.getByTestId('text-input-name');
        this.authorityTrigger = page.getByTestId('select-authoritySelect-trigger');
        this.connectorAttributesTab = this.dialog.getByRole('tab', { name: 'Connector Attributes' });
        this.certificateTemplateTrigger = page
            .getByTestId('select-__attributes__ra-profile__.data_certificateTemplateSelect-trigger')
            .or(selectTriggerByLabel(this.dialog, /Certificate template/))
            .first();
        this.createButton = this.dialog.getByTestId('progress-button').last();
    }

    async fillName(name: string): Promise<void> {
        await fillText(this.nameInput, name);
    }

    /** Picks the authority by its exact name; the form then loads its RA-profile attributes. */
    async chooseAuthority(authorityName: string): Promise<void> {
        await chooseOption(this.page, this.authorityTrigger, authorityName);
        await expect(this.connectorAttributesTab).toBeEnabled();
    }

    /** Picks the certificate template the CA offers (by the reference the select shows). */
    async chooseTemplate(reference: string): Promise<void> {
        await chooseOption(this.page, this.certificateTemplateTrigger, reference);
    }

    /** Fills every required custom attribute the tier defines for RA profiles (none: nothing). */
    async fillRequiredCustomAttributes(): Promise<void> {
        await fillRequiredCustomAttributes(this.page, this.dialog, 'qa-reg', await customAttributesDefined(this.page, 'raProfiles'));
    }

    /**
     * Clicks Create and returns the answer of `POST /api/v1/authorities/{uuid}/raProfiles` (status, new uuid, request body). The
     * redirect to the detail is NOT waited for: the spec records the answer in the ledger first.
     */
    async submitCreate(options: { timeout?: number } = {}): Promise<CreateAnswer> {
        return submitCreate(this.page, this.createButton, { endpoint: new RegExp(`/api/v1/authorities/${UUID}/raProfiles$`), timeout: options.timeout });
    }
}
