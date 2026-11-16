/**
 * CreateRaProfileDialog — the "Create RA Profile" dialog (REG-CFG-03).
 */
import { expect, Locator, Page, Response } from '@playwright/test';
import type { CreateAnswer } from './ui/createAnswer';
import { submitCreate } from './ui/detailRoute';
import { customAttributesDefined, fillRequiredCustomAttributes, fillText } from './ui/form';
import { chooseOption, selectTriggerByLabel } from './ui/select';
import { toast } from './ui/toast';
import { UUID, watchApiCall } from './ui/waitForResponse';
import { LIST_STATE_MS } from '../utils/regression/timeouts';
import { escapeRegExp } from '../utils/regression/text';

const CREATE_ENDPOINT = new RegExp(`/api/v1/authorities/${UUID}/raProfiles$`);
/** How long Create may take to turn disabled once the form is invalid. */
const DISABLED_SETTLE_MS = 2_000;

/** What `submitIfEnabled` did: a disabled Create sends nothing; an enabled one returns the response, to record an accidental create. */
export type SubmitOutcome = { sent: false } | { sent: true; response: Response };

export class CreateRaProfileDialog {
    readonly page: Page;

    // Create RA Profile dialog
    readonly dialog: Locator;
    readonly nameInput: Locator;
    readonly authorityTrigger: Locator;
    readonly connectorAttributesTab: Locator;
    readonly certificateTemplateTrigger: Locator;
    readonly requiredConnectorAttributeLabels: Locator;
    readonly requiredFieldMessage: Locator;
    readonly createButton: Locator;
    readonly cancelButton: Locator;

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
        this.requiredConnectorAttributeLabels = this.dialog.locator('label[for^="__attributes__ra-profile__"]').filter({ hasText: /\*\s*$/ });
        this.requiredFieldMessage = this.dialog.getByText('Required Field', { exact: true });
        this.createButton = this.dialog.getByTestId('progress-button').last();
        this.cancelButton = this.dialog.getByRole('button', { name: 'Cancel', exact: true });
    }

    /** The Select trigger of an attribute field. */
    selectTrigger(field: string): Locator {
        return this.page.getByTestId(`select-${field}-trigger`);
    }

    /** The control of an attribute field: its Select trigger or its input. */
    fieldControl(field: string): Locator {
        return this.selectTrigger(field).or(this.dialog.locator(`[id="${field}"]`)).first();
    }

    /** The 422 toast "Required attribute <label> not found.". */
    requiredAttributeToast(label: string): Locator {
        return toast(this.page, new RegExp(`Required attribute ${escapeRegExp(label)} not found\\.`));
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
        return submitCreate(this.page, this.createButton, { endpoint: CREATE_ENDPOINT, timeout: options.timeout });
    }

    /** The required connector attributes the form shows: label text (without the " *") and the field id the label points at. */
    async requiredFields(): Promise<Array<{ label: string; field: string }>> {
        await expect(this.requiredConnectorAttributeLabels.first(), 'the form shows a required connector attribute')
            .toBeVisible({ timeout: LIST_STATE_MS });
        const out: Array<{ label: string; field: string }> = [];
        for (const l of await this.requiredConnectorAttributeLabels.all()) {
            out.push({ label: (await l.innerText()).replace(/\s*\*\s*$/, '').trim(), field: (await l.getAttribute('for'))! });
        }
        return out;
    }

    /** Focuses a required input and leaves it empty (touched on blur shows "Required Field"); a Select has no blur to give. */
    async focusAndLeaveRequiredField(field: string): Promise<'input' | 'select'> {
        if ((await this.selectTrigger(field).count()) > 0) return 'select';
        const input = this.fieldControl(field);
        await input.click();
        await expect(input).toHaveValue('');
        await this.nameInput.click(); // moves the focus away: blur
        return 'input';
    }

    /** Clicks Create only when it stays enabled (it is expected to be blocked); the answer wait is registered before anything else. */
    async submitIfEnabled(): Promise<SubmitOutcome> {
        const response = watchApiCall(this.page, { method: 'POST', path: CREATE_ENDPOINT });
        const disabled = await expect(this.createButton).toBeDisabled({ timeout: DISABLED_SETTLE_MS }).then(() => true, () => false);
        if (disabled) return { sent: false };
        await this.createButton.click();
        return { sent: true, response: await response };
    }

    async assertCreateDisabled(): Promise<void> {
        await expect(this.createButton).toBeDisabled();
    }

    /** The field's "Required Field" (an input) or, when a refusal reached core, the 422 toast; resolves with which one was shown. */
    async assertRequiredAttributeError(label: string): Promise<'field' | 'toast'> {
        const field = this.requiredFieldMessage.first();
        await expect(field.or(this.requiredAttributeToast(label))).toBeVisible();
        return (await field.isVisible()) ? 'field' : 'toast';
    }

    /** A danger toast that carries every message core answered (the FE joins the 422 array into the toast text). */
    async assertRefusalShown(messages: string[]): Promise<void> {
        const card = toast(this.page, messages[0]);
        await expect(card).toBeVisible();
        await expect(card).toHaveAttribute('role', 'alert');
        for (const m of messages) await expect(card).toContainText(m);
    }

    async assertNoRequiredFieldMessage(): Promise<void> {
        await expect(this.requiredFieldMessage).toHaveCount(0);
    }

    async cancel(): Promise<void> {
        await this.cancelButton.click();
        await expect(this.dialog).toBeHidden();
    }
}
