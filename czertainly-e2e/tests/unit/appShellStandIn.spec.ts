/**
 * LoginPage's session cookie and `expectRolesAfterSignIn` on a served stand-in page shaped like the admin UI (header user
 * menu, the sidebar). No server: every request of the context is fulfilled by the test (`context.route`); the profile the
 * role check reads comes from a loopback server.
 */
import { Browser, BrowserContext, expect, Page, test } from '@playwright/test';
import { LoginPage } from '../../pages/LoginPage';
import { TestEnv } from '../../utils/env';
import { expectRolesAfterSignIn } from '../../utils/regression/rbac/identities';
import { loopbackServer } from './helpers/loopbackServer';
import { randomBytes } from 'node:crypto';
// Run-scoped generated test passwords: no password-like literal in the file.
const GEN_PW_1 = `qa-${randomBytes(9).toString('base64url')}`;

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

test('LoginPage.readSessionCookie reads the session-id cookie (value and path); a context without one answers undefined', async ({ browser }) => {
    await served(browser, () => ({ body: SHELL }), async (page, context) => {
        expect(await LoginPage.readSessionCookie(page)).toBeUndefined();
        await context.addCookies([{ name: 'session-id', value: 'abc123', url: 'http://127.0.0.1:9/' }, { name: 'other', value: 'x', url: 'http://127.0.0.1:9/' }]);
        expect(await LoginPage.readSessionCookie(page)).toEqual({ value: 'abc123', path: '/' });
        expect(await new LoginPage(page, ENV).sessionCookie()).toBe('abc123');
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
