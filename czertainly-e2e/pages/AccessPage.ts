/**
 * AccessPage — the signed-in shell as a user with (or without) permissions sees it (auth-rbac area, B2: REG-AUTH-02 and the
 * second-identity rows REG-AUTH-08 / 10; phase-05 B2.1).
 *
 * - Navigation by hash route (`administrator/#/<route>`: dashboard, certificates, raprofiles, roles, users, credentials —
 *   fe-administrator `AppRouter`, `Resource.<X>.toLowerCase()`), the shell marker is `sidebar-sticky` (phase-04 A12).
 * - The session cookie (`session-id`, path `/`, core `CookieConfig`) of the browser context.
 * - `watchApi()`: every `/api/` response of the page, so a spec can assert "zero 401 / 403" or "the list call is 403, never
 *   500" from what the browser really received (the FE has no route guards: a refused page still loads its shell and shows
 *   the lock widget, rules H1 / H2).
 * - The lock widget of a refused call (`widget-lock`, FE `WidgetLock` + `getLockWidgetObject`): title "Access Denied" for code
 *   ACCESS_DENIED, text = the server message, the hint "Please contact your admin to get access" in the tooltip of
 *   `widget-lock-details` (not visible text).
 * - The sidebar item names.
 */
import { expect, Locator, Page, Response } from '@playwright/test';
import { Logger } from '../utils/Logger';
import { parseProfile, rolesAfterSignInProblem } from '../utils/regression/identities';

const logger = new Logger('AccessPage');

export interface ApiAnswer {
    status: number;
    method: string;
    /** Path and query of the request (no origin). */
    path: string;
}

export interface ApiWatch {
    /** Every `/api/` response seen since the watch started. */
    answers(): ApiAnswer[];
    /** The 401 / 403 answers among them. */
    refusals(): ApiAnswer[];
    /** The 200 answers of endpoints that are NOT public: data only a signed-in user may read (public: branding, health, oauth2 providers). */
    dataAnswers(): ApiAnswer[];
    stop(): void;
}

export interface SessionCookie {
    value: string;
    path: string;
}

/** Endpoints answered without credentials (auth-rbac G1: health, GET branding, the login flow and its provider list). */
const PUBLIC_PATH = /^\/api\/v\d\/(branding|health|oauth2|login|connector\/register)(\/|\?|$)/;

export const LOCK_TITLE_TEXT = 'Access Denied';
export const LOCK_HINT_TEXT = 'Please contact your admin to get access';

export class AccessPage {
    readonly page: Page;
    readonly main: Locator;
    readonly shell: Locator;

    constructor(page: Page) {
        this.page = page;
        this.main = page.locator('main');
        this.shell = page.getByTestId('sidebar-sticky');
    }

    /** Record every `/api/` response of the page until `stop()`. */
    watchApi(): ApiWatch {
        const seen: ApiAnswer[] = [];
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

    /** Open a hash route and wait for the shell; the page's own data calls may still be running (see `settle`). */
    async visit(route: string): Promise<void> {
        logger.info(`Visiting #/${route}`);
        await this.page.goto(`administrator/#/${route}`);
        await expect(this.shell, `the shell is shown on #/${route}`).toBeVisible({ timeout: 30_000 });
    }

    /** Reload the current page and wait for the shell (a lost session lands on the login form instead). */
    async reload(): Promise<void> {
        await this.page.reload();
        await expect(this.shell, 'signed in after the reload').toBeVisible({ timeout: 30_000 });
    }

    /**
     * Wait for the page's data calls to finish: the network is idle (a state, not a time). A page that never goes idle
     * (long polling) is not an error here: the caller asserts what it needs on the answers it has.
     */
    async settle(timeout = 10_000): Promise<void> {
        await this.page.waitForLoadState('networkidle', { timeout }).catch(() => undefined);
    }

    /** The browser context's session cookie, or undefined (no sign-in, or signed out). */
    async sessionCookie(): Promise<SessionCookie | undefined> {
        const cookie = (await this.page.context().cookies()).find((c) => c.name === 'session-id');
        return cookie ? { value: cookie.value, path: cookie.path } : undefined;
    }

    /**
     * After the UI sign-in: the signed-in user's profile (its own session, `page.request`) holds exactly the roles the API barrier
     * set. A mismatch is the sync policy rewriting roles at sign-in (SYNC_POLICY=sync-data, DevOps request 4, core#2226), and fails
     * with that message instead of surfacing later as an RBAC failure of the fixture (Fable F6).
     */
    async assertRolesAfterSignIn(expectedRoleUuids: string[]): Promise<void> {
        const res = await this.page.request.get('/api/v1/auth/profile');
        expect(res.status(), 'the signed-in user\'s profile').toBe(200);
        const problem = rolesAfterSignInProblem(parseProfile(await res.json()).roles.map((r) => r.uuid), expectedRoleUuids);
        if (problem) throw new Error(problem);
    }

    /** No credential form is shown: the user is signed in, not looking at the provider. */
    async assertNoLoginForm(): Promise<void> {
        await expect(this.page.getByRole('textbox', { name: 'Password' }), 'no login form').toHaveCount(0);
        await expect(this.page.getByTestId('login-page'), 'no sign-in page').toHaveCount(0);
    }

    // ------------------------------------------------------------------ the lock widget

    get lock(): Locator {
        return this.page.getByTestId('widget-lock').first();
    }

    /**
     * A refused page: the lock widget is shown with the title "Access Denied", the server's message as its text and the
     * hint in its tooltip; no data table rows are shown next to it (rules H2, AR-700).
     */
    async assertLocked(serverMessage: string): Promise<void> {
        await expect(this.lock, 'the lock widget is shown').toBeVisible();
        await expect(this.lock.getByRole('heading', { name: LOCK_TITLE_TEXT, exact: false }), 'title').toContainText(LOCK_TITLE_TEXT);
        await expect(this.lock, 'the text is the server message').toContainText(serverMessage);
        const details = this.lock.getByTestId('widget-lock-details');
        await details.hover();
        await expect(this.page.getByText(LOCK_HINT_TEXT, { exact: true }).first(), 'the hint in the tooltip').toBeVisible();
    }

    /** No row of any table inside the main area: nothing leaked next to the lock widget. */
    async assertNoDataRows(): Promise<void> {
        await expect(this.main.locator('tbody tr a[href*="/detail/"]'), 'no data rows').toHaveCount(0);
    }

    // ------------------------------------------------------------------ sidebar and lists

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
