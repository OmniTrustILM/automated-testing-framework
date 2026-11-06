/**
 * toast — the toast stack. A refusal is a danger toast that stays; success
 * toasts vanish after six seconds, so assert them in the same step.
 */
import { expect, Locator, Page } from '@playwright/test';
import { Logger } from '../../utils/Logger';

const logger = new Logger('Toast');

const toastCards = (page: Page): Locator => page.getByTestId(/^alert-\d+$/);

export const toast = (page: Page, text: RegExp | string): Locator => toastCards(page).filter({ hasText: text }).first();

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

export async function dismissToasts(page: Page): Promise<void> {
    const dismissAll = page.getByTestId('alerts-container').locator('button', { hasText: /^Dismiss all$/ });
    // A toast can vanish between the check and the click, and the visibility check must not throw: this is a cleanup path.
    if (await dismissAll.isVisible().catch(() => false)) await dismissAll.click().catch(() => {});
    const buttons = toastCards(page).locator('button[aria-label="Dismiss"]');
    for (let i = (await buttons.count()) - 1; i >= 0; i--) await buttons.nth(i).click().catch(() => {});
    try {
        await expect(toastCards(page)).toHaveCount(0, { timeout: 5000 });
    } catch {
        logger.warn(`dismissToasts: ${await toastCards(page).count().catch(() => -1)} toast(s) could not be dismissed within 5 s`);
    }
}
