/**
 * Unbranded rendering baseline — QA: UI branding, OmniTrustILM/ilm#383.
 *
 * WHAT: captures the same set of pages in the light and the dark theme, on an instance with no
 * branding configured, and compares them against a stored reference set.
 *
 * WHY: the branding work replaces the value of roughly thirty semantic colour tokens that every
 * component resolves through. A mistake there changes every page at once, in both themes, and the
 * only way to see it is to compare the unbranded rendering before and after. The reference set is
 * captured from fe-administrator commit 03922f2d — the last commit before #2087, the first of the
 * Epic's children to change what is rendered.
 *
 * HOW: the local development stack signs the caller in through the proxy's ssl-client-cert header,
 * so each test navigates straight to a hash route. The theme is set by clicking the header toggle
 * until the document element carries (or does not carry) the `dark` class, which is stable across
 * both commits and does not depend on the control's wording or on how many modes it cycles through.
 *
 * Usage:
 *   npm run visual:baseline   # on the pre-branding commit — writes the reference set
 *   npm run visual:compare    # on the commit under test — reports the differences
 */
import { test, expect, type Page } from '@playwright/test';

type Theme = 'light' | 'dark';

/** Pages worth comparing: the ones carrying the most token-driven surface per screen. */
const SCREENS: { name: string; route: string }[] = [
    { name: 'dashboard', route: '#/dashboard' },
    { name: 'certificates-list', route: '#/certificates' },
    { name: 'discoveries-list', route: '#/discoveries' },
    { name: 'connectors-list', route: '#/connectors' },
    { name: 'platform-settings', route: '#/settings' },
    { name: 'users-list', route: '#/users' },
    { name: 'roles-list', route: '#/roles' },
    { name: 'audit-logs', route: '#/auditlogs' },
];

/**
 * Regions to exclude from the comparison. Left empty on purpose: fill it only with what the first
 * comparison proves to be volatile (relative timestamps are the usual candidate), so that nothing
 * is hidden from the diff without a reason.
 */
const MASK_TESTIDS: string[] = [];

async function isDark(page: Page): Promise<boolean> {
    return page.evaluate(() => document.documentElement.classList.contains('dark'));
}

/**
 * Cycles the header theme control until the wanted theme is applied. The control cycles through
 * its modes, so at most three clicks are ever needed; checking the applied class rather than the
 * button label keeps this working on both commits under comparison.
 */
async function setTheme(page: Page, theme: Theme): Promise<void> {
    const toggle = page.getByTestId('theme-toggle');
    await expect(toggle, 'theme toggle should be present in the header').toBeVisible();

    for (let attempt = 0; attempt < 4; attempt++) {
        if ((await isDark(page)) === (theme === 'dark')) return;
        await toggle.click();
        await page.waitForTimeout(150);
    }
    throw new Error(`Could not switch to the ${theme} theme after four clicks on the header control`);
}

/** Waits for the page to settle so the screenshot does not catch a spinner or a half-loaded table. */
async function settle(page: Page): Promise<void> {
    await page.waitForLoadState('networkidle');
    await page.waitForTimeout(500);
}

for (const theme of ['light', 'dark'] as Theme[]) {
    test.describe(`@visual unbranded baseline — ${theme} theme`, () => {
        for (const screen of SCREENS) {
            test(`${screen.name}`, async ({ page }) => {
                await page.goto(screen.route);
                await settle(page);
                await setTheme(page, theme);
                await settle(page);

                await expect(page).toHaveScreenshot(`${screen.name}-${theme}.png`, {
                    fullPage: true,
                    mask: MASK_TESTIDS.map((id) => page.getByTestId(id)),
                });
            });
        }
    });
}
