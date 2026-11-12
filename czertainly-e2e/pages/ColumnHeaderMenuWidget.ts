/**
 * ColumnHeaderMenuWidget — the options menu of one table column.
 *
 * WHAT: the options menu of one table column (a portal outside the table) with its two sort items.
 * WHY: REG-CERT-49 proves that a column the catalogue marks as not sortable shows both items disabled with the
 *       reason and that pressing one is inert.
 * HOW: menu and items by test id with the column id; closed with Escape like every popover; the inert press needs a
 *       forced click because Playwright would wait for the disabled item.
 */
import { expect, Locator, Page } from '@playwright/test';
import { closePopover } from './ui/select';

/** The reason a column that cannot be ordered gives in its menu. */
export const NOT_SORTABLE_REASON = 'This field cannot be used for ordering.';

export class ColumnHeaderMenuWidget {
    readonly menu: Locator;

    constructor(readonly page: Page, readonly columnId: string) {
        this.menu = page.getByTestId(`column-header-menu-${columnId}`);
    }

    private item(name: string): Locator {
        return this.page.getByTestId(`column-header-menu-${this.columnId}-${name}`);
    }

    /** Opens the menu with its trigger in the header. */
    async open(): Promise<void> {
        await this.item('trigger').click();
        await expect(this.menu).toBeVisible();
    }

    /** Closes the menu with Escape (the popover rule of every Radix select and menu). */
    async close(): Promise<void> {
        await closePopover(this.page, this.menu);
    }

    /** Clicks a sort item of the open menu. */
    async clickSortMenuItem(direction: 'asc' | 'desc'): Promise<void> {
        // `force`: an aria-disabled item is not actionable for Playwright, which would wait for it to become enabled; the
        // point is that pressing a disabled item is inert (the admin UI keeps it focusable and prevents the select).
        await this.item(`sort-${direction}`).click({ force: true });
    }

    async assertOpen(): Promise<void> {
        await expect(this.menu).toBeVisible();
    }

    /** Both sort items are `aria-disabled` and the reason text is shown. */
    async assertSortItemsDisabled(reason: string = NOT_SORTABLE_REASON): Promise<void> {
        for (const direction of ['asc', 'desc'] as const) {
            await expect(this.item(`sort-${direction}`), `sort-${direction}`).toHaveAttribute('aria-disabled', 'true');
        }
        await expect(this.item('sort-unavailable')).toHaveText(reason);
    }
}
