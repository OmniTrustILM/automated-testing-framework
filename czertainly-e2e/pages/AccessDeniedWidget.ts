/**
 * AccessDeniedWidget — the lock widget the admin UI shows instead of a page's data when the server refused the call (REG-AUTH-08).
 */
import { expect, Locator, Page } from '@playwright/test';

const ACCESS_DENIED_TITLE = 'Access Denied';
const ACCESS_DENIED_HINT = 'Please contact your admin to get access';

export class AccessDeniedWidget {
    readonly page: Page;

    // Lock widget (the first one when a page shows several)
    readonly lock: Locator;
    readonly lockTitle: Locator;
    readonly lockDetailsIcon: Locator;
    readonly hintTooltip: Locator;

    constructor(page: Page) {
        this.page = page;

        this.lock = page.getByTestId('widget-lock').first();
        this.lockTitle = this.lock.getByRole('heading', { name: ACCESS_DENIED_TITLE, exact: false });
        this.lockDetailsIcon = this.lock.getByTestId('widget-lock-details');
        this.hintTooltip = page.getByText(ACCESS_DENIED_HINT, { exact: true }).first();
    }

    /** `serverMessage` is read from the captured 403 answer, never typed as a literal. */
    async assertShown(serverMessage: string): Promise<void> {
        await expect(this.lock, 'the lock widget is shown').toBeVisible();
        await expect(this.lockTitle, 'title').toContainText(ACCESS_DENIED_TITLE);
        await expect(this.lock, 'the text is the server message').toContainText(serverMessage);
    }

    /** Hovers the details icon, which opens the tooltip with the hint. */
    async openDetails(): Promise<void> {
        await this.lockDetailsIcon.hover();
    }

    async assertHintShown(): Promise<void> {
        await expect(this.hintTooltip, 'the hint in the tooltip').toBeVisible();
    }
}
