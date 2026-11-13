/**
 * CreateRaProfileDialog — the "Create RA Profile" dialog (REG-CFG-03).
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
    readonly connectorAttributesTab: Locator;
    readonly certificateTemplateTrigger: Locator;
    readonly createButton: Locator;

    constructor(page: Page) {
        this.page = page;

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

    async chooseAuthority(authorityName: string): Promise<void> {
        await chooseOption(this.page, this.authorityTrigger, authorityName);
        await expect(this.connectorAttributesTab).toBeEnabled();
    }

    async chooseTemplate(reference: string): Promise<void> {
        await chooseOption(this.page, this.certificateTemplateTrigger, reference);
    }

    async fillRequiredCustomAttributes(): Promise<void> {
        await fillRequiredCustomAttributes(this.page, this.dialog, 'qa-reg', await customAttributesDefined(this.page, 'raProfiles'));
    }

    /** Clicks Create and returns the create answer; the redirect is not waited for, so the spec records the ledger line first. */
    async submitCreate(options: { timeout?: number } = {}): Promise<CreateAnswer> {
        return submitCreate(this.page, this.createButton, { endpoint: new RegExp(`/api/v1/authorities/${UUID}/raProfiles$`), timeout: options.timeout });
    }
}
