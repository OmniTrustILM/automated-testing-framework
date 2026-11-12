/**
 * listExpectations — pure checkers over listing reads.
 *
 * WHAT: Pure checkers over listing reads that utils/regression/inventory/listInvariants.ts does not have: count partitions,
 *       set equality, continuation, the block of empty values, mirror order, text order without knowing the collation,
 *       tie-break and instant order. Each names the field, the neighbouring rows or the sets when it fails.
 * WHY: Some list rules (partitions, continuation, mirror order, tie-break) are not covered by `listInvariants`.
 * HOW: Each checker names the field, the neighbouring rows or the sets when it fails; text order is checked without knowing the collation.
 */
import { InvariantViolation } from '../listInvariants';
import type { ListRow } from '../listInvariants';
import { FieldMap, satisfiesFilter } from './values';

// ====================================================================================================================
// 4. Pure checkers (besides listInvariants.ts)
// ====================================================================================================================

const preview = (ids: Iterable<string>, max = 8): string => {
    const list = [...ids];
    return `[${list.slice(0, max).join(', ')}${list.length > max ? `, … ${list.length - max} more` : ''}]`;
};

/** The parts add up to the total (a partition by counts). */
export function expectCountsAdd(label: string, parts: Array<[string, number]>, total: number): void {
    const sum = parts.reduce((n, [, c]) => n + c, 0);
    if (sum !== total) throw new InvariantViolation(`${label}: ${parts.map(([n, c]) => `${n} ${c}`).join(' + ')} = ${sum}, expected ${total}`);
}

export function expectKeysEqual(label: string, actual: ListRow[], expected: ListRow[], key: (r: ListRow) => string): void {
    const a = new Set(actual.map(key));
    const e = new Set(expected.map(key));
    const missing = [...e].filter((k) => !a.has(k));
    const extra = [...a].filter((k) => !e.has(k));
    if (missing.length || extra.length) throw new InvariantViolation(`${label}: missing ${preview(missing)}, unexpected ${preview(extra)} (returned ${a.size}, expected ${e.size})`);
}

export function expectSubset(label: string, sub: ListRow[], sup: ListRow[], key: (r: ListRow) => string): void {
    const s = new Set(sup.map(key));
    const outside = sub.map(key).filter((k) => !s.has(k));
    if (outside.length) throw new InvariantViolation(`${label}: ${outside.length} row(s) outside the superset ${preview(outside)}`);
}

/** A and B returns exactly the intersection of A and B (filters are ANDed, FilterPredicatesBuilder.java). */
export function expectIntersection(label: string, a: ListRow[], b: ListRow[], ab: ListRow[], key: (r: ListRow) => string): void {
    const inB = new Set(b.map(key));
    expectKeysEqual(label, ab, a.filter((r) => inB.has(key(r))), key);
}

/** Pages of one size, concatenated, are the first rows of one big request, in the same order. */
export function expectContinuation(label: string, pages: ListRow[][], whole: ListRow[], key: (r: ListRow) => string): void {
    const flat = pages.flat().map(key);
    const big = whole.map(key);
    if (flat.length < big.length) throw new InvariantViolation(`${label}: the pages hold ${flat.length} rows, the single request ${big.length}`);
    for (let i = 0; i < big.length; i++) {
        if (flat[i] !== big[i]) throw new InvariantViolation(`${label}: row ${i} is ${flat[i]} across the pages but ${big[i]} in the single request`);
    }
}

export function expectSameOrder(label: string, a: ListRow[], b: ListRow[], key: (r: ListRow) => string): void {
    const x = a.map(key);
    const y = b.map(key);
    const at = x.findIndex((k, i) => k !== y[i]);
    if (x.length !== y.length || at >= 0) throw new InvariantViolation(`${label}: two identical requests answered different orders (first difference at row ${at < 0 ? Math.min(x.length, y.length) : at})`);
}

/** Once a row without a value appears, no row with a value follows (empty values last). */
export function expectNullsLast(label: string, rows: ListRow[], isNull: (r: ListRow) => boolean, key: (r: ListRow) => string): void {
    let firstNull = -1;
    rows.forEach((r, i) => {
        if (isNull(r)) {
            if (firstNull < 0) firstNull = i;
        } else if (firstNull >= 0) {
            throw new InvariantViolation(`${label}: row ${i} ${key(r)} has a value after the empty row ${firstNull} ${key(rows[firstNull])}`);
        }
    });
}

/** asc and desc list the same values in opposite order (ties may reorder, so the VALUE sequences are compared). */
export function expectMirror(label: string, asc: ListRow[], desc: ListRow[], valueOf: (r: ListRow) => string | undefined): void {
    const a = asc.map(valueOf).filter((v): v is string => v !== undefined);
    const d = desc.map(valueOf).filter((v): v is string => v !== undefined).reverse();
    if (a.length !== d.length) throw new InvariantViolation(`${label}: ${a.length} values ascending, ${d.length} descending`);
    const at = a.findIndex((v, i) => v !== d[i]);
    if (at >= 0) throw new InvariantViolation(`${label}: ascending value ${at} is "${a[at]}", the mirrored descending one "${d[at]}"`);
}

const simpleText = (s: string): boolean => /^[a-z0-9]+$/.test(s);
const collator = new Intl.Collator('en');
export const codeUnit = (a: string, b: string): number => (a < b ? -1 : a > b ? 1 : 0);

/**
 * Text order without knowing the collation: equal strings are fine; two [a-z0-9] strings must follow the code-unit order;
 * any other pair is accepted when EITHER the code-unit order OR the `en` collator order is right.
 */
export function textOrdered(prev: string, cur: string, dir: 'asc' | 'desc'): boolean {
    if (prev === cur) return true;
    const [lo, hi] = dir === 'asc' ? [prev, cur] : [cur, prev];
    if (simpleText(prev) && simpleText(cur)) return codeUnit(lo, hi) <= 0;
    return codeUnit(lo, hi) <= 0 || collator.compare(lo, hi) <= 0;
}

/** Non-null text values non-decreasing (`asc`) / non-increasing (`desc`) per `textOrdered`; rows without a value are skipped here. */
export function expectOrderedText(label: string, rows: ListRow[], valueOf: (r: ListRow) => string | undefined, dir: 'asc' | 'desc', key: (r: ListRow) => string): void {
    let prev: { v: string; r: ListRow } | undefined;
    for (const r of rows) {
        const v = valueOf(r);
        if (v === undefined) continue;
        if (prev && !textOrdered(prev.v, v, dir)) throw new InvariantViolation(`${label}: ${key(prev.r)}="${prev.v}" comes before ${key(r)}="${v}"`);
        prev = { v, r };
    }
}

/** Equal sort values are ordered by key ascending (core SortOrderBuilder tieBreak appends `uuid asc` in both directions). */
export function expectTieBreakAscending(label: string, rows: ListRow[], valueOf: (r: ListRow) => string | undefined, key: (r: ListRow) => string): number {
    let groups = 0;
    for (let i = 1; i < rows.length; i++) {
        const a = valueOf(rows[i - 1]);
        const b = valueOf(rows[i]);
        if (a === undefined || b === undefined || a !== b) continue;
        groups += 1;
        if (!(key(rows[i - 1]) < key(rows[i]))) throw new InvariantViolation(`${label}: rows with the equal value "${a}" are ordered ${key(rows[i - 1])} then ${key(rows[i])}, not by ascending key`);
    }
    return groups;
}

/** Every returned row satisfies the filter (the row-level predicate). */
export function expectRowsSatisfy(label: string, rows: ListRow[], field: Pick<FieldMap, 'get'>, condition: string, value: unknown, key: (r: ListRow) => string): void {
    const bad = rows.filter((r) => !satisfiesFilter(field.get(r), condition, value));
    if (bad.length) {
        const shown = bad.slice(0, 4).map((r) => `${key(r)}=${JSON.stringify(field.get(r))}`);
        throw new InvariantViolation(`${label}: ${bad.length} of ${rows.length} returned row(s) do not satisfy ${condition} ${JSON.stringify(value ?? null)}: ${shown.join('; ')}`);
    }
}

/** Every instant of the LOWER set is not after any instant of the UPPER set (the two halves of a datetime partition are ordered). */
export function expectInstantOrder(label: string, lowerSet: ListRow[], upperSet: ListRow[], valueOf: (r: ListRow) => number | undefined): void {
    const lo = lowerSet.map(valueOf).filter((v): v is number => v !== undefined);
    const hi = upperSet.map(valueOf).filter((v): v is number => v !== undefined);
    if (!lo.length || !hi.length) return;
    const maxLo = Math.max(...lo);
    const minHi = Math.min(...hi);
    if (maxLo > minHi) throw new InvariantViolation(`${label}: the lower half reaches ${new Date(maxLo).toISOString()}, the upper half starts at ${new Date(minHi).toISOString()}`);
}

/** A window predicate for IN_PAST / IN_NEXT: every instant lies in [from, to] widened by the skew tolerance. */
export function expectInstantsWithin(label: string, rows: ListRow[], valueOf: (r: ListRow) => number | undefined, from: number, to: number, toleranceMs: number): void {
    const bad = rows.filter((r) => {
        const t = valueOf(r);
        return t === undefined || t < from - toleranceMs || t > to + toleranceMs;
    });
    if (bad.length) {
        const shown = bad.slice(0, 3).map((r) => String(valueOf(r) === undefined ? 'no value' : new Date(valueOf(r)!).toISOString()));
        throw new InvariantViolation(`${label}: ${bad.length} row(s) outside [${new Date(from).toISOString()}, ${new Date(to).toISOString()}] ± ${toleranceMs} ms: ${shown.join(', ')}`);
    }
}
