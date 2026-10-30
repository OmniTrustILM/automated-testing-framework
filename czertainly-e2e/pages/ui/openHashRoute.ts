/**
 * openHashRoute — open a hash route of the admin UI, loading it again when the page is already on it.
 *
 * Opens `/administrator/#/<route>`; when the page is already on exactly that hash, it reloads instead. A navigation to
 * the hash the page is on is no document load and sends no request, so a wait for the API answer of the load would
 * wait for ever.
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
