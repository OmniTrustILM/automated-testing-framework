/**
 * ConfirmDeleteDialog — the delete confirmation of the admin UI.
 *
 * WHAT: the "Delete <thing>" confirmation of the admin UI.
 * WHY: the role and user pages delete through it; the answer of the DELETE it sends is returned to the spec, which
 *       asserts it after the ledger line.
 * HOW: the dialog by its accessible name; the wait for the request is registered before the click.
 */
import { expect, Locator, Page } from '@playwright/test';
import type { ApiAnswer } from '../utils/regression/apiReads';
import { actAndWaitForApi, answerFrom, ApiCall } from './ui/waitForResponse';

export class ConfirmDeleteDialog {
    private readonly page: Page;
    readonly dialog: Locator;

    /** `caption`: the dialog's accessible name, e.g. `Delete Role`. */
    constructor(page: Page, caption: string) {
        this.page = page;
        this.dialog = page.getByRole('dialog', { name: caption });
    }

    /** The dialog is open; Delete is clicked; returns the answer of the request `call` describes. */
    async confirm(call: ApiCall): Promise<ApiAnswer> {
        await expect(this.dialog).toBeVisible();
        const startedAt = Date.now();
        return answerFrom(await actAndWaitForApi(this.page, call, () => this.dialog.getByRole('button', { name: 'Delete', exact: true }).click()), startedAt);
    }
}
