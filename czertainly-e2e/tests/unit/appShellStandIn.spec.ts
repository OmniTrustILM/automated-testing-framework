/**
 * AppShell, AccessDeniedWidget and LoginPage on served stand-in pages shaped like the admin UI (header user menu,
 * `login-page`, `widget-lock` with its tooltip, the sidebar). No server: every request of the context is fulfilled by the
 * test (`context.route`), and each assertion is shown passing on the right page and failing on a wrong one.
 */
import { Browser, BrowserContext, expect, Page, test } from '@playwright/test';
import { AccessDeniedWidget } from '../../pages/AccessDeniedWidget';
import { AppShell } from '../../pages/AppShell';
import { LoginPage } from '../../pages/LoginPage';
import { TestEnv } from '../../utils/env';
import { expectRolesAfterSignIn } from '../../utils/regression/rbac/identities';
import { loopbackServer } from './helpers/loopbackServer';
import { randomBytes } from 'node:crypto';
// Run-scoped generated test passwords (merge follow-up 2026-10-15): no password-like literal in the file.
const GEN_PW_1 = `qa-${randomBytes(9).toString('base64url')}`;

const failsFast = async (call: Promise<unknown>): Promise<boolean> => call.then(() => false, () => true);

const ENV = { baseUrl: 'http://127.0.0.1:9/', authMode: 'local', username: 'qa-user', password: GEN_PW_1, localAuthProviderName: 'Internal' } as unknown as TestEnv;

/** A context whose every request is answered by `serve(path)` (document or JSON), so a test controls what "the server" says. */
async function served(browser: Browser, serve: (path: string, method: string) => { status?: number; type?: string; body: string }, body: (page: Page, context: BrowserContext) => Promise<void>): Promise<void> {
    const context = await browser.newContext({ baseURL: 'http://127.0.0.1:9/' });
    try {
        await context.route('**/*', (route) => {
            const url = new URL(route.request().url());
            const a = serve(url.pathname + url.search, route.request().method());
            return route.fulfill({ status: a.status ?? 200, contentType: a.type ?? 'text/html', body: a.body });
        });
        await body(await context.newPage(), context);
    } finally {
        await context.close();
    }
}

const SHELL = `<!doctype html><html><body>
  <header data-testid="header"><button data-testid="user-menu">qa-user</button><div id="menu" role="menu" style="display:none"><a role="menuitem" href="/administrator/login">Log out</a></div></header>
  <nav data-testid="sidebar-sticky"><ul><li><a href="#/dashboard">Dashboard</a></li><li><a href="#/certificates">Certificates</a></li><li><a href="#/raprofiles">RA Profiles</a></li></ul></nav>
  <main><section><h5>Dashboard</h5></section></main>
  <script>document.querySelector('[data-testid=user-menu]').addEventListener('click', () => { document.getElementById('menu').style.display = 'block'; });</script>
  </body></html>`;
const LOGIN = `<!doctype html><html><body><div data-testid="login-page"><h1>Login with</h1><button onclick="location.href='/kc/form'">Internal</button></div></body></html>`;
const FORM = `<!doctype html><html><body><label>Username <input type="text"></label><label>Password <input type="password"></label><button>Sign in</button></body></html>`;

test('LoginPage.logOut: the header menu offers Log out, clicking it lands on the sign-in page with no app shell', async ({ browser }) => {
    await served(browser, (path) => ({ body: path.startsWith('/administrator/login') ? LOGIN : SHELL }), async (page) => {
        const login = new LoginPage(page, ENV);
        await page.goto('/administrator/');
        await login.logOut('qa-user');
        await login.assertLoggedOut(2_000);
        await expect(page.getByTestId('login-page')).toBeVisible();
    });
});

test('LoginPage.logOut: a menu without Log out fails fast; assertLoggedOut fails while the shell is still there', async ({ browser }) => {
    await served(browser, () => ({ body: SHELL.replace('Log out', 'Settings') }), async (page) => {
        const login = new LoginPage(page, ENV);
        await page.goto('/administrator/');
        expect(await failsFast(login.openUserMenu('qa-user'))).toBe(true);
        expect(await failsFast(login.assertLoggedOut(1_500))).toBe(true);
    });
});

test('LoginPage.goToAppForCredentials and assertCredentialPrompt: a provider choice leads to the credential form; a silent single sign-on (the shell comes back) fails', async ({ browser }) => {
    await served(browser, (path) => ({ body: path.startsWith('/kc/form') ? FORM : path.startsWith('/administrator') ? LOGIN : FORM }), async (page) => {
        // `goto()` opens BASE_URL + administrator/: the env's baseUrl is the fake origin.
        const login = new LoginPage(page, { ...ENV, baseUrl: 'http://127.0.0.1:9/' } as TestEnv);
        await login.goToAppForCredentials(5_000);
        await login.assertCredentialPrompt(5_000);
        await expect(page.getByRole('textbox', { name: 'Username' })).toBeVisible();
    });
    await served(browser, () => ({ body: SHELL }), async (page) => {
        const login = new LoginPage(page, ENV);
        await login.goToAppForCredentials(1_500);
        expect(await failsFast(login.assertCredentialPrompt(1_500)), 'silent SSO is a failure').toBe(true);
    });
});

test('AppShell.watchApi: counts /api answers, separates refusals and non-public data answers, stops on request', async ({ browser }) => {
    const api = (path: string): { status: number; body: string; type: string } | undefined => {
        if (path === '/api/v1/roles') return { status: 403, body: '{"message":"x"}', type: 'application/json' };
        if (path === '/api/v1/certificates') return { status: 200, body: '[]', type: 'application/json' };
        if (path === '/api/v1/branding') return { status: 200, body: '{}', type: 'application/json' };
        if (path.startsWith('/api/v2/oauth2/providers')) return { status: 200, body: '[]', type: 'application/json' };
        if (path === '/api/v1/auth/profile') return { status: 401, body: '', type: 'application/json' };
        return undefined;
    };
    await served(browser, (path) => api(path) ?? { body: SHELL }, async (page) => {
        const access = new AppShell(page);
        await page.goto('/administrator/');
        const watch = access.watchApi();
        for (const p of ['/api/v1/roles', '/api/v1/certificates', '/api/v1/branding', '/api/v2/oauth2/providers', '/api/v1/auth/profile']) {
            await page.evaluate((u) => fetch(u).then((r) => r.status), p);
        }
        expect(watch.answers().map((a) => [a.path, a.status])).toEqual([
            ['/api/v1/roles', 403], ['/api/v1/certificates', 200], ['/api/v1/branding', 200], ['/api/v2/oauth2/providers', 200], ['/api/v1/auth/profile', 401],
        ]);
        expect(watch.refusals().map((a) => a.path)).toEqual(['/api/v1/roles', '/api/v1/auth/profile']);
        expect(watch.dataAnswers().map((a) => a.path), 'public endpoints are not data').toEqual(['/api/v1/certificates']);
        watch.stop();
        await page.evaluate(() => fetch('/api/v1/roles'));
        expect(watch.answers()).toHaveLength(5);
    });
});

test('LoginPage.readSessionCookie reads the session-id cookie (value and path); a context without one answers undefined', async ({ browser }) => {
    await served(browser, () => ({ body: SHELL }), async (page, context) => {
        expect(await LoginPage.readSessionCookie(page)).toBeUndefined();
        await context.addCookies([{ name: 'session-id', value: 'abc123', url: 'http://127.0.0.1:9/' }, { name: 'other', value: 'x', url: 'http://127.0.0.1:9/' }]);
        expect(await LoginPage.readSessionCookie(page)).toEqual({ value: 'abc123', path: '/' });
        expect(await new LoginPage(page, ENV).sessionCookie()).toBe('abc123');
    });
});

/** The lock widget as the FE renders it: title, text, an info button whose tooltip carries the hint. */
const LOCKED = (text: string) => `<!doctype html><html><body><nav data-testid="sidebar-sticky"><a href="#/roles">Roles</a></nav><main>
  <section><h5>List of Roles</h5>
  <div data-testid="widget-lock"><h5>Access Denied<button data-testid="widget-lock-details" aria-label="Show details" id="info">i</button></h5><p>${text}</p></div>
  </section></main><script>
  document.getElementById('info').addEventListener('mouseover', () => { const t = document.createElement('div'); t.setAttribute('role', 'tooltip'); t.textContent = 'Please contact your admin to get access'; document.body.appendChild(t); });
  </script></body></html>`;
const MESSAGE = "Access Denied. Required 'List' permission for 'Role'";

test('AccessDeniedWidget.assertShown, openDetails and assertHintShown: title, the server message as text and the hint in the tooltip; a wrong message or a missing widget fails', async ({ browser }) => {
    await served(browser, () => ({ body: LOCKED(MESSAGE) }), async (page) => {
        const denied = new AccessDeniedWidget(page);
        await page.goto('/administrator/');
        await denied.assertShown(MESSAGE);
        await denied.openDetails();
        await denied.assertHintShown();
        await denied.assertNoDataRows();
        expect(await failsFast(denied.assertShown("Access Denied. Required 'Detail' permission for 'Role'"))).toBe(true);
    });
    await served(browser, () => ({ body: SHELL }), async (page) => {
        await page.goto('/administrator/');
        expect(await failsFast(new AccessDeniedWidget(page).assertShown(MESSAGE))).toBe(true);
    });
});

test('AccessDeniedWidget.assertNoDataRows fails when a table row is shown next to the lock; listedNames and sidebarItems read the page', async ({ browser }) => {
    const withRows = `<!doctype html><html><body><nav data-testid="sidebar-sticky"><a href="#/dashboard">Dashboard</a><a href="#/certificates">Certificates</a></nav>
      <main><table><tbody><tr><td><a href="#/certificates/detail/1">qa-reg-x-rbac-cg1</a></td></tr><tr><td><a href="#/certificates/detail/2">qa-reg-x-rbac-cg12</a></td></tr></tbody></table></main></body></html>`;
    await served(browser, () => ({ body: withRows }), async (page) => {
        const access = new AppShell(page);
        await page.goto('/administrator/');
        expect(await access.listedNames()).toEqual(['qa-reg-x-rbac-cg1', 'qa-reg-x-rbac-cg12']);
        expect(await access.sidebarItems()).toEqual(['Dashboard', 'Certificates']);
        expect(await failsFast(new AccessDeniedWidget(page).assertNoDataRows())).toBe(true);
    });
});

test('AppShell.goTo and reload wait for the shell; a lost session (the login page) fails; assertNoLoginForm sees a password field', async ({ browser }) => {
    await served(browser, (path) => ({ body: path.startsWith('/administrator') ? SHELL : LOGIN }), async (page) => {
        const access = new AppShell(page);
        await access.goTo('roles');
        await access.reload();
        await access.assertNoLoginForm();
    });
    await served(browser, () => ({ body: FORM }), async (page) => {
        const access = new AppShell(page);
        await page.goto('/administrator/');
        expect(await failsFast(access.assertNoLoginForm())).toBe(true);
    });
});

test('expectRolesAfterSignIn: the signed-in profile holds exactly the roles the API set; a rewritten role list fails with the sync-policy message', async ({ browser }) => {
    const ROLE = '00000000-0000-4000-8000-0000000000f1';
    let held = [ROLE];
    // `page.request` is an API request context (not intercepted by `context.route`): a real loopback server answers the profile.
    const server = await loopbackServer((a) => (a.url === '/api/v1/auth/profile' ? {
        status: 200,
        body: { uuid: '00000000-0000-4000-8000-000000000001', username: 'qa-user', enabled: true, roles: held.map((uuid) => ({ uuid, name: 'r' })), permissions: { allowedListings: [], allowedActions: [] } },
    } : undefined));
    const context = await browser.newContext({ baseURL: server.origin });
    try {
        const page = await context.newPage();
        await expectRolesAfterSignIn(page, [ROLE]);
        held = [];
        const failure = await expectRolesAfterSignIn(page, [ROLE]).then(() => undefined, (e: Error) => e.message);
        expect(failure).toMatch(/SYNC_POLICY=sync-data.*core#2226.*not an RBAC failure/);
    } finally {
        await context.close();
        await server.close();
    }
});
