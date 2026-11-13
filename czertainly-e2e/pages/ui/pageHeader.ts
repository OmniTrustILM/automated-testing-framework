/**
 * pageHeader — the page header of fe-administrator#2426: one primary action button and the other actions in a "More actions" menu,
 * each with the test id `page-action-<id>`. `action` also matches the widget button of the older layout, so one page object serves both.
 */
import { expect, Locator, Page } from '@playwright/test';

export class PageHeader {
    readonly page: Page;
    readonly actions: Locator;
    readonly moreActions: Locator;

    constructor(page: Page) {
        this.page = page;
        this.actions = page.getByTestId('page-header-actions');
        // By attribute, not by role: an open Radix menu hides the rest of the page, its trigger too, from the accessibility tree.
        this.moreActions = this.actions.locator('button[aria-label="More actions"]');
    }

    /** The header action `id`, or `legacy`, the widget button of a build without the header. */
    action(id: string, legacy: Locator): Locator {
        return this.page.getByTestId(`page-action-${id}`).or(legacy);
    }

    /** Opens the "More actions" menu when the rendered page has one and it is closed; a page without the menu is left alone. */
    async openMenu(): Promise<void> {
        if ((await this.moreActions.count()) === 0) return;
        if ((await this.moreActions.getAttribute('aria-expanded')) !== 'true') await this.moreActions.click();
        await expect(this.moreActions).toHaveAttribute('aria-expanded', 'true');
    }

    async closeMenu(): Promise<void> {
        if ((await this.moreActions.count()) === 0 || (await this.moreActions.getAttribute('aria-expanded')) !== 'true') return;
        await this.page.keyboard.press('Escape');
        await expect(this.moreActions).toHaveAttribute('aria-expanded', 'false');
    }

    /** Clicks an action from `action`: a button directly, a menu entry after opening the menu. */
    async click(action: Locator): Promise<void> {
        await expect(action.or(this.moreActions).first()).toBeVisible();
        if (!(await action.isVisible())) await this.openMenu();
        await action.click();
    }
}
