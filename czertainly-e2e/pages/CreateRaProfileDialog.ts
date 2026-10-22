/**
 * CreateRaProfileDialog — the "Create RA Profile" dialog.
 *
 * WHAT: the "Create RA Profile" dialog: name, authority, the authority's connector attributes (the certificate template of a
 *       CA that offers one), the required custom attributes and Create.
 * WHY: REG-CFG-03 creates through it and gets the create answer back before the page redirects; REG-CERT-68 proves client-side
 *      validation: Create stays disabled while a required attribute is empty, an input shows the message once left, a refusal
 *      that reaches core shows the 422 text in a toast. `submitIfEnabled` returns the response so an accidental create is
 *      recorded first.
 * HOW: opened by `RaProfilePage.openCreateDialog`; fields by test id, required attributes by the label that ends in an
 *      asterisk; the template select by its id or, when the tier renders no id, by its label.
 */
import { expect, Locator, Page, Response } from '@playwright/test';
import { Logger } from '../utils/Logger';
import type { CreateAnswer } from './ui/createAnswer';
import { submitCreate } from './ui/detailRoute';
import { customAttributesDefined, fillRequiredCustomAttributes, fillText, submitButtonOf } from './ui/form';
import { toast } from './ui/toast';
import { chooseOption, selectTriggerByLabel } from './ui/select';
import { actAndWaitForApi, UUID } from './ui/waitForResponse';
import { LIST_STATE_MS } from '../utils/regression/timeouts';

const logger = new Logger('CreateRaProfileDialog');

/** What `submitIfEnabled` did. */
export type SubmitOutcome = { sent: false } | { sent: true; response: Response };

export class CreateRaProfileDialog {
    readonly page: Page;
    readonly dialog: Locator;
    /** The Create button of the dialog. */
    readonly createButton: Locator;

    constructor(page: Page) {
        this.page = page;
        this.dialog = page.getByRole('dialog', { name: 'Create RA Profile' });
        this.createButton = submitButtonOf(this.dialog);
    }

    async fillName(name: string): Promise<void> {
        await fillText(this.dialog.getByTestId('text-input-name'), name);
    }

    /** Picks the authority by its exact name; the form then loads its RA-profile attributes. */
    async chooseAuthority(authorityName: string): Promise<void> {
        await chooseOption(this.page, this.page.getByTestId('select-authoritySelect-trigger'), authorityName);
        await expect(this.dialog.getByRole('tab', { name: 'Connector Attributes' })).toBeEnabled();
    }

    /** Picks the certificate template the CA offers (by the reference the select shows). */
    async chooseTemplate(reference: string): Promise<void> {
        const trigger = this.page.getByTestId('select-__attributes__ra-profile__.data_certificateTemplateSelect-trigger')
            .or(selectTriggerByLabel(this.dialog, /Certificate template/)).first();
        await chooseOption(this.page, trigger, reference);
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
        return submitCreate(this.page, this.dialog, { endpoint: new RegExp(`/api/v1/authorities/${UUID}/raProfiles$`), timeout: options.timeout });
    }

    /** The required connector attributes the form shows: label text (without the " *") and the field id the label points at. */
    async requiredFields(): Promise<Array<{ label: string; field: string }>> {
        const labels = this.dialog.locator('label[for^="__attributes__ra-profile__"]').filter({ hasText: /\*\s*$/ });
        await expect(labels.first(), 'the form shows a required connector attribute').toBeVisible({ timeout: LIST_STATE_MS });
        const out: Array<{ label: string; field: string }> = [];
        for (const l of await labels.all()) {
            out.push({ label: (await l.innerText()).replace(/\s*\*\s*$/, '').trim(), field: (await l.getAttribute('for'))! });
        }
        return out;
    }

    /** The control of a required field: its Select trigger or its input. */
    private control(field: string): Locator {
        return this.page.getByTestId(`select-${field}-trigger`).or(this.dialog.locator(`[id="${field}"]`)).first();
    }

    /**
     * Leaves a required INPUT empty after focusing it (react-hook-form marks it touched on blur, which shows "Required Field"). A
     * Select has no blur to give.
     */
    async focusAndLeaveRequiredField(field: string): Promise<'input' | 'select'> {
        const isSelect = (await this.page.getByTestId(`select-${field}-trigger`).count()) > 0;
        if (isSelect) return 'select';
        const input = this.control(field);
        await input.click();
        await expect(input).toHaveValue('');
        await this.dialog.getByTestId('text-input-name').click(); // moves the focus away: blur
        return 'input';
    }

    /**
     * Clicks Create only when the form lets it. The form is expected to be blocked: a disabled button is `{ sent: false }`;
     * an enabled one is clicked and its `POST …/raProfiles` answer returned, so the caller can record an accidental success
     * in the ledger before it asserts.
     */
    async submitIfEnabled(): Promise<SubmitOutcome> {
        if (await this.createButton.isDisabled()) return { sent: false };
        const response = await actAndWaitForApi(this.page, { method: 'POST', path: new RegExp(`/api/v1/authorities/${UUID}/raProfiles$`) }, () => this.createButton.click());
        return { sent: true, response };
    }

    /** Create is disabled: the client-side validation holds the form back. */
    async assertCreateDisabled(): Promise<void> {
        await expect(this.createButton).toBeDisabled();
    }

    /**
     * The form shows a validation message for the required attribute: the field's red "Required Field" (an input) or, when
     * a refusal reached core, the 422 text in a danger toast ("Required attribute <label> not found."). Resolves with which
     * one was shown.
     */
    async assertRequiredAttributeError(label?: string): Promise<'field' | 'toast'> {
        const field = this.dialog.getByText('Required Field', { exact: true }).first();
        const refusal = toast(this.page, new RegExp(label ? `Required attribute ${label.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')} not found\\.` : 'Required attribute .+ not found\\.'));
        await expect(field.or(refusal)).toBeVisible();
        return (await field.isVisible()) ? 'field' : 'toast';
    }

    /**
     * A refusal that reached core is shown: a danger toast that carries every message core answered (the FE joins the 422
     * array into the toast text), whatever its headline.
     */
    async assertRefusalShown(messages: string[]): Promise<void> {
        const card = toast(this.page, messages[0]);
        await expect(card).toBeVisible();
        await expect(card).toHaveAttribute('role', 'alert');
        for (const m of messages) await expect(card).toContainText(m);
    }

    /**
     * No validation text is shown yet (the form before anything was touched). `because` becomes the failure message (it says what
     * changed when the form starts showing the text).
     */
    async assertNoRequiredFieldMessage(because?: string): Promise<void> {
        await expect(this.dialog.getByText('Required Field', { exact: true }), because).toHaveCount(0);
    }

    async cancel(): Promise<void> {
        await this.dialog.getByRole('button', { name: 'Cancel', exact: true }).click();
        await expect(this.dialog).toBeHidden();
    }
}
