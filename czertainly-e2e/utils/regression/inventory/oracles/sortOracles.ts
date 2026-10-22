/**
 * sortOracles — sort oracles of a listing.
 *
 * WHAT: Sort oracles of a listing: non-decreasing in both directions with empty values last, page 2 continues page 1, a
 *       second read answers the same order, asc and desc mirror each other, composition and tie-break. Text order is checked
 *       only where it is decidable without the database collation; enum columns are checked structurally.
 * WHY: Ordering bugs hide in empty values, page boundaries and ties.
 * HOW: Non-decreasing in both directions with empty values last, page 2 continues page 1, a repeat read gives the same order, asc and desc mirror, composition and tie-break; text order only where decidable, enums structurally.
 */
import type { Filter, Sort } from '../searchApi';
import { expectSorted, InvariantViolation } from '../listInvariants';
import type { ListRow } from '../listInvariants';
import { FieldMap, Values, instantMs } from './values';
import { codeUnit, expectContinuation, expectKeysEqual, expectMirror, expectNullsLast, expectOrderedText, expectSameOrder, expectTieBreakAscending } from './listExpectations';
import { ListingRun, Transport, fetchRows, listingPage, listingTotal } from './listing';
import { ApiAnswer } from '../../apiReads';

// ====================================================================================================================
// 8. Sorting (API-GEN-11)
// ====================================================================================================================

export interface SortTarget {
    id: string;
    source?: 'property' | 'meta' | 'custom' | 'data';
    /** The DTO values (property fields with a verified mapping); undefined: emptiness comes from the EMPTY filter. */
    get?: (row: ListRow) => Values;
    sort: FieldMap['sort'];
    /** The catalogue's EMPTY / NOT_EMPTY, for the filter-defined emptiness of a field without a mapping. */
    emptyFilter?: Filter;
}

export const targetOf = (field: FieldMap): SortTarget => ({ id: field.id, source: 'property', get: field.get, sort: field.sort });

const HEAD_MAX = 200;
const HEAD_PAGE = 50;

/** The value a sort puts a row at: the first value; the smallest (asc) / largest (desc) text of a multi-valued field. */
function sortText(target: SortTarget, row: ListRow, dir: 'asc' | 'desc'): string | undefined {
    const values = target.get?.(row).map(String) ?? [];
    if (!values.length) return undefined;
    if (target.sort === 'minMaxText') return [...values].sort(codeUnit)[dir === 'asc' ? 0 : values.length - 1];
    return values[0];
}

/**
 * Both directions of one sortable field over the listing (core#2031, #2394): in each direction the pages
 * of 50 concatenated equal one request of up to 200 rows, a second read answers the same order, the values are ordered (where
 * decidable), rows without a value come last (head window and, past 200 rows, the last page), and ascending and descending list
 * the same values in opposite order. Reads <= ~20 requests per field.
 */
export async function runSortField(run: ListingRun, target: SortTarget): Promise<void> {
    const { transport: t, spec, baseline: base, log } = run;
    const total = base.total;
    if (total === 0) return;
    const key = spec.rowKey;
    const head = Math.min(total, HEAD_MAX);
    const source = target.source ?? 'property';
    const emptyKeys = target.get || !target.emptyFilter
        ? undefined
        : new Set((await fetchRows(t, spec, [target.emptyFilter], spec.maxWalkRows)).rows.map(key));
    const isNull = (r: ListRow): boolean => (target.get ? target.get(r).length === 0 : (emptyKeys?.has(key(r)) ?? false));
    const emptyCount = target.get
        ? (base.complete ? base.rows.filter(isNull).length : undefined)
        : (target.emptyFilter ? await listingTotal(t, spec, [target.emptyFilter]) : undefined);
    const walks: Record<'asc' | 'desc', ListRow[]> = { asc: [], desc: [] };

    for (const dir of ['asc', 'desc'] as const) {
        const sort: Sort = { fieldSource: source, fieldIdentifier: target.id, direction: dir };
        const label = `${target.id} ${dir}`;
        const pages: ListRow[][] = [];
        for (let p = 1; p <= Math.ceil(head / HEAD_PAGE); p++) pages.push((await listingPage(t, spec, { sort, page: p, size: HEAD_PAGE })).rows);
        const whole = await listingPage(t, spec, { sort, page: 1, size: head });
        if (whole.total !== total) throw new InvariantViolation(`${label}: totalItems ${whole.total}, the unsorted listing has ${total} (the sort changed the result set or the data moved)`);
        expectContinuation(`${label}: pages of ${HEAD_PAGE} vs one request of ${head}`, pages, whole.rows, key);
        const again = await listingPage(t, spec, { sort, page: 1, size: head });
        expectSameOrder(label, whole.rows, again.rows, key);
        walks[dir] = whole.rows;

        switch (target.sort) {
            case 'number':
                expectSorted(whole.rows, target.id, dir, { key, get: (r) => (target.get!(r)[0] === undefined ? undefined : Number(target.get!(r)[0])) });
                break;
            case 'datetime':
                expectSorted(whole.rows, target.id, dir, { key, get: (r) => instantMs(target.get!(r)[0]) });
                break;
            case 'boolean':
                expectSorted(whole.rows, target.id, dir, { key, get: (r) => (target.get!(r)[0] === undefined ? undefined : Number(Boolean(target.get!(r)[0]))) });
                break;
            case 'text':
            case 'minMaxText':
                expectOrderedText(label, whole.rows, (r) => sortText(target, r, dir), dir, key);
                break;
            default:
                break;
        }
        expectNullsLast(`${label}: empty values last (head window)`, whole.rows, isNull, key);

        if (total > head) {
            const lastPage = Math.ceil(total / HEAD_PAGE);
            const tail = (await listingPage(t, spec, { sort, page: lastPage, size: HEAD_PAGE })).rows;
            expectNullsLast(`${label}: empty values last (last page)`, tail, isNull, key);
            if (emptyCount !== undefined && emptyCount > 0 && !isNull(tail[tail.length - 1])) throw new InvariantViolation(`${label}: ${emptyCount} row(s) have no value but the last row ${key(tail[tail.length - 1])} has one`);
            if (emptyCount === 0 && [...whole.rows, ...tail].some(isNull)) throw new InvariantViolation(`${label}: the listing has no empty value (EMPTY answers 0) but a row without a value was returned`);
        } else if (emptyCount !== undefined) {
            const nulls = whole.rows.filter(isNull).length;
            if (nulls !== emptyCount) throw new InvariantViolation(`${label}: ${nulls} returned row(s) have no value, the EMPTY set has ${emptyCount}`);
        }
        log.step(`${label}: ${whole.rows.length} of ${total} rows, pages of ${HEAD_PAGE} = one request, stable on re-read, ${target.sort} order, empty last${emptyCount === undefined ? '' : ` (${emptyCount} empty)`}`);
    }

    if (total <= HEAD_MAX && target.get && (target.sort === 'number' || target.sort === 'datetime' || target.sort === 'boolean' || target.sort === 'text')) {
        expectMirror(`${target.id}: ascending vs descending`, walks.asc, walks.desc, (r) => {
            const v = target.get!(r)[0];
            return v === undefined ? undefined : String(v);
        });
        log.step(`${target.id}: ascending and descending mirror each other`);
    } else if (total > HEAD_MAX) {
        log.note(`${target.id}: ${total} rows exceed the ${HEAD_MAX}-row walk budget; the mirror check was skipped`);
    }
}

/**
 * Sort composes with the set (core#2031 AC5): a sorted walk returns exactly the rows of the unsorted one, and a sorted AND
 * filtered request returns the filtered rows (here: NOT_EMPTY of the sorted field). Budget: maxWalkRows per walk.
 */
export async function runSortComposition(run: ListingRun, target: SortTarget): Promise<void> {
    const { transport: t, spec, baseline: base, log } = run;
    if (!base.complete) {
        log.note(`${target.id}: ${base.total} rows exceed the ${spec.maxWalkRows}-row budget; sort composition was not walked`);
        return;
    }
    const key = spec.rowKey;
    const source = target.source ?? 'property';
    const notEmpty: Filter = { fieldSource: source, fieldIdentifier: target.id, condition: 'NOT_EMPTY' };
    const plain = await fetchRows(t, spec, [notEmpty], spec.maxWalkRows);
    for (const dir of ['asc', 'desc'] as const) {
        const sort: Sort = { fieldSource: source, fieldIdentifier: target.id, direction: dir };
        const all = await fetchRows(t, spec, [], spec.maxWalkRows, sort);
        expectKeysEqual(`${target.id} ${dir}: the sorted listing differs from the unsorted one`, all.rows, base.rows, key);
        const filtered = await fetchRows(t, spec, [notEmpty], spec.maxWalkRows, sort);
        expectKeysEqual(`${target.id} ${dir} + NOT_EMPTY: the sorted and filtered set differs from the filtered one`, filtered.rows, plain.rows, key);
        log.step(`${target.id} ${dir}: ${all.total} rows = the unsorted set; with NOT_EMPTY ${filtered.total} rows = the filtered set`);
    }
}

/**
 * The uuid tie-break: equal sort values are ordered by ascending key in both directions
 * (SortOrderBuilder). Returns the number of equal-value runs seen (0: no ties in the head window, nothing proven).
 */
export async function runTieBreak(run: ListingRun, target: SortTarget): Promise<number> {
    const { transport: t, spec, baseline: base, log } = run;
    if (base.total === 0 || !target.get) return 0;
    const key = spec.rowKey;
    let ties = 0;
    for (const dir of ['asc', 'desc'] as const) {
        const sort: Sort = { fieldSource: target.source ?? 'property', fieldIdentifier: target.id, direction: dir };
        const rows = (await listingPage(t, spec, { sort, size: Math.min(base.total, HEAD_MAX) })).rows;
        ties += expectTieBreakAscending(`${target.id} ${dir}`, rows, (r) => {
            const v = target.get!(r)[0];
            return v === undefined ? undefined : String(v);
        }, key);
    }
    log.step(`${target.id}: ${ties} equal-value neighbour pair(s), keys ascending in both directions`);
    return ties;
}

// ====================================================================================================================
// 9. Sort refusals
// ====================================================================================================================

/** The sort a refusal probe sends. */
export const sortOf = (fieldIdentifier: string, fieldSource: Sort['fieldSource'] = 'property', direction: Sort['direction'] = 'asc'): Sort => ({ fieldSource, fieldIdentifier, direction });

/** `POST <url>` with a one-row page and the given sort; the probe is returned for the caller's status / body assertions. */
export async function probeSort(t: Transport, url: string, sort: unknown, extra: Record<string, unknown> = {}): Promise<ApiAnswer> {
    return t.postRead(url, { filters: [], itemsPerPage: 1, pageNumber: 1, sort, ...extra });
}

/** The refusal text of a listing outside the configurable-column pipeline (RequestValidatorHelper.java). */
export const unsupportedSortText = (label: string): string => `Sorting is not supported for the ${label} listing.`;
