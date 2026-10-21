/**
 * Toasts (fe-administrator Alerts): every card is `data-testid="alert-<id>"` (message in `alert-message-<id>`). Only
 * danger toasts carry role="alert" and stay until dismissed; success and info toasts have no role and vanish after 6 s.
 * Test ids, not role queries: while a modal dialog is open the toasts outside it are aria-hidden. Assert a success toast
 * in the same step as its action, and prefer the API read-back as the oracle.
 */
import { expect, Locator, Page } from '@playwright/test';
import { Logger } from '../../utils/Logger';

const logger = new Logger('toast');

const toastCards = (page: Page): Locator => page.getByTestId(/^alert-\d+$/);

/** The first toast card whose text matches (any severity). */
export const toast = (page: Page, text: RegExp | string): Locator => toastCards(page).filter({ hasText: text }).first();

/** A toast with the text is shown; `severity` also checks the role (danger: role=alert; success / info: no role). */
export async function assertToast(
    page: Page,
    text: RegExp | string,
    opts: { severity?: 'danger' | 'success' | 'info'; timeout?: number } = {},
): Promise<Locator> {
    const card = toast(page, text);
    await expect(card, `toast ${String(text)}`).toBeVisible({ timeout: opts.timeout });
    if (opts.severity === 'danger') await expect(card).toHaveAttribute('role', 'alert');
    else if (opts.severity) await expect(card).not.toHaveAttribute('role', 'alert');
    return card;
}

/** Close every toast: "Dismiss all" when the stack offers it, else each card's own Dismiss button. */
export async function dismissToasts(page: Page): Promise<void> {
    const dismissAll = page.getByTestId('alerts-container').locator('button', { hasText: /^Dismiss all$/ });
    // A toast can vanish on its own between the check and the click (success toasts time out): such a click may fail.
    // The visibility check must not throw either (two "Dismiss all" buttons, a page already closed): this is a cleanup path.
    if (await dismissAll.isVisible().catch(() => false)) await dismissAll.click().catch(() => {});
    const buttons = toastCards(page).locator('button[aria-label="Dismiss"]');
    for (let i = (await buttons.count()) - 1; i >= 0; i--) await buttons.nth(i).click().catch(() => {});
    try {
        await expect(toastCards(page)).toHaveCount(0, { timeout: 5000 });
    } catch {
        // Not a failure of the step that called it, but a toast left over can cover the next control: say so.
        logger.warn(`dismissToasts: ${await toastCards(page).count().catch(() => -1)} toast(s) could not be dismissed within 5 s`);
    }
}
