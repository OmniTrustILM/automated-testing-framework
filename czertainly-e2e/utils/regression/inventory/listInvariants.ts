/**
 * listInvariants — filter, sort and paging checks over rows that were already fetched (or a page function).
 *
 * Checks that need no exact counts: empty plus not empty is the total, a filter returns only matching rows, AND
 * narrows, the order holds with empty values last, pages add up. A violation throws InvariantViolation naming the
 * field, the condition and the sets or neighbouring rows. `matchesCondition` delegates to the one filter evaluator.
 */

import { satisfiesFilter } from './oracles/values';
import type { Scalar } from './oracles/values';

export type ListRow = Record<string, unknown>;

export class InvariantViolation extends Error {
    constructor(message: string) {
        super(message);
        this.name = 'InvariantViolation';
    }
}

export interface KeyOption {
    key?: (row: ListRow) => string;
}

const defaultKey = (row: ListRow): string => String(row.uuid);

function keys(rows: ListRow[], key: (row: ListRow) => string): string[] {
    return rows.map(key);
}

function preview(ids: Iterable<string>, max = 10): string {
    const list = [...ids];
    return `[${list.slice(0, max).join(', ')}${list.length > max ? `, … ${list.length - max} more` : ''}]`;
}

/** Value at a dotted path (`raProfile.name`, `groups.name` maps over arrays). */
function valueAt(row: ListRow, field: string): unknown {
    let cur: unknown = row;
    for (const part of field.split('.')) {
        if (cur === null || cur === undefined) return undefined;
        cur = Array.isArray(cur) ? cur.map((x) => (x as ListRow)?.[part]) : (cur as ListRow)[part];
    }
    return cur;
}

const isEmptyValue = (v: unknown): boolean =>
    v === null || v === undefined || v === '' || (Array.isArray(v) && v.filter((x) => !isEmptyValue(x)).length === 0);

// ------------------------------------------------------------------ EMPTY + NOT_EMPTY = total

/** `EMPTY` and `NOT_EMPTY` on one field partition the unfiltered set: the counts add up and the sets are disjoint. */
export function expectEmptyPlusNotEmptyEqualsTotal(
    sets: { total: number; empty: ListRow[]; notEmpty: ListRow[] },
    field: string,
    opts: KeyOption = {},
): void {
    const key = opts.key ?? defaultKey;
    const empty = new Set(keys(sets.empty, key));
    const notEmpty = new Set(keys(sets.notEmpty, key));
    const both = [...empty].filter((k) => notEmpty.has(k));
    if (both.length) {
        throw new InvariantViolation(`${field}: EMPTY and NOT_EMPTY overlap in ${both.length} row(s) ${preview(both)}; ` +
            `EMPTY ${preview(empty)} NOT_EMPTY ${preview(notEmpty)}`);
    }
    if (empty.size + notEmpty.size !== sets.total) {
        throw new InvariantViolation(`${field}: EMPTY (${empty.size}) + NOT_EMPTY (${notEmpty.size}) = ${empty.size + notEmpty.size}, ` +
            `unfiltered total ${sets.total}; EMPTY ${preview(empty)} NOT_EMPTY ${preview(notEmpty)}`);
    }
}

// ------------------------------------------------------------------ filter property (reference evaluator)

type FilterCondition =
    | 'EQUALS' | 'NOT_EQUALS' | 'CONTAINS' | 'NOT_CONTAINS' | 'STARTS_WITH' | 'ENDS_WITH'
    | 'EMPTY' | 'NOT_EMPTY' | 'GREATER' | 'GREATER_OR_EQUAL' | 'LESSER' | 'LESSER_OR_EQUAL';

export interface FilterSpec {
    field: string;
    condition: FilterCondition;
    value?: unknown;
    /** Reads the field from a row when a dotted path is not enough. */
    get?: (row: ListRow) => unknown;
    ignoreCase?: boolean;
}

const asComparable = (v: unknown): number | string => {
    if (typeof v === 'number') return v;
    if (typeof v === 'string' && /^\d{4}-\d{2}-\d{2}/.test(v) && !Number.isNaN(Date.parse(v))) return Date.parse(v);
    if (v instanceof Date) return v.getTime();
    return String(v);
};

/**
 * The reference evaluator: does one row satisfy the filter? Array fields match when any element matches. The rules are
 * the ones of `satisfiesFilter` (the one home of the filter semantics); this adapter only reads the field, turns ISO
 * dates into instants so they compare as time, and applies `ignoreCase` by lower-casing both sides.
 */
export function matchesCondition(row: ListRow, f: FilterSpec): boolean {
    const raw = f.get ? f.get(row) : valueAt(row, f.field);
    if (f.condition === 'EMPTY') return isEmptyValue(raw);
    if (f.condition === 'NOT_EMPTY') return !isEmptyValue(raw);
    const ordered = f.condition === 'GREATER' || f.condition === 'GREATER_OR_EQUAL' || f.condition === 'LESSER' || f.condition === 'LESSER_OR_EQUAL';
    const adapt = (x: unknown): Scalar => {
        if (ordered) return asComparable(x);
        const text = typeof x === 'number' || typeof x === 'boolean' ? x : String(x);
        return f.ignoreCase && typeof text === 'string' ? text.toLowerCase() : text;
    };
    const values = (Array.isArray(raw) ? raw : [raw]).filter((x) => x !== null && x !== undefined).map(adapt);
    const wanted = (Array.isArray(f.value) ? f.value : [f.value]).map(adapt);
    return satisfiesFilter(values, f.condition, wanted, { caseSensitive: !f.ignoreCase });
}

/** Every returned row satisfies the filter (the property check; exact sets come from the seed manifest). */
export function expectFilterProperty(rows: ListRow[], filter: FilterSpec, opts: KeyOption = {}): void {
    const key = opts.key ?? defaultKey;
    const bad = rows.filter((r) => !matchesCondition(r, filter));
    if (bad.length) {
        const shown = bad.slice(0, 5).map((r) => `${key(r)}=${JSON.stringify(filter.get ? filter.get(r) : valueAt(r, filter.field))}`);
        throw new InvariantViolation(`${filter.field} ${filter.condition} ${JSON.stringify(filter.value ?? null)}: ` +
            `${bad.length} of ${rows.length} returned row(s) do not satisfy it: ${shown.join('; ')}`);
    }
}

// ------------------------------------------------------------------ AND narrows

/** |A and B| <= min(|A|, |B|), A and B is a subset of both, and (given `ba`) the filter order does not change the set. */
export function expectAndNarrowsResults(a: ListRow[], b: ListRow[], ab: ListRow[], ba?: ListRow[], opts: KeyOption = {}): void {
    const key = opts.key ?? defaultKey;
    const A = new Set(keys(a, key));
    const B = new Set(keys(b, key));
    const AB = new Set(keys(ab, key));
    if (AB.size > Math.min(A.size, B.size)) {
        throw new InvariantViolation(`A and B has ${AB.size} rows, more than min(|A| ${A.size}, |B| ${B.size})`);
    }
    const notInA = [...AB].filter((k) => !A.has(k));
    const notInB = [...AB].filter((k) => !B.has(k));
    if (notInA.length || notInB.length) {
        throw new InvariantViolation(`A and B is not a subset of both: not in A ${preview(notInA)}, not in B ${preview(notInB)}`);
    }
    if (ba) {
        const BA = new Set(keys(ba, key));
        const onlyAB = [...AB].filter((k) => !BA.has(k));
        const onlyBA = [...BA].filter((k) => !AB.has(k));
        if (onlyAB.length || onlyBA.length) {
            throw new InvariantViolation(`filter order changes the set: only in A,B ${preview(onlyAB)}, only in B,A ${preview(onlyBA)}`);
        }
    }
}

// ------------------------------------------------------------------ sorting

export interface SortOptions extends KeyOption {
    /** null / undefined / '' after every value (in both directions). Default true. */
    nullsLast?: boolean;
    /** Equal values must be ordered by uuid ascending. */
    tieBreak?: 'uuid';
    /** Comparator for two non-null values; default numbers and ISO dates numerically, strings by code point. */
    compare?: (a: unknown, b: unknown) => number;
    get?: (row: ListRow) => unknown;
}

/**
 * Strings compare by UTF-16 code unit (`<` / `>`), deliberately not with `localeCompare` / `Intl.Collator`: the oracle
 * must not depend on the runner's locale. A server that sorts with a database collation (case-insensitive, accent-
 * folding, "natural" numbers) will differ from this order on such values: pass `compare` with a collator that matches
 * the column's documented collation (e.g. `new Intl.Collator('en', { sensitivity: 'base' }).compare`) rather than
 * loosening the oracle.
 */
const defaultCompare = (a: unknown, b: unknown): number => {
    const x = asComparable(a);
    const y = asComparable(b);
    if (typeof x === 'number' && typeof y === 'number') return x - y;
    const sx = String(x);
    const sy = String(y);
    return sx < sy ? -1 : sx > sy ? 1 : 0;
};

/** Rows are ordered by the field in `dir` with nulls last and (optionally) a stable uuid tie-break. */
export function expectSorted(rows: ListRow[], field: string, dir: 'asc' | 'desc', opts: SortOptions = {}): void {
    const key = opts.key ?? defaultKey;
    const nullsLast = opts.nullsLast ?? true;
    const cmp = opts.compare ?? defaultCompare;
    const get = (r: ListRow) => {
        const v = opts.get ? opts.get(r) : valueAt(r, field);
        return Array.isArray(v) ? v[0] : v;
    };
    for (let i = 1; i < rows.length; i++) {
        const prev = get(rows[i - 1]);
        const cur = get(rows[i]);
        const prevNull = isEmptyValue(prev);
        const curNull = isEmptyValue(cur);
        let order: number;
        if (prevNull || curNull) {
            order = prevNull === curNull ? 0 : prevNull ? (nullsLast ? 1 : -1) : nullsLast ? -1 : 1;
        } else {
            order = dir === 'asc' ? cmp(prev, cur) : cmp(cur, prev);
        }
        if (order === 0 && opts.tieBreak === 'uuid') order = key(rows[i - 1]) < key(rows[i]) ? -1 : 1;
        if (order > 0) {
            throw new InvariantViolation(`${field} ${dir}${nullsLast ? ' nulls last' : ''}: row ${i - 1} ${key(rows[i - 1])}=${JSON.stringify(prev ?? null)} ` +
                `comes before row ${i} ${key(rows[i])}=${JSON.stringify(cur ?? null)}`);
        }
    }
}

// ------------------------------------------------------------------ paging

interface ListPage {
    items: ListRow[];
    totalItems: number;
    totalPages?: number;
}

/** Fetches every page (1-based) and checks totals, page count, page sizes and overlap; returns the union in page order. */
export async function walkPages(
    search: (pageNumber: number, itemsPerPage: number) => Promise<ListPage>,
    opts: { pageSize: number; maxPages?: number } & KeyOption,
): Promise<{ items: ListRow[]; totalItems: number; pages: ListPage[] }> {
    const key = opts.key ?? defaultKey;
    const first = await search(1, opts.pageSize);
    const total = first.totalItems;
    const expectedPages = Math.max(1, Math.ceil(total / opts.pageSize));
    if (first.totalPages !== undefined && first.totalPages !== expectedPages && !(total === 0 && first.totalPages === 0)) {
        throw new InvariantViolation(`paging: totalPages ${first.totalPages}, but ceil(totalItems ${total} / pageSize ${opts.pageSize}) = ${expectedPages}`);
    }
    if (expectedPages > (opts.maxPages ?? 100)) {
        throw new InvariantViolation(`paging: ${expectedPages} pages exceed maxPages ${opts.maxPages ?? 100}; narrow the search`);
    }
    const pages = [first];
    for (let n = 2; n <= expectedPages; n++) pages.push(await search(n, opts.pageSize));
    const seen = new Map<string, number>();
    pages.forEach((p, i) => {
        if (p.totalItems !== total) throw new InvariantViolation(`paging: totalItems changed from ${total} to ${p.totalItems} on page ${i + 1}`);
        const expectedSize = i < expectedPages - 1 ? opts.pageSize : total - opts.pageSize * (expectedPages - 1);
        if (p.items.length !== expectedSize) {
            throw new InvariantViolation(`paging: page ${i + 1} of ${expectedPages} has ${p.items.length} rows, expected ${expectedSize}`);
        }
        for (const r of p.items) {
            const k = key(r);
            if (seen.has(k)) throw new InvariantViolation(`paging: ${k} appears on page ${seen.get(k)} and again on page ${i + 1}`);
            seen.set(k, i + 1);
        }
    });
    return { items: pages.flatMap((p) => p.items), totalItems: total, pages };
}

/** The pages add up to the unpaged result: same count, same set. */
export function expectPagingInvariants(pages: ListRow[][], unpaged: ListRow[], opts: KeyOption = {}): void {
    const key = opts.key ?? defaultKey;
    const sum = pages.reduce((n, p) => n + p.length, 0);
    if (sum !== unpaged.length) throw new InvariantViolation(`paging: pages hold ${sum} rows, the unpaged result ${unpaged.length}`);
    const paged = new Set(pages.flat().map(key));
    const all = new Set(unpaged.map(key));
    const missing = [...all].filter((k) => !paged.has(k));
    const extra = [...paged].filter((k) => !all.has(k));
    if (missing.length || extra.length || paged.size !== sum) {
        throw new InvariantViolation(`paging: union differs from the unpaged set: missing ${preview(missing)}, extra ${preview(extra)}` +
            (paged.size !== sum ? `, ${sum - paged.size} duplicate(s) across pages` : ''));
    }
}
