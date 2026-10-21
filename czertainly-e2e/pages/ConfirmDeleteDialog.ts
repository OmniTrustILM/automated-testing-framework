/**
 * ConfirmDeleteDialog — the "Delete <Thing>" confirmation of the admin UI (buttons Cancel / Delete), opened from a
 * detail toolbar. `confirm` clicks Delete and returns the status of the DELETE the dialog sends (the wait is registered
 * before the click); the caller asserts it. Used by the role and user pages.
 */
import { expect, Locator, Page } from '@playwright/test';
import { actAndWaitForApi, ApiCall } from './ui/waitForResponse';

export class ConfirmDeleteDialog {
    readonly page: Page;
    readonly dialog: Locator;

    /** `caption`: the dialog's accessible name, e.g. `Delete Role`. */
    constructor(page: Page, caption: string) {
        this.page = page;
        this.dialog = page.getByRole('dialog', { name: caption });
    }

    /** The dialog is open; Delete is clicked; returns the status of the request `call` describes. */
    async confirm(call: ApiCall): Promise<{ status: number }> {
        await expect(this.dialog).toBeVisible();
        const answer = await actAndWaitForApi(this.page, call, () => this.dialog.getByRole('button', { name: 'Delete', exact: true }).click());
        return { status: answer.status() };
    }
}
