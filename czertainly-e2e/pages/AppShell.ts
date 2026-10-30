/**
 * AppShell — the signed-in frame around every page (REG-AUTH-01, 08, 99).
 *
 * Provides:
 *   - hash-route navigation, reload and the sidebar links
 *   - a watch over the API answers the page received (for "no 401 / 403 after the sign-in")
 *
 * The sidebar's test id is the signed-in marker. Sign-in and sign-out belong to `LoginPage`, the lock widget to
 * `AccessDeniedWidget`.
 */
import { expect, Locator, Page, Response } from '@playwright/test';
import { Logger } from '../utils/Logger';
import { openHashRoute } from './ui/openHashRoute';
import { SHELL_VISIBLE_MS } from '../utils/regression/timeouts';

const logger = new Logger('AppShell');

/** One `/api/` response the page received: its status and the request it answered. */
export interface SeenApiCall {
    status: number;
    method: string;
    /** Path and query of the request (no origin). */
    path: string;
}

export interface ApiWatch {
    /** Every `/api/` response seen since the watch started. */
    answers(): SeenApiCall[];
    /** The 401 / 403 answers among them. */
    refusals(): SeenApiCall[];
    /**
     * The 200 answers of endpoints that are NOT public: data only a signed-in user may read (public: branding, health, oauth2 providers).
     */
    dataAnswers(): SeenApiCall[];
    stop(): void;
}

/** Endpoints answered without credentials: health, GET branding, the login flow and its provider list. */
const PUBLIC_PATH = /^\/api\/v\d\/(branding|health|oauth2|login|connector\/register)(\/|\?|$)/;

export class AppShell {
    readonly page: Page;
    readonly main: Locator;
    readonly shell: Locator;

    constructor(page: Page) {
        this.page = page;
        this.main = page.locator('main');
        this.shell = page.getByTestId('sidebar-sticky');
    }

    /**
     * Record every `/api/` response of the page until `stop()`. (utils/network/apiRecorder.ts records requests without their
     * status, so it cannot answer "no 401 / 403"; this watch stays until the recorder carries the status.)
     */
    watchApi(): ApiWatch {
        const seen: SeenApiCall[] = [];
        const onResponse = (r: Response): void => {
            const u = new URL(r.url());
            if (!u.pathname.startsWith('/api/')) return;
            seen.push({ status: r.status(), method: r.request().method(), path: `${u.pathname}${u.search}` });
        };
        this.page.on('response', onResponse);
        return {
            answers: () => [...seen],
            refusals: () => seen.filter((a) => a.status === 401 || a.status === 403),
            dataAnswers: () => seen.filter((a) => a.status === 200 && !PUBLIC_PATH.test(a.path)),
            stop: () => {
                this.page.off('response', onResponse);
            },
        };
    }

    /**
     * Open a hash route (a reload when the page is already on it) and wait for the shell; the page's own data calls may still be running
     * (`loadingData` waits for them).
     */
    async goTo(route: string): Promise<void> {
        logger.info(`opening #/${route}`);
        await openHashRoute(this.page, route);
        await expect(this.shell, `the shell is shown on #/${route}`).toBeVisible({ timeout: SHELL_VISIBLE_MS });
    }

    /** Reload the current page and wait for the shell (a lost session lands on the login form instead). */
    async reload(): Promise<void> {
        await this.page.reload();
        await expect(this.shell, 'signed in after the reload').toBeVisible({ timeout: SHELL_VISIBLE_MS });
    }

    /**
     * Runs an action (open a route, reload) and waits until the page has loaded authenticated data it did not have before: a new
     * non-public 200 answer on `watch`. A page that loads nothing fails here with that message, instead of passing on a timer.
     */
    async loadingData<T>(watch: ApiWatch, act: () => Promise<T>): Promise<T> {
        const before = watch.dataAnswers().length;
        const result = await act();
        await expect.poll(() => watch.dataAnswers().length, { message: 'the page loaded authenticated API data', timeout: SHELL_VISIBLE_MS }).toBeGreaterThan(before);
        return result;
    }

    /** No credential form is shown: the user is signed in, not looking at the provider. */
    async assertNoLoginForm(): Promise<void> {
        await expect(this.page.getByRole('textbox', { name: 'Password' }), 'no login form').toHaveCount(0);
        await expect(this.page.getByTestId('login-page'), 'no sign-in page').toHaveCount(0);
    }

    /** The sidebar offers the entry with this test id (a deployment flag or a missing listing hides some entries). */
    async offersSidebarEntry(testId: string): Promise<boolean> {
        return (await this.page.getByTestId(testId).count()) > 0;
    }

    /** The names of the sidebar's links, in document order. */
    async sidebarItems(): Promise<string[]> {
        await expect(this.shell).toBeVisible();
        return (await this.shell.getByRole('link').allInnerTexts()).map((t) => t.replace(/\s+/g, ' ').trim()).filter(Boolean);
    }

    /** The names of the rows a list page shows (the detail links of its table). */
    async listedNames(): Promise<string[]> {
        await expect(this.main).toBeVisible();
        return (await this.main.locator('tbody tr a[href*="/detail/"]').allInnerTexts()).map((t) => t.trim()).filter(Boolean);
    }
}
