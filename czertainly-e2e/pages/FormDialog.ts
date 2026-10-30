/**
 * FormDialog — a create / edit dialog of the admin UI.
 *
 * Provides text inputs, the submit button and Cancel. The role and user pages share it. `submit` returns the answer
 * (`ApiAnswer`) of the request the caller names, registered before the click; a create goes through `submitCreate` on
 * the dialog instead, which keeps the new uuid. Inputs are readonly until focused, so they are filled through
 * `fillText`.
 */
import { expect, Locator, Page } from '@playwright/test';
import type { ApiAnswer } from '../utils/regression/apiReads';
import { fillText, submitButtonOf } from './ui/form';
import { actAndWaitForApi, answerFrom, ApiCall } from './ui/waitForResponse';

export class FormDialog {
    private readonly page: Page;
    readonly dialog: Locator;
    readonly submitButton: Locator;

    /** `caption`: the dialog's accessible name, e.g. `Create Role`. */
    constructor(page: Page, caption: string) {
        this.page = page;
        this.dialog = page.getByRole('dialog', { name: caption });
        this.submitButton = submitButtonOf(this.dialog);
    }

    /** The text input of a form field (`text-input-<field>`). */
    input(field: string): Locator {
        return this.dialog.getByTestId(`text-input-${field}`);
    }

    /** Fills the given text fields in the order given; `undefined` values are left as they are. */
    async fillTexts(values: Record<string, string | undefined>): Promise<void> {
        for (const [field, value] of Object.entries(values)) {
            if (value !== undefined) await fillText(this.input(field), value);
        }
    }

    /** Clicks the submit button and returns the answer of the request `call` describes. */
    async submit(call: ApiCall): Promise<ApiAnswer> {
        const startedAt = Date.now();
        return answerFrom(await actAndWaitForApi(this.page, call, () => this.submitButton.click()), startedAt);
    }

    /** Closes the dialog with Cancel when it is still open (after a refused submit), and waits until it is gone. */
    async cancel(): Promise<void> {
        if (await this.dialog.isVisible()) {
            await this.dialog.getByRole('button', { name: 'Cancel', exact: true }).click();
            await expect(this.dialog).toBeHidden();
        }
    }
}
