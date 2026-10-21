/**
 * Unit tests of utils/regression/browserGuards.ts: classification, the allow-list, console noise, write detection,
 * the error texts, and the per-label counts on a static page. A browser context answers every request itself.
 */
import { Browser, BrowserContext, expect, Page, Route, test } from '@playwright/test';
import { BrowserGuards, classify, ignorableConsole, isUnexpectedWrite, isWriteMethod, listShapeProblems, matchAllowed, scanForErrorText } from '../../utils/regression/browserGuards';

test.describe.configure({ timeout: 60_000 });

const failsFast = async (call: Promise<unknown>): Promise<boolean> => call.then(() => false, () => true);
const BASE = 'http://127.0.0.1:9/';

// ------------------------------------------------------------------ a context that is the "server"

interface Served {
    inspection: { status: number; body: unknown };
    inspections: Array<Record<string, unknown>>;
    raProfiles: Array<Record<string, unknown>>;
    raStatus: number;
    html: string;
    extra: (path: string, method: string) => { status: number; body?: unknown } | undefined;
}

async function serve(browser: Browser, served: Served): Promise<{ context: BrowserContext; page: Page }> {
    const context = await browser.newContext({ baseURL: BASE });
    await context.route('**/*', async (route: Route) => {
        const url = new URL(route.request().url());
        const method = route.request().method();
        if (url.pathname === '/api/v1/inspections' && method === 'POST') {
            served.inspections.push(JSON.parse(route.request().postData() ?? '{}'));
            return route.fulfill({ status: served.inspection.status, contentType: 'application/json', body: JSON.stringify(served.inspection.body) });
        }
        if (/\/api\/v1\/authorities\/[^/]+\/raProfiles$/.test(url.pathname) && method === 'POST') {
            served.raProfiles.push(JSON.parse(route.request().postData() ?? '{}'));
            return route.fulfill({ status: served.raStatus, contentType: 'application/json', body: JSON.stringify(served.raStatus < 300 ? { uuid: '11111111-1111-4111-8111-111111111111' } : ['Required attribute Certificate Template not found.']) });
        }
        const extra = served.extra(url.pathname, method);
        if (extra) return route.fulfill({ status: extra.status, contentType: 'application/json', body: JSON.stringify(extra.body ?? {}) });
        if (url.pathname.startsWith('/api/')) return route.fulfill({ status: 404, contentType: 'application/json', body: '{"message":"no"}' });
        return route.fulfill({ contentType: 'text/html; charset=utf-8', body: served.html });
    });
    return { context, page: await context.newPage() };
}

const newServed = (html: string, patch: Partial<Served> = {}): Served => ({
    inspection: { status: 200, body: { containerDigest: 'd', entries: [] } },
    inspections: [],
    raProfiles: [],
    raStatus: 422,
    html,
    extra: () => undefined,
    ...patch,
});

// ------------------------------------------------------------------ BrowserGuards

test('browserGuards (pure): classification, the allow-list, the console noise, write detection, the error texts, the list shapes', () => {
    const allow = [{ method: 'GET', path: /\/v1\/branding$/, status: 404, expected: 'x', reason: 'y' }, { path: /\/v1\/things$/, status: [403, 404], bug: 'core#1', reason: 'z' }];
    expect(classify(200, 'GET', '/api/v1/x', allow)).toBeUndefined();
    expect(classify(500, 'GET', '/api/v1/branding', allow), 'a 5xx is never allowed').toBe('server');
    expect(classify(503, 'POST', '/api/v1/x', allow)).toBe('server');
    expect(classify(404, 'GET', '/api/v1/branding', allow)).toBeUndefined();
    expect(classify(404, 'POST', '/api/v1/branding', allow), 'the method matters').toBe('client');
    expect(classify(401, 'GET', '/api/v1/branding', allow), 'the status matters').toBe('client');
    expect(classify(403, 'PUT', '/api/v1/things', allow)).toBeUndefined();
    expect(classify(422, 'POST', '/api/v1/things', allow)).toBe('client');
    expect(matchAllowed(allow, 'get', '/api/v1/branding', 404)).toBe(allow[0]);
    expect(ignorableConsole('Failed to load resource: the server responded with a status of 404 (Not Found)')).toBe(true);
    expect(ignorableConsole('TypeError: x is not a function')).toBe(false);
    expect(ignorableConsole('boom', [/boom/])).toBe(true);
    expect(isWriteMethod('patch')).toBe(true);
    expect(isWriteMethod('GET')).toBe(false);
    const reads = [/\/v1\/certificates$/];
    expect(isUnexpectedWrite('POST', '/api/v1/certificates', reads)).toBe(false);
    expect(isUnexpectedWrite('POST', '/api/v1/certificates/upload', reads)).toBe(true);
    expect(isUnexpectedWrite('DELETE', '/api/v1/certificates', reads)).toBe(true);
    expect(isUnexpectedWrite('GET', '/api/v1/certificates', reads)).toBe(false);
    expect(scanForErrorText('All fine')).toEqual([]);
    expect(scanForErrorText('An UNEXPECTED ERROR occurred. Internal Server Error')).toEqual(['unexpected error', 'internal server error']);
    expect(scanForErrorText('value: undefined')).toEqual(['undefined']);
    expect(scanForErrorText('Undefined behaviour is fine, undefinedX too')).toEqual([]);
    expect(scanForErrorText('clean chrome', 'table says internal server error and undefined')).toEqual(['undefined']);
    expect(listShapeProblems('bare', [])).toEqual([]);
    expect(listShapeProblems('bare', {})).toEqual(['not a bare array']);
    expect(listShapeProblems('single', { a: 1 })).toEqual([]);
    expect(listShapeProblems('single', [])).toEqual(['not a single object']);
    expect(listShapeProblems('paged', { items: [1, 2], itemsPerPage: 10, pageNumber: 1, totalPages: 1, totalItems: 2 })).toEqual([]);
    expect(listShapeProblems('paged', { certificates: [], itemsPerPage: 10, pageNumber: 1, totalPages: 0, totalItems: 0 })).toEqual([]);
    expect(listShapeProblems('paged', { items: [], other: [], itemsPerPage: 10, pageNumber: 1, totalPages: 0, totalItems: 0 })).toEqual(['2 array members (exactly one list of rows expected)']);
    expect(listShapeProblems('paged', { items: [1, 2, 3], itemsPerPage: 2, pageNumber: 1, totalPages: 2, totalItems: 3 })).toEqual(['3 rows on a page of 2']);
    expect(listShapeProblems('paged', { items: [1, 2], itemsPerPage: 10, pageNumber: 1, totalPages: 1, totalItems: 1 })).toEqual(['2 rows but totalItems 1']);
    expect(listShapeProblems('paged', { items: [], itemsPerPage: '10' })).toEqual(['itemsPerPage is not a number', 'pageNumber is not a number', 'totalPages is not a number', 'totalItems is not a number']);
    expect(listShapeProblems('paged', [])).toEqual(['not an object']);
});

const GUARD_APP = `<!doctype html><html><body><main><h1>Page</h1><div id="out"></div>
<table><tbody><tr><td>Internal server error. (a log line in a table)</td></tr></tbody></table></main>
<script>
  const call = (method, path) => fetch(path, { method }).catch(() => {});
  window.run = async (what) => {
    if (what === 'ok') await call('GET', '/api/v1/ok');
    if (what === 'branding') await call('GET', '/api/v1/branding');
    if (what === 'client') await call('GET', '/api/v1/missing');
    if (what === 'server') await call('GET', '/api/v1/boom');
    if (what === 'write') { await call('PATCH', '/api/v1/things/1'); await call('POST', '/api/v1/certificates/upload'); await call('POST', '/api/v1/certificates'); }
    if (what === 'console') console.error('qa: something broke');
    if (what === 'pageerror') setTimeout(() => { throw new Error('qa: uncaught'); }, 0);
    if (what === 'text') document.getElementById('out').textContent = 'An unexpected error occurred. total: undefined';
    if (what === 'external') await fetch('http://example.invalid/x').catch(() => {});
  };
</script></body></html>`;

test('BrowserGuards counts console errors, page errors, 5xx, unexpected 4xx, writes and error text per label; allowed 4xx and table text are not findings', async ({ browser }) => {
    const served = newServed(GUARD_APP, {
        extra: (path) => (path === '/api/v1/ok' ? { status: 200 } : path === '/api/v1/branding' ? { status: 404 } : path === '/api/v1/boom' ? { status: 500 } : path === '/api/v1/certificates' ? { status: 200 } : path.startsWith('/api/v1/things') ? { status: 204 } : path === '/api/v1/certificates/upload' ? { status: 201 } : undefined),
    });
    const { context, page } = await serve(browser, served);
    try {
        await page.goto(BASE);
        const guards = new BrowserGuards(page, {
            allow: [{ method: 'GET', path: /\/v1\/branding$/, status: 404, expected: 'unbranded tier', reason: 'by design' }],
            readPosts: [/\/v1\/certificates$/],
        }).start();
        const run = async (label: string, what: string) => {
            guards.mark(label);
            await page.evaluate((w) => (window as unknown as { run(x: string): Promise<void> }).run(w), what);
            await guards.settle(2_000);
        };
        await run('clean', 'ok');
        await run('allowed', 'branding');
        await run('client', 'client');
        await run('server', 'server');
        await run('write', 'write');
        await run('console', 'console');
        await run('pageerror', 'pageerror');
        await run('external', 'external');
        guards.mark('text');
        await page.evaluate(() => (window as unknown as { run(x: string): Promise<void> }).run('text'));
        expect(await guards.scanText()).toEqual(['unexpected error', 'undefined']);

        expect(guards.counts('clean')).toMatchObject({ console: 0, pageerror: 0, server: 0, client: 0, failed: 0, text: 0, write: 0 });
        expect(guards.counts('allowed'), 'the allow-listed 404 is no finding (and its console line is the browser\'s own noise)').toMatchObject({ client: 0, console: 0 });
        expect(guards.all({ label: 'client' }).map((f) => f.text)).toEqual(['GET /api/v1/missing answered 404']);
        expect(guards.all({ label: 'server' }).map((f) => f.text)).toEqual(['GET /api/v1/boom answered 500']);
        expect(guards.all({ label: 'write', counter: 'write' }).map((f) => f.text)).toEqual(['PATCH /api/v1/things/1', 'POST /api/v1/certificates/upload']);
        expect(guards.all({ label: 'console' }).map((f) => `${f.counter}: ${f.text}`)).toEqual(['console: qa: something broke']);
        expect(guards.all({ label: 'pageerror' }).map((f) => f.counter)).toEqual(['pageerror']);
        expect(guards.all({ label: 'external' }), 'a request to another origin is not a finding of the page').toEqual([]);
        expect(guards.all({ label: 'text' }).map((f) => f.text)).toEqual(['visible text "unexpected error"', 'visible text "undefined"']);
        expect(guards.allowedSeen()).toHaveLength(1);
        // The table's "Internal server error." line is data, not chrome: no finding under 'clean' for it.
        guards.mark('clean2');
        await page.evaluate(() => { document.getElementById('out')!.textContent = ''; });
        expect(await guards.scanText()).toEqual([]);
        // assertZero names every finding of a label, and passes for a clean one.
        guards.assertZero('clean');
        expect(await failsFast(Promise.resolve().then(() => guards.assertZero('client')))).toBe(true);
        expect(await failsFast(Promise.resolve().then(() => guards.assertZero()))).toBe(true);
        guards.dispose();
        const before = guards.all().length;
        await page.evaluate(() => (window as unknown as { run(x: string): Promise<void> }).run('client'));
        await page.evaluate(() => (window as unknown as { run(x: string): Promise<void> }).run('console'));
        expect(guards.all().length, 'disposed: nothing more is counted').toBe(before);
    } finally {
        await context.close();
    }
});
