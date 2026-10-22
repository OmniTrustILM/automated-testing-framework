/**
 * AccessDeniedWidget — the lock widget the admin UI shows for a refused call.
 *
 * WHAT: the lock widget the admin UI shows in place of a page's data when the server refused the call: its title,
 *       the server's message and the hint in its tooltip.
 * WHY: REG-AUTH-08 proves that a refused page still loads its shell and shows nothing but the lock;
 *       `assertNoDataRows` is the "nothing leaked" half.
 * HOW: the widget and its details icon by test id; the message is read from the captured 403 answer by the spec and
 *       compared here, never typed as a literal.
 */
import { expect, Locator, Page } from '@playwright/test';

export const ACCESS_DENIED_TITLE = 'Access Denied';
export const ACCESS_DENIED_HINT = 'Please contact your admin to get access';

export class AccessDeniedWidget {
    readonly page: Page;
    readonly main: Locator;
    /** The lock widget (the first one when a page shows several). */
    readonly lock: Locator;

    constructor(page: Page) {
        this.page = page;
        this.main = page.locator('main');
        this.lock = page.getByTestId('widget-lock').first();
    }

    /** The widget is shown with the title and the server's message as its text. */
    async assertShown(serverMessage: string): Promise<void> {
        await expect(this.lock, 'the lock widget is shown').toBeVisible();
        await expect(this.lock.getByRole('heading', { name: ACCESS_DENIED_TITLE, exact: false }), 'title').toContainText(ACCESS_DENIED_TITLE);
        await expect(this.lock, 'the text is the server message').toContainText(serverMessage);
    }

    /** Hovers the details icon of the lock, which opens the tooltip with the hint. */
    async openDetails(): Promise<void> {
        await this.lock.getByTestId('widget-lock-details').hover();
    }

    /** The hint is shown in the tooltip (after `openDetails`). */
    async assertHintShown(): Promise<void> {
        await expect(this.page.getByText(ACCESS_DENIED_HINT, { exact: true }).first(), 'the hint in the tooltip').toBeVisible();
    }

    /** No row of any table inside the main area: nothing leaked next to the lock widget. */
    async assertNoDataRows(): Promise<void> {
        await expect(this.main.locator('tbody tr a[href*="/detail/"]'), 'no data rows').toHaveCount(0);
    }
}
