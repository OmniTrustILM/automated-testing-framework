/**
 * FormDialog — a create / edit dialog of the admin UI: text inputs by test id (`text-input-<field>`, readonly until
 * focused, so they are filled through `fillText`), the form's submit button (ProgressButton: Create / Save) and Cancel.
 * `submit` returns the answer of the request the submit sends (the wait is registered before the click); the caller
 * asserts it. Used by the role and user pages.
 */
import { expect, Locator, Page, Response } from '@playwright/test';
import { fillText, submitButtonOf } from './ui/form';
import { actAndWaitForApi, ApiCall } from './ui/waitForResponse';

export class FormDialog {
    readonly page: Page;
    readonly dialog: Locator;

    /** `caption`: the dialog's accessible name, e.g. `Create Role`. */
    constructor(page: Page, caption: string) {
        this.page = page;
        this.dialog = page.getByRole('dialog', { name: caption });
    }

    /** The text input of a form field (`text-input-<field>`). */
    input(field: string): Locator {
        return this.dialog.getByTestId(`text-input-${field}`);
    }

    get submitButton(): Locator {
        return submitButtonOf(this.dialog);
    }

    /** Fills the given text fields in the order given; `undefined` values are left as they are. */
    async fillTexts(values: Record<string, string | undefined>): Promise<void> {
        for (const [field, value] of Object.entries(values)) {
            if (value !== undefined) await fillText(this.input(field), value);
        }
    }

    /** Clicks the submit button and returns the answer of the request `call` describes. */
    async submit(call: ApiCall): Promise<Response> {
        return actAndWaitForApi(this.page, call, () => this.submitButton.click());
    }

    /** Closes the dialog with Cancel when it is still open (after a refused submit), and waits until it is gone. */
    async cancel(): Promise<void> {
        if (await this.dialog.isVisible()) {
            await this.dialog.getByRole('button', { name: 'Cancel', exact: true }).click();
            await expect(this.dialog).toBeHidden();
        }
    }
}
