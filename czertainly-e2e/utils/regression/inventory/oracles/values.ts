/**
 * values — values of a DTO member and the row-level filter predicates.
 *
 * WHAT: Values of a DTO member and the row-level filter predicates of the listing oracles: scalar extraction, instants and
 *       datetime literals copied from the server's own text, `satisfiesFilter` (only for fields whose DTO mapping is known),
 *       the expected row set of an exact condition, and the sampled values a field oracle probes with.
 * WHY: Every oracle must read a field's values and evaluate a filter the same way.
 * HOW: Scalar extraction, instants and datetime literals copied from the server's text, `satisfiesFilter` (the one home of the filter
 * semantics), the expected row set of an exact condition and the sampled probe values.
 *
 *       Ordering (GREATER, GREATER_OR_EQUAL, LESSER, LESSER_OR_EQUAL) and the COUNT_* conditions read both sides as NUMBERS,
 *       also when a value is a numeric-looking string: "999" is less than "1000". Core publishes the ordering conditions only
 *       for number and datetime fields (the field's `shape` here: `number`, `datetime`), and compares numbers as numbers, so
 *       the numeric reading is the one that matches the server; a text order would put "999" after "1000". Datetimes are
 *       compared by the callers as instants (`instantMs`), never through this function as text. A value that is not a
 *       number never satisfies an ordering; a wanted value that is not a number is refused ("does not model").
 *       A condition that takes one value (everything except EQUALS, NOT_EQUALS, EMPTY and NOT_EMPTY) given several wanted
 *       values is refused the same way, instead of silently using the first.
 */
import type { CatalogueField } from '../searchApi';
import type { ListRow } from '../listInvariants';
import { ConditionKind } from './catalogueContract';

// ====================================================================================================================
// 1. Values of a DTO member
// ====================================================================================================================

export type Scalar = string | number | boolean;
export type Values = Scalar[];

/** The values a DTO member carries: null / undefined / [] are no value; arrays flatten (nulls dropped); objects are no value. */
export function toValues(raw: unknown): Values {
    if (raw === null || raw === undefined) return [];
    if (Array.isArray(raw)) return raw.flatMap((x) => toValues(x));
    if (typeof raw === 'string' || typeof raw === 'number' || typeof raw === 'boolean') return [raw];
    return [];
}

/** An instant in epoch milliseconds from a DTO datetime (ISO text with any number of fraction digits, or epoch seconds / ms). */
export function instantMs(v: unknown): number | undefined {
    if (typeof v === 'number') return Number.isFinite(v) ? (Math.abs(v) < 1e11 ? Math.round(v * 1000) : v) : undefined;
    if (typeof v !== 'string') return undefined;
    const t = Date.parse(v);
    return Number.isNaN(t) ? undefined : t;
}

/**
 * The filter literal of a DTO datetime: the server's own text with the fraction cut to milliseconds, the offset kept
 * (`yyyy-MM-dd'T'HH:mm:ss.SSSXXX` is what FilterPredicatesBuilder.java parses). A value that is not ISO text becomes
 * the UTC form of its instant.
 */
export function datetimeLiteral(v: unknown): string {
    if (typeof v === 'string') {
        const m = /^(\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2})(?:\.(\d+))?(Z|[+-]\d{2}:\d{2})$/.exec(v);
        if (m) return `${m[1]}${m[2] ? `.${m[2].slice(0, 3).padEnd(3, '0')}` : ''}${m[3]}`;
    }
    const ms = instantMs(v);
    if (ms === undefined) throw new Error(`datetimeLiteral: "${String(v)}" is not a datetime`);
    return new Date(ms).toISOString();
}

export const member = (name: string) => (r: ListRow): Values => toValues(r[name]);

export const nested = (...path: string[]) => (r: ListRow): Values => {
    let cur: unknown = r;
    for (const p of path) {
        if (cur === null || typeof cur !== 'object') return [];
        cur = (cur as Record<string, unknown>)[p];
    }
    return toValues(cur);
};

/** `row[array][i][name]` for every element: the names of the groups of a key, the uuids of the objects of an audit record. */
export const elementsOf = (path: string[], name: string) => (r: ListRow): Values => {
    let cur: unknown = r;
    for (const p of path) {
        if (cur === null || typeof cur !== 'object') return [];
        cur = (cur as Record<string, unknown>)[p];
    }
    return Array.isArray(cur) ? cur.flatMap((o) => toValues(o && typeof o === 'object' ? (o as Record<string, unknown>)[name] : undefined)) : [];
};

// ====================================================================================================================
// 3. Row predicates, samples
// ====================================================================================================================

const EXACT_CONDITIONS = new Set(['EMPTY', 'NOT_EMPTY', 'EQUALS', 'NOT_EQUALS', 'GREATER', 'GREATER_OR_EQUAL', 'LESSER', 'LESSER_OR_EQUAL', 'COUNT_EQUAL', 'COUNT_NOT_EQUAL', 'COUNT_GREATER_THAN', 'COUNT_LESS_THAN']);

/** Conditions whose answer is decided by equality or order alone: the baseline implies the exact row set. */
export const isExactCondition = (condition: string): boolean => EXACT_CONDITIONS.has(condition);

/** Conditions that read ONE wanted value: with a list, `satisfiesFilter` refuses instead of using the first. */
const NUMERIC_CONDITIONS = new Set(['GREATER', 'GREATER_OR_EQUAL', 'LESSER', 'LESSER_OR_EQUAL', 'COUNT_EQUAL', 'COUNT_NOT_EQUAL', 'COUNT_GREATER_THAN', 'COUNT_LESS_THAN']);
const SINGLE_VALUE_CONDITIONS = new Set(['CONTAINS', 'NOT_CONTAINS', 'STARTS_WITH', 'ENDS_WITH', 'MATCHES', 'NOT_MATCHES', ...NUMERIC_CONDITIONS]);

const asList = (value: unknown): unknown[] => (Array.isArray(value) ? value : [value]);
const lower = (v: Scalar): string => String(v).toLowerCase();

/** The regex source that matches `text` literally: every non-alphanumeric character is escaped (Java and PostgreSQL agree on that form). */
export const regexLiteral = (text: string): string => text.replace(/[^A-Za-z0-9]/g, (c) => `\\${c}`);

/**
 * Does a row with these `values` satisfy the filter? Reference rules (FilterPredicatesBuilder): EQUALS = any of the listed values equals a
 * value; NOT_EQUALS / NOT_CONTAINS include rows without a value; NOT_MATCHES excludes them; EMPTY = no value; number comparisons and the
 * positive string conditions need a value. STRING conditions are the WEAK forms (see the module header): CONTAINS / STARTS_WITH / ENDS_WITH
 * / MATCHES match case-insensitively, NOT_CONTAINS / NOT_MATCHES require no match case-sensitively. COUNT_* compare the number of values.
 * `caseSensitive` turns CONTAINS / STARTS_WITH / ENDS_WITH into exact-case tests (the strict reading `matchesCondition` offers).
 */
export function satisfiesFilter(values: Values, condition: string, value?: unknown, options: { caseSensitive?: boolean } = {}): boolean {
    const wanted = asList(value);
    if (SINGLE_VALUE_CONDITIONS.has(condition)) {
        if (wanted.length > 1) throw new Error(`satisfiesFilter does not model ${condition} with ${wanted.length} wanted values (it takes one): ${JSON.stringify(wanted)}`);
        if (NUMERIC_CONDITIONS.has(condition) && !Number.isFinite(Number(wanted[0]))) throw new Error(`satisfiesFilter does not model ${condition} with the non-numeric value ${JSON.stringify(wanted[0])}`);
    }
    const first = wanted.length ? String(wanted[0]) : '';
    const text = (v: Scalar): string => (options.caseSensitive ? String(v) : lower(v));
    const probe = options.caseSensitive ? first : first.toLowerCase();
    switch (condition) {
        case 'EMPTY': return values.length === 0;
        case 'NOT_EMPTY': return values.length > 0;
        case 'EQUALS': return values.some((v) => wanted.some((w) => String(v) === String(w)));
        case 'NOT_EQUALS': return !values.some((v) => wanted.some((w) => String(v) === String(w)));
        case 'CONTAINS': return values.some((v) => text(v).includes(probe));
        case 'NOT_CONTAINS': return !values.some((v) => String(v).includes(first));
        case 'STARTS_WITH': return values.some((v) => text(v).startsWith(probe));
        case 'ENDS_WITH': return values.some((v) => text(v).endsWith(probe));
        case 'MATCHES': return values.some((v) => new RegExp(first, 'i').test(String(v)));
        case 'NOT_MATCHES': return values.length > 0 && !values.some((v) => new RegExp(first).test(String(v)));
        case 'GREATER': return values.some((v) => Number(v) > Number(first));
        case 'GREATER_OR_EQUAL': return values.some((v) => Number(v) >= Number(first));
        case 'LESSER': return values.some((v) => Number(v) < Number(first));
        case 'LESSER_OR_EQUAL': return values.some((v) => Number(v) <= Number(first));
        case 'COUNT_EQUAL': return values.length === Number(first);
        case 'COUNT_NOT_EQUAL': return values.length !== Number(first);
        case 'COUNT_GREATER_THAN': return values.length > Number(first);
        case 'COUNT_LESS_THAN': return values.length < Number(first);
        default: throw new Error(`satisfiesFilter: no reference rule for ${condition}`);
    }
}

export interface FieldMap {
    /** The FilterField name the catalogue publishes (property source). */
    id: string;
    type: CatalogueField['type'];
    /** The kind of condition set core publishes for it (verified in core FilterField / SearchHelper). */
    kind: ConditionKind;
    /** How its values compare: text, number, datetime (an instant), boolean, or `code` (EQUALS / NOT_EQUALS only: enum codes, names). */
    shape: 'text' | 'number' | 'datetime' | 'boolean' | 'code';
    /** The DTO values of the field in one listing row; [] is "no value". */
    get: (row: ListRow) => Values;
    /** Expected catalogue `sortable` (SearchHelper.isSortableField) on a configurable listing. */
    sortable: boolean;
    /** How the sort order is verified; `structure`: the column is an enum stored by NAME, the DTO shows the CODE; `none`: not sortable. */
    sort: 'text' | 'number' | 'datetime' | 'boolean' | 'structure' | 'minMaxText' | 'none';
    /** Where the mapping was verified (file:line in core / interfaces). */
    evidence: string;
}

/** Rows (from a complete baseline) the filter must return, for the exact conditions; undefined for the weak string ones. */
export function expectedRows(rows: ListRow[], field: Pick<FieldMap, 'get'>, condition: string, value?: unknown): ListRow[] | undefined {
    if (!isExactCondition(condition)) return undefined;
    return rows.filter((r) => satisfiesFilter(field.get(r), condition, value));
}

/** Evenly spread picks from a sorted list: first, last, middle (n <= 3), distinct. */
export function pickSpread<T>(sorted: T[], n = 3): T[] {
    if (sorted.length <= n) return [...sorted];
    const idx = n === 1 ? [0] : n === 2 ? [0, sorted.length - 1] : [0, Math.floor((sorted.length - 1) / 2), sorted.length - 1];
    return [...new Set(idx)].map((i) => sorted[i]);
}

/**
 * At most `n` sample values of a field from the rows already read: numbers and datetimes spread over the range (smallest,
 * middle, largest), everything else first seen, most frequent, last seen. Values keep their DTO form.
 */
export function pickSampleValues(rows: ListRow[], field: Pick<FieldMap, 'get' | 'shape'>, n = 3): Scalar[] {
    const info = new Map<string, { v: Scalar; count: number; order: number }>();
    rows.forEach((r, i) => {
        for (const v of new Set(field.get(r).map(String))) {
            const original = field.get(r).find((x) => String(x) === v) as Scalar;
            const e = info.get(v);
            if (e) e.count += 1;
            else info.set(v, { v: original, count: 1, order: i });
        }
    });
    const all = [...info.values()];
    if (!all.length) return [];
    if (field.shape === 'number') return pickSpread(all.map((e) => Number(e.v)).sort((a, b) => a - b), n);
    if (field.shape === 'datetime') {
        const dated = all.map((e) => ({ v: e.v, t: instantMs(e.v) })).filter((e): e is { v: Scalar; t: number } => e.t !== undefined).sort((a, b) => a.t - b.t);
        return pickSpread(dated, n).map((e) => e.v);
    }
    const ordered = [...all].sort((a, b) => a.order - b.order);
    const frequent = [...all].sort((a, b) => b.count - a.count || a.order - b.order)[0];
    const picks = [ordered[0], frequent, ordered[ordered.length - 1]].slice(0, Math.max(n, 1));
    return [...new Map(picks.map((e) => [String(e.v), e.v])).values()].slice(0, n);
}

/** A run of [A-Za-z0-9 .:/-] characters: what a LIKE / regex probe may be made of (no wildcard, escape or quote). */
const SAFE_RUN = /[A-Za-z0-9 .:/-]+/g;

/** A prefix / suffix / inner probe (<= 4 characters) of a sampled text, or undefined when the text offers no safe one. */
export function textProbe(text: string, where: 'prefix' | 'suffix' | 'inner'): string | undefined {
    const safe = (s: string) => /^[A-Za-z0-9 .:/-]+$/.test(s);
    if (where === 'prefix') {
        const p = text.slice(0, 4);
        return p && safe(p) ? p : undefined;
    }
    if (where === 'suffix') {
        const s = text.slice(-4);
        return s && safe(s) ? s : undefined;
    }
    const runs = text.match(SAFE_RUN) ?? [];
    const longest = runs.sort((a, b) => b.length - a.length)[0];
    return longest ? longest.slice(0, 4) : undefined;
}
