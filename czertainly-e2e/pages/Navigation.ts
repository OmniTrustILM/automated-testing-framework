import { Locator, Page, expect } from '@playwright/test';

// The expanded sidebar is 260px wide, the collapsed rail 84px.
const EXPANDED_MIN_WIDTH = 200;

const escapeRegExp = (value: string): string => value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

const exactText = (text: string): RegExp => new RegExp(`^\\s*${escapeRegExp(text)}\\s*$`);

/**
 * Locators for the main sidebar (`sidebar-sticky`).
 *
 * Top-level entries are found as an <a>/<button> inside a direct-child <li> of the main <ul>,
 * at any depth, as long as the path from that <li> does not go through a nested <ul> (a submenu).
 * This keeps Dashboard > Certificates apart from top-level Certificates without depending on the
 * wrappers between <li> and the entry: FE wraps each entry in tooltip spans since
 * fe-administrator#2399 (2026-11-03), and had <li> > <a> / <li> > <div> > <a> before.
 */
export class SidebarLocators {
  constructor(readonly root: Locator) {}

  get topLevelList(): Locator {
    return this.root.locator('nav ul').first();
  }

  topLevelEntry(role: 'link' | 'button', name: string): Locator {
    const tag = role === 'link' ? 'a' : 'button';
    return this.topLevelList
      .locator(`:scope > li > ${tag}, :scope > li > :not(ul) ${tag}`)
      .filter({ hasText: exactText(name) });
  }

  /** The <li> of a top-level parent entry (a button with a submenu). */
  parentItem(name: string): Locator {
    // `has` is resolved inside each <li>, so the inner locator must start from the page, not from the sidebar.
    const ownButton = this.root
      .page()
      .locator(':scope > button, :scope > :not(ul) button')
      .filter({ hasText: exactText(name) });
    return this.topLevelList.locator(':scope > li').filter({ has: ownButton });
  }

  submenu(parentName: string): Locator {
    return this.parentItem(parentName).locator(':scope > ul');
  }
}

export class Navigation {
  private readonly sidebarNav: Locator;
  private readonly sidebar: SidebarLocators;

  constructor(private readonly page: Page) {
    this.sidebarNav = this.page.getByTestId('sidebar-sticky');
    this.sidebar = new SidebarLocators(this.sidebarNav);
  }

  private async sidebarWidth(): Promise<number> {
    return this.sidebarNav.evaluate((el) => el.getBoundingClientRect().width);
  }

  /**
   * FE starts with the collapsed rail (menu-size in localStorage). The toggle is labelled
   * "Expand" while collapsed and "Collapse" while expanded since fe-administrator#2399;
   * before it was always "Collapse". Decide by the width, not by the label.
   */
  private async ensureSidebarExpanded(): Promise<void> {
    await expect(this.sidebarNav).toBeVisible();
    if ((await this.sidebarWidth()) >= EXPANDED_MIN_WIDTH) {
      return;
    }

    await this.sidebarNav.getByRole('button', { name: /^(expand|collapse)$/i }).click();
    await expect.poll(() => this.sidebarWidth()).toBeGreaterThanOrEqual(EXPANDED_MIN_WIDTH);
  }

  private async ensureParentExpanded(parentName: string): Promise<void> {
    const parentButton = this.sidebar.topLevelEntry('button', parentName);
    const submenu = this.sidebar.submenu(parentName);

    const isExpanded = async () =>
      submenu.evaluate((el) => parseFloat(getComputedStyle(el).maxHeight || '0') > 0);

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
      await this.ensureParentExpanded(parentButtonName);
      // Scoped to the parent's submenu: names repeat across the sidebar
      // (Dashboard > Certificates vs top-level Certificates).
      targetLink = this.sidebar.submenu(parentButtonName).getByRole('link', {
        name: menuText,
        exact: true,
      });
    } else {
      targetLink = this.sidebar.topLevelEntry('link', menuText);
    }

    await Promise.all([
      this.page.waitForURL(urlHint, { waitUntil: 'domcontentloaded' }),
      targetLink.click(),
    ]);
  }
}
