/**
 * What a page did wrong while a test looked elsewhere, counted per labelled step: console errors, uncaught page
 * errors, 5xx answers, 4xx answers no allow-list entry covers, failed requests, unexpected writes and error text on the
 * page. It only listens (`page.on`); it changes no request and no route.
 */
import { expect, Locator, Page, Request, Response } from '@playwright/test';

/**
 * A 4xx a test tolerates, with the reason it is tolerated: either a bug the page causes today (`bug`: `<repo>#<n>`; REG-CERT-60
 * allow-list, every entry stands for a filed defect) or a refusal the test provokes on purpose (`expected`: the rule that
 * makes the status the oracle, e.g. REG-CERT-63's 422 of the inspection). A bare 4xx is never allowed.
 */
export type AllowedClientError = {
    /** Upper-case HTTP method; absent = any. */
    method?: string;
    /** Matches the request path without its query (`/api/v1/...`). */
    path: RegExp;
    /** The statuses covered (all 4xx; a 5xx is never allowed). */
    status: number | number[];
    reason: string;
} & ({ bug: string; expected?: never } | { expected: string; bug?: never });

export type Counter = 'console' | 'pageerror' | 'server' | 'client' | 'failed' | 'text' | 'write';

export interface Finding {
    counter: Counter;
    /** The step label current when it happened (a page name). */
    label: string;
    text: string;
}

export interface BrowserGuardOptions {
    allow?: AllowedClientError[];
    /** Extra console messages to ignore (regexps over the message text). */
    ignoreConsole?: RegExp[];
    /** The page's origin; default: the origin of the page's URL at the time of each event. */
    origin?: string;
    /**
     * The POST paths (regexps over the request path) the page may send because they only READ (list and search requests).
     * Given → every other same-origin API write counts as a `write` finding; absent → writes are not watched.
     */
    readPosts?: RegExp[];
}

const HTTP_NOISE = /^Failed to load resource: the server responded with a status of \d{3}/;

/** True for a console error that only repeats a failed request (counted by the response counters). */
export const ignorableConsole = (text: string, extra: RegExp[] = []): boolean => HTTP_NOISE.test(text) || extra.some((re) => re.test(text));

/** Which allow-list entry covers the response, if any. */
export function matchAllowed(allow: AllowedClientError[], method: string, path: string, status: number): AllowedClientError | undefined {
    return allow.find((a) => (!a.method || a.method.toUpperCase() === method.toUpperCase()) && a.path.test(path) && [a.status].flat().includes(status));
}

/** The class of a same-origin response: `server` (>= 500), `client` (4xx outside the allow-list) or nothing. */
export function classify(status: number, method: string, path: string, allow: AllowedClientError[]): 'server' | 'client' | undefined {
    if (status >= 500) return 'server';
    if (status >= 400 && !matchAllowed(allow, method, path, status)) return 'client';
    return undefined;
}

/**
 * The error texts a page must not show: "unexpected error", "Internal server error" (any case) and the word `undefined`
 * (exact, lower case: it is what a template prints for a missing value). `chrome` is the text outside data tables (the
 * error phrases are searched there only: a table may list a log line that says "Internal server error." by design),
 * `all` the whole text (`undefined` is searched there: a rendered missing value). Returns the distinct matches.
 */
export function scanForErrorText(chrome: string, all: string = chrome): string[] {
    const found = new Set<string>();
    for (const m of chrome.matchAll(/unexpected error|internal server error/gi)) found.add(m[0].toLowerCase());
    if (/\bundefined\b/.test(all)) found.add('undefined');
    return [...found];
}

/** What the answer of a page's list request must look like: one object (a dashboard, a settings page), a bare array, or a paged object. */
export type ListShape = 'single' | 'bare' | 'paged';

/**
 * The shape problems of a list answer (pure; empty = fine). `paged`: an object with numeric `itemsPerPage`, `pageNumber`,
 * `totalPages`, `totalItems` and exactly one array of rows, never more rows than `itemsPerPage` or `totalItems`.
 */
export function listShapeProblems(shape: ListShape, body: unknown): string[] {
    if (shape === 'bare') return Array.isArray(body) ? [] : ['not a bare array'];
    if (shape === 'single') return body && typeof body === 'object' && !Array.isArray(body) ? [] : ['not a single object'];
    if (!body || typeof body !== 'object' || Array.isArray(body)) return ['not an object'];
    const o = body as Record<string, unknown>;
    const problems: string[] = [];
    for (const k of ['itemsPerPage', 'pageNumber', 'totalPages', 'totalItems']) if (typeof o[k] !== 'number') problems.push(`${k} is not a number`);
    const arrays = Object.entries(o).filter(([, v]) => Array.isArray(v));
    if (arrays.length !== 1) problems.push(`${arrays.length} array members (exactly one list of rows expected)`);
    else {
        const rows = arrays[0][1] as unknown[];
        if (typeof o.itemsPerPage === 'number' && o.itemsPerPage > 0 && rows.length > o.itemsPerPage) problems.push(`${rows.length} rows on a page of ${o.itemsPerPage}`);
        if (typeof o.totalItems === 'number' && rows.length > o.totalItems) problems.push(`${rows.length} rows but totalItems ${o.totalItems}`);
    }
    return problems;
}

/** True for a method that changes state. */
export const isWriteMethod = (method: string): boolean => /^(PUT|PATCH|DELETE)$/i.test(method);

/** True when a same-origin API request is a write the sweep did not provoke on purpose (see `BrowserGuardOptions.readPosts`). */
export function isUnexpectedWrite(method: string, path: string, readPosts: RegExp[]): boolean {
    if (isWriteMethod(method)) return true;
    return /^POST$/i.test(method) && !readPosts.some((re) => re.test(path));
}

const pathOf = (url: string): string => {
    try {
        return new URL(url).pathname;
    } catch {
        return url.split('?')[0];
    }
};

const originOf = (url: string): string => {
    try {
        return new URL(url).origin;
    } catch {
        return '';
    }
};

export class BrowserGuards {
    private readonly findings: Finding[] = [];
    private label = '(none)';
    private started = false;
    private readonly allow: AllowedClientError[];
    private readonly ignoreConsole: RegExp[];
    private readonly pinnedOrigin?: string;
    private readonly readPosts?: RegExp[];
    private readonly used = new Set<AllowedClientError>();

    private readonly onConsole = (msg: { type(): string; text(): string }): void => {
        if (msg.type() !== 'error') return;
        const text = msg.text();
        if (ignorableConsole(text, this.ignoreConsole)) return;
        this.add('console', text.slice(0, 300));
    };

    private readonly onPageError = (err: Error): void => {
        this.add('pageerror', String(err.message ?? err).slice(0, 300));
    };

    private readonly onResponse = (res: Response): void => {
        const req = res.request();
        if (!this.sameOrigin(req.url())) return;
        const path = pathOf(req.url());
        const status = res.status();
        const entry = status >= 400 && status < 500 ? matchAllowed(this.allow, req.method(), path, status) : undefined;
        if (entry) this.used.add(entry);
        const kind = classify(status, req.method(), path, this.allow);
        if (kind) this.add(kind, `${req.method()} ${path} answered ${status}`);
    };

    private readonly onRequest = (req: Request): void => {
        if (!this.readPosts || !this.sameOrigin(req.url())) return;
        const path = pathOf(req.url());
        if (!/\/api\//.test(path)) return;
        if (isUnexpectedWrite(req.method(), path, this.readPosts)) this.add('write', `${req.method()} ${path}`);
    };

    private readonly onRequestFailed = (req: Request): void => {
        if (!this.sameOrigin(req.url())) return;
        const failure = req.failure()?.errorText ?? 'failed';
        // Navigating away aborts the requests still in flight: not a finding.
        if (/ERR_ABORTED|NS_BINDING_ABORTED|Load request cancelled/i.test(failure)) return;
        this.add('failed', `${req.method()} ${pathOf(req.url())} failed: ${failure}`);
    };

    constructor(private readonly page: Page, opts: BrowserGuardOptions = {}) {
        this.allow = opts.allow ?? [];
        this.ignoreConsole = opts.ignoreConsole ?? [];
        this.pinnedOrigin = opts.origin;
        this.readPosts = opts.readPosts;
    }

    private sameOrigin(url: string): boolean {
        const origin = this.pinnedOrigin ?? originOf(this.page.url());
        return !!origin && originOf(url) === origin;
    }

    private add(counter: Counter, text: string): void {
        this.findings.push({ counter, label: this.label, text });
    }

    /** Starts listening; call once, before the first navigation. */
    start(): this {
        if (this.started) return this;
        this.started = true;
        this.page.on('console', this.onConsole);
        this.page.on('pageerror', this.onPageError);
        this.page.on('response', this.onResponse);
        this.page.on('request', this.onRequest);
        this.page.on('requestfailed', this.onRequestFailed);
        return this;
    }

    /** Stops listening (the findings stay readable). */
    dispose(): void {
        if (!this.started) return;
        this.started = false;
        this.page.off('console', this.onConsole);
        this.page.off('pageerror', this.onPageError);
        this.page.off('response', this.onResponse);
        this.page.off('request', this.onRequest);
        this.page.off('requestfailed', this.onRequestFailed);
    }

    /** The label findings are attributed to from now on (a page name, a step). */
    mark(label: string): void {
        this.label = label;
    }

    /**
     * Reads the text of `scope` (default: `main`, else the body) and counts the forbidden error texts under the current
     * label: the error phrases outside data tables, the word `undefined` everywhere (`scanForErrorText`).
     */
    async scanText(scope?: Locator): Promise<string[]> {
        const target = scope ?? this.page.locator('main');
        const { chrome, all } = await target.evaluate((el: Element) => {
            const copy = el.cloneNode(true) as Element;
            copy.querySelectorAll('table').forEach((t) => t.remove());
            return { chrome: copy.textContent ?? '', all: el.textContent ?? '' };
        });
        const found = scanForErrorText(chrome, all);
        for (const f of found) this.add('text', `visible text "${f}"`);
        return found;
    }

    /**
     * Waits until the page's network is quiet (a bounded wait: a page that polls never settles, which is no finding), then
     * lets the page run its queued timers once and delivers the events they caused (a `pageerror` of a zero-delay timer
     * would otherwise be counted under the NEXT label). Not a sleep on state: the state is the quiet network.
     */
    async settle(timeoutMs = 15_000): Promise<void> {
        await this.page.waitForLoadState('networkidle', { timeout: timeoutMs }).catch(() => undefined);
        await this.page.evaluate(() => new Promise<void>((resolve) => setTimeout(resolve, 20))).catch(() => undefined);
    }

    /** Every finding, or those of one label / counter. */
    all(filter: { label?: string; counter?: Counter } = {}): Finding[] {
        return this.findings.filter((f) => (!filter.label || f.label === filter.label) && (!filter.counter || f.counter === filter.counter));
    }

    /** Counter totals (optionally for one label): every counter present, zero included. */
    counts(label?: string): Record<Counter, number> {
        const out: Record<Counter, number> = { console: 0, pageerror: 0, server: 0, client: 0, failed: 0, text: 0, write: 0 };
        for (const f of this.all({ label })) out[f.counter] += 1;
        return out;
    }

    /** The allow-list entries a response actually matched (a stale entry — never matched — is a finding of its own for the caller). */
    allowedSeen(): AllowedClientError[] {
        return [...this.used];
    }

    /**
     * All counters are zero (for `label`, or overall): the failure message lists every finding as
     * `<counter> [<label>] <text>`. `soft` records the failure and lets the test go on (a sweep reports every page).
     */
    assertZero(label?: string, opts: { soft?: boolean } = {}): void {
        const lines = this.all({ label }).map((f) => `${f.counter} [${f.label}] ${f.text}`);
        const check = opts.soft ? expect.soft : expect;
        check(lines, `browser findings${label ? ` on ${label}` : ''}`).toEqual([]);
    }
}
