/**
 * Navigation — the sidebar navigation (SMK-002, REG-CERT-60).
 * A top-level link is scoped to the first-level items, so a nested link of the same name never matches.
 */
import { Locator, Page, expect } from '@playwright/test';

const EXPANDED_MIN_WIDTH = 200;

/** Scoped to the main sidebar: the flying menu over a collapsed rail renders the same test ids. */
export class Navigation {
  readonly sidebarNav: Locator;

  constructor(private readonly page: Page) {
    this.sidebarNav = this.page.getByTestId('sidebar-sticky');
  }

  entry(testId: string): Locator {
    return this.sidebarNav.getByTestId(testId);
  }

  private async sidebarWidth(): Promise<number> {
    return this.sidebarNav.evaluate((el) => el.getBoundingClientRect().width);
  }

  /** The app starts with the collapsed rail; the toggle label changed (fe-administrator#2399), so decide by the width. */
  private async ensureSidebarExpanded(): Promise<void> {
    await expect(this.sidebarNav).toBeVisible();
    if ((await this.sidebarWidth()) >= EXPANDED_MIN_WIDTH) {
      return;
    }

    await this.sidebarNav.getByRole('button', { name: /^(expand|collapse)$/i }).click();
    await expect.poll(() => this.sidebarWidth()).toBeGreaterThanOrEqual(EXPANDED_MIN_WIDTH);
  }

  async openViaSidebar(testId: string, urlHint: RegExp, parentTestId?: string): Promise<void> {
    await this.ensureSidebarExpanded();

    const target = this.entry(testId);
    if (parentTestId) {
      // A closed submenu is clipped (max-height 0), not hidden, so ask the parent, not the link.
      const parent = this.entry(parentTestId);
      if ((await parent.getAttribute('aria-expanded')) !== 'true') {
        await parent.click();
      }
      await expect(parent).toHaveAttribute('aria-expanded', 'true');
    }

    await Promise.all([
      this.page.waitForURL(urlHint, { waitUntil: 'domcontentloaded' }),
      target.click(),
    ]);
  }
}
