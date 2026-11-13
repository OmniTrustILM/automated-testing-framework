/**
 * listing — reading a listing for the oracles (read-only on the target): a `Transport` hides whether the guarded `api` or a fake listing
 * answers; one re-read absorbs a concurrent change of the tier.
 */
import type { GuardedApi } from '../../guard/types';
import { send, readAnswer } from '../searchApi';
import type { Filter, Sort } from '../searchApi';
import { InvariantViolation, walkPages } from '../listInvariants';
import type { ListRow } from '../listInvariants';
import { FieldMap } from './values';
import { ApiAnswer } from '../../apiReads';

export class RunLog {
    readonly steps: string[] = [];
    readonly notes: string[] = [];
    step(message: string): void {
        this.steps.push(message);
    }
    note(message: string): void {
        this.notes.push(message);
    }
}

export async function retryOnceWithReread<T>(label: string, log: RunLog, fn: () => Promise<T>): Promise<T> {
    try {
        return await fn();
    } catch (first) {
        if (!(first instanceof InvariantViolation)) throw first;
        log.note(`${label}: the first read disagreed (${first.message.slice(0, 200)}); read again once`);
        try {
            return await fn();
        } catch (second) {
            if (second instanceof InvariantViolation) throw new InvariantViolation(`${label}, second read: ${second.message} | first read: ${first.message}`);
            throw second;
        }
    }
}


export interface ListingRun {
    transport: Transport;
    spec: ListingSpec;
    baseline: Baseline;
    log: RunLog;
}

export interface Transport {
    /** A read-only POST (a listing search); named `postRead` so the deny-by-default lint does not mistake it for a context `.post`. */
    postRead(url: string, body: unknown): Promise<ApiAnswer>;
    get(url: string): Promise<ApiAnswer>;
}

export function transportThroughGuard(api: GuardedApi): Transport {
    return {
        postRead: (url, body) => send(api, 'POST', url, { data: body }),
        get: (url) => readAnswer(api, url),
    };
}

export interface ListingSpec {
    name: string;
    searchUrl: string;
    catalogueUrl: string;
    rowsMember: string;
    rowKey: (row: ListRow) => string;
    configurable: boolean;
    refusalLabel: string;
    fields: FieldMap[];
    baseFilters?: Filter[];
    /** Most rows a baseline or filtered set is read in full. */
    maxWalkRows: number;
}

class ListingError extends Error {
    constructor(readonly status: number, readonly body: string, message: string) {
        super(message);
        this.name = 'ListingError';
    }
}

export interface ListingPage {
    rows: ListRow[];
    total: number;
    totalPages: number;
    itemsPerPage: number;
    pageNumber: number;
    serverNow?: number;
}

export interface PageRequest {
    filters?: Filter[];
    page?: number;
    size?: number;
    sort?: Sort;
}

export const requestBody = (spec: ListingSpec, req: PageRequest): Record<string, unknown> => ({
    filters: [...(spec.baseFilters ?? []), ...(req.filters ?? [])],
    itemsPerPage: req.size ?? 100,
    pageNumber: req.page ?? 1,
    ...(req.sort ? { sort: req.sort } : {}),
});

export async function listingPage(t: Transport, spec: ListingSpec, req: PageRequest = {}): Promise<ListingPage> {
    const body = requestBody(spec, req);
    const p = await t.postRead(spec.searchUrl, body);
    if (p.status !== 200) throw new ListingError(p.status, p.text.slice(0, 300), `${spec.name}: ${JSON.stringify(body).slice(0, 240)} answered ${p.status} ${p.text.slice(0, 300)}`);
    const json = p.json as Record<string, unknown> | undefined;
    const rows = json?.[spec.rowsMember];
    if (!Array.isArray(rows)) throw new ListingError(p.status, p.text.slice(0, 300), `${spec.name}: the answer has no "${spec.rowsMember}" array: ${p.text.slice(0, 200)}`);
    const date = p.headers.date ? Date.parse(p.headers.date) : NaN;
    return {
        rows: rows as ListRow[],
        total: Number(json!.totalItems),
        totalPages: Number(json!.totalPages),
        itemsPerPage: Number(json!.itemsPerPage),
        pageNumber: Number(json!.pageNumber),
        serverNow: Number.isNaN(date) ? undefined : date,
    };
}

export const listingTotal = async (t: Transport, spec: ListingSpec, filters: Filter[] = []): Promise<number> => (await listingPage(t, spec, { filters, size: 1 })).total;

export interface RowSet {
    rows: ListRow[];
    total: number;
    complete: boolean;
}

export async function fetchRows(t: Transport, spec: ListingSpec, filters: Filter[], cap: number, sort?: Sort): Promise<RowSet> {
    const size = Math.min(100, cap);
    const first = await listingPage(t, spec, { filters, size, page: 1, sort });
    const rows = [...first.rows];
    const want = Math.min(first.total, cap);
    for (let page = 2; rows.length < want && page <= Math.ceil(want / size); page++) rows.push(...(await listingPage(t, spec, { filters, size, page, sort })).rows);
    const complete = first.total <= cap;
    if (complete) {
        const keys = new Set(rows.map(spec.rowKey));
        if (rows.length !== first.total || keys.size !== rows.length) {
            throw new InvariantViolation(`${spec.name}: ${JSON.stringify(filters).slice(0, 160)}: the pages hold ${rows.length} rows (${keys.size} distinct) but totalItems says ${first.total}`);
        }
    }
    return { rows: rows.slice(0, want), total: first.total, complete };
}

export interface Baseline {
    rows: ListRow[];
    total: number;
    complete: boolean;
}

/** The unfiltered listing: every page walked when it fits the budget, else its first `maxWalkRows` rows (`complete: false`). */
export async function loadBaseline(t: Transport, spec: ListingSpec, pageSize = 100): Promise<Baseline> {
    const head = await listingPage(t, spec, { size: 1 });
    if (head.total === 0) return { rows: [], total: 0, complete: true };
    if (head.total > spec.maxWalkRows) {
        const partial = await fetchRows(t, spec, [], spec.maxWalkRows);
        return { rows: partial.rows, total: head.total, complete: false };
    }
    const walked = await walkPages(
        async (pageNumber, itemsPerPage) => {
            const p = await listingPage(t, spec, { page: pageNumber, size: itemsPerPage });
            return { items: p.rows, totalItems: p.total, totalPages: p.totalPages };
        },
        { pageSize, maxPages: Math.ceil(spec.maxWalkRows / pageSize) + 1, key: spec.rowKey },
    );
    return { rows: walked.items, total: walked.totalItems, complete: true };
}
