/**
 * AppShell — the signed-in frame around every page: routes, the session's profile, the rows a list shows and a watch over the API answers the page got.
 */
import { expect, Locator, Page, Response } from '@playwright/test';
import { Logger } from '../utils/Logger';
import { openHashRoute } from './ui/openHashRoute';
import { SHELL_VISIBLE_MS } from '../utils/regression/timeouts';
import { Profile, readProfile } from '../utils/regression/rbac/identities';

const logger = new Logger('AppShell');

export interface SeenApiCall {
    status: number;
    method: string;
    /** Path and query of the request (no origin). */
    path: string;
}

export interface ApiWatch {
    /** The 401 / 403 answers. */
    refusals(): SeenApiCall[];
    /** The 200 answers of endpoints that are not public: data only a signed-in user may read. */
    dataAnswers(): SeenApiCall[];
    stop(): void;
}

/** Endpoints answered without credentials: health, GET branding, the login flow and its provider list. */
const PUBLIC_PATH = /^\/api\/v\d\/(branding|health|oauth2|login|connector\/register)(\/|\?|$)/;

export class AppShell {
    readonly page: Page;
    readonly main: Locator;

    // The signed-in frame
    readonly shell: Locator;

    // List page
    readonly detailLinks: Locator;
    constructor(page: Page) {
        this.page = page;
        this.main = page.locator('main');

        this.shell = page.getByTestId('sidebar-sticky');

        this.detailLinks = this.main.locator('tbody tr a[href*="/detail/"]');
    }

    /** Records every `/api/` response until `stop()`; the API recorder of utils/network keeps no status, so it cannot answer "no 401". */
    watchApi(): ApiWatch {
        const seen: SeenApiCall[] = [];
        const onResponse = (r: Response): void => {
            const u = new URL(r.url());
            if (!u.pathname.startsWith('/api/')) return;
            seen.push({ status: r.status(), method: r.request().method(), path: `${u.pathname}${u.search}` });
        };
        this.page.on('response', onResponse);
        return {
            refusals: () => seen.filter((a) => a.status === 401 || a.status === 403),
            dataAnswers: () => seen.filter((a) => a.status === 200 && !PUBLIC_PATH.test(a.path)),
            stop: () => {
                this.page.off('response', onResponse);
            },
        };
    }

    /** Opens a hash route (a reload when already on it) and waits for the shell; the page's data calls may still run (`loadingData`). */
    async goTo(route: string): Promise<void> {
        logger.info(`opening #/${route}`);
        await openHashRoute(this.page, route);
        await expect(this.shell, `the shell is shown on #/${route}`).toBeVisible({ timeout: SHELL_VISIBLE_MS });
    }

    /** Runs `act` and waits for a new non-public 200 answer on `watch`: a page that loads nothing fails here instead of passing on a timer. */
    async loadingData<T>(watch: ApiWatch, act: () => Promise<T>): Promise<T> {
        const before = watch.dataAnswers().length;
        const result = await act();
        await expect
            .poll(() => watch.dataAnswers().length, { message: 'the page loaded authenticated API data', timeout: SHELL_VISIBLE_MS })
            .toBeGreaterThan(before);
        return result;
    }

    /** The profile of the session this page holds (its own cookie); throws on a non-200 answer. */
    async profile(): Promise<Profile> {
        return readProfile(this.page.request);
    }

    /** The names of the rows a list page shows (the detail links of its table). */
    async listedNames(): Promise<string[]> {
        await expect(this.main).toBeVisible();
        return (await this.detailLinks.allInnerTexts()).map((t) => t.trim()).filter(Boolean);
    }
}
