/**
 * openHashRoute — opens a hash route of the admin UI, reloading when the
 * page is already on it (no document load, so no API answer to wait for).
 */
import type { Page } from '@playwright/test';

export async function openHashRoute(page: Page, route: string): Promise<void> {
    const hash = `#/${route}`;
    let current = '';
    try {
        current = new URL(page.url()).hash;
    } catch {
        current = ''; // about:blank and the like have no hash
    }
    if (current === hash) {
        await page.reload();
        return;
    }
    await page.goto(`/administrator/${hash}`);
}
