import { Locator, Page, expect } from '@playwright/test';

export class Navigation {
  private readonly sidebarNav: Locator;
  private hasToggledSidebar = false;

  constructor(private readonly page: Page) {
    this.sidebarNav = this.page.getByTestId('sidebar-sticky');
  }

  private async ensureSidebarExpanded(): Promise<void> {
    await expect(this.sidebarNav).toBeVisible();
    if (this.hasToggledSidebar) {
      return;
    }

    const expandButton = this.sidebarNav.getByRole('button', {
      name: /collapse/i,
    });

    if (await expandButton.isVisible()) {
      await expandButton.click();
      await this.page.waitForTimeout(400);
      this.hasToggledSidebar = true;
    }
  }

  private async ensureParentExpanded(parentButton: Locator): Promise<void> {
    const parentContainer = parentButton.locator('..');
    const parentList = parentContainer.locator('ul').first();

    if ((await parentList.count()) === 0) {
      await parentButton.click();
      return;
    }

    const isExpanded = async () =>
      parentList.evaluate((el) => {
        const mh = getComputedStyle(el).maxHeight || '0';
        return parseFloat(mh) > 0;
      });

    if (!(await isExpanded())) {
      await parentButton.click();
    }

    await expect.poll(isExpanded).toBeTruthy();
  }

  async openViaSidebar(
    menuText: string,
    urlHint: RegExp,
    parentButtonName?: string
  ): Promise<void> {
    await this.ensureSidebarExpanded();

    let targetLink: Locator;

    if (parentButtonName) {
      const parentButton = this.sidebarNav.getByRole('button', {
        name: parentButtonName,
        exact: true,
      });
      await this.ensureParentExpanded(parentButton);

      // Scope link search to the parent's children <ul>. This avoids matching
      // duplicate names that live elsewhere in the sidebar (e.g. Dashboard >
      // Certificates vs top-level Certificates after the 2026-06 FE rename).
      const parentContainer = parentButton.locator('..');
      const childrenList = parentContainer.locator('ul').first();
      targetLink = childrenList.getByRole('link', {
        name: menuText,
        exact: true,
      });
    } else {
      // Top-level link: scope to direct-child <li> of the sidebar's main <ul>,
      // which excludes nested submenu links with the same name. Structural
      // (CSS direct-child `>`), not DOM-order dependent — safer than .last().
      const topLevelUl = this.sidebarNav.locator('ul').first();
      targetLink = topLevelUl.locator(':scope > li').locator('> a, > div > a').filter({
        hasText: menuText,
      });
    }

    await Promise.all([
      this.page.waitForURL(urlHint, { waitUntil: 'domcontentloaded' }),
      targetLink.click(),
    ]);
  }
}