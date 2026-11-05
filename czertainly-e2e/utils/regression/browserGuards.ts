/**
 * browserGuards — counts what a page did wrong per labelled step (console and page errors, 5xx, unallowed 4xx, failed requests, unexpected
 * writes, error text); it only listens.
 */
import { expect, Locator, Page, Request, Response } from '@playwright/test';

/**
 * A 4xx a test tolerates, with the reason: a filed defect (`bug`: `<repo>#<n>`) or a refusal the test provokes on purpose (`expected`). A
 * bare 4xx is never allowed.
 */
export type AllowedClientError = {
    method?: string;
    path: RegExp;
    status: number | number[];
    reason: string;
} & ({ bug: string; expected?: never } | { expected: string; bug?: never });

export type Counter = 'console' | 'pageerror' | 'server' | 'client' | 'failed' | 'text' | 'write';

export interface Finding {
    counter: Counter;
    label: string;
    text: string;
}

export interface BrowserGuardOptions {
    allow?: AllowedClientError[];
    ignoreConsole?: RegExp[];
    origin?: string;
    /** The POST paths the page may send because they only read; given → every other same-origin API write is a `write` finding. */
    readPosts?: RegExp[];
}

const HTTP_NOISE = /^Failed to load resource: the server responded with a status of \d{3}/;

export const ignorableConsole = (text: string, extra: RegExp[] = []): boolean => HTTP_NOISE.test(text) || extra.some((re) => re.test(text));

export function matchAllowed(allow: AllowedClientError[], method: string, path: string, status: number): AllowedClientError | undefined {
    return allow.find((a) => (!a.method || a.method.toUpperCase() === method.toUpperCase()) && a.path.test(path) && [a.status].flat().includes(status));
}

export function classify(status: number, method: string, path: string, allow: AllowedClientError[]): 'server' | 'client' | undefined {
    if (status >= 500) return 'server';
    if (status >= 400 && !matchAllowed(allow, method, path, status)) return 'client';
    return undefined;
}

/**
 * The error texts a page must not show: "unexpected error" and "Internal server error" (searched outside data tables) and the word
 * `undefined` (whole text). Returns the distinct matches.
 */
export function scanForErrorText(chrome: string, all: string = chrome): string[] {
    const found = new Set<string>();
    for (const m of chrome.matchAll(/unexpected error|internal server error/gi)) found.add(m[0].toLowerCase());
    if (/\bundefined\b/.test(all)) found.add('undefined');
    return [...found];
}

export type ListShape = 'single' | 'bare' | 'paged';

/** The shape problems of a list answer (empty = fine); `paged` needs numeric paging fields and exactly one rows array within the limits. */
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

export const isWriteMethod = (method: string): boolean => /^(PUT|PATCH|DELETE)$/i.test(method);

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
        // Navigating away aborts requests still in flight: not a finding.
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

    dispose(): void {
        if (!this.started) return;
        this.started = false;
        this.page.off('console', this.onConsole);
        this.page.off('pageerror', this.onPageError);
        this.page.off('response', this.onResponse);
        this.page.off('request', this.onRequest);
        this.page.off('requestfailed', this.onRequestFailed);
    }

    mark(label: string): void {
        this.label = label;
    }

    /** Counts the forbidden error texts of `scope` (default `main`, else the body) under the current label. */
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
     * Waits for a quiet network (bounded; a polling page never settles, which is no finding), then runs queued timers once so their
     * `pageerror` is not counted under the next label.
     */
    async settle(timeoutMs = 15_000): Promise<void> {
        await this.page.waitForLoadState('networkidle', { timeout: timeoutMs }).catch(() => undefined);
        await this.page.evaluate(() => new Promise<void>((resolve) => setTimeout(resolve, 20))).catch(() => undefined);
    }

    all(filter: { label?: string; counter?: Counter } = {}): Finding[] {
        return this.findings.filter((f) => (!filter.label || f.label === filter.label) && (!filter.counter || f.counter === filter.counter));
    }

    counts(label?: string): Record<Counter, number> {
        const out: Record<Counter, number> = { console: 0, pageerror: 0, server: 0, client: 0, failed: 0, text: 0, write: 0 };
        for (const f of this.all({ label })) out[f.counter] += 1;
        return out;
    }

    /** The allow-list entries a response matched (a never-matched entry is stale). */
    allowedSeen(): AllowedClientError[] {
        return [...this.used];
    }

    /** Fails unless all counters are zero; the message lists every finding. `soft` records the failure and goes on. */
    assertZero(label?: string, opts: { soft?: boolean } = {}): void {
        const lines = this.all({ label }).map((f) => `${f.counter} [${f.label}] ${f.text}`);
        const check = opts.soft ? expect.soft : expect;
        check(lines, `browser findings${label ? ` on ${label}` : ''}`).toEqual([]);
    }
}
