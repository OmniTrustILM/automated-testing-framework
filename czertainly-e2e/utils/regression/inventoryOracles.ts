/**
 * inventoryOracles — the catalogue-driven oracle runner of the listing contracts API-GEN-11 (sort), API-GEN-12 (searchable-
 * fields catalogue), API-GEN-13 (keys), API-GEN-14 (discoveries) and API-GEN-15 (audit log) of the inventory-api area
 * (ilm#424, batch B2). Everything here is READ-ONLY on the target: listings and catalogues are `POST <listing>` /
 * `GET <listing>/search` reads (guardedApi POST_READ), the audit-log own-activity probe only reads the audit log; the one
 * mutation of that row (a group create) lives in the spec behind the guard and the own-object ledger.
 *
 * What it is: a runner that takes a LISTING (`ListingSpec`: search URL, catalogue URL, the response member holding the
 * rows, the row key, and a table of the property fields with their verified DTO member) and runs PROPERTY oracles over
 * whatever data the tier holds (no exact counts):
 *   - catalogue contract: shape (Ajv), the conditions of every field equal to the absolute set of its TYPE / KIND, unique
 *     identifiers, non-empty labels, `sortable` / `displayable` consistency (`catalogueProblems`);
 *   - per field and sampled value (<= 3): every returned row satisfies the filter (row-level predicate over the DTO), the
 *     returned set equals the set the baseline walk implies for the exact conditions (EQUALS, NOT_EQUALS, EMPTY, NOT_EMPTY,
 *     number comparisons), |EMPTY| + |NOT_EMPTY| = total, |EQUALS v| + |NOT_EQUALS v| = total, |CONTAINS s| + |NOT_CONTAINS
 *     s| = total, |MATCHES| + |NOT_MATCHES| = |NOT_EMPTY|, GREATER n and LESSER_OR_EQUAL n partition the non-null rows,
 *     the COUNT_* conditions of a collection, datetime partitions and IN_PAST / IN_NEXT windows (`runFieldOracles`);
 *   - AND of two filters is the intersection of both (`runAndOracle`), the pages add up to the total (`loadBaseline` over
 *     invariants.walkPages);
 *   - sort: non-decreasing in both directions with empty values last, page 2 continues page 1 (pages of 50 concatenated =
 *     one request), a second read answers the same order, asc and desc mirror each other (`runSortField`).
 * The pure checkers come from utils/regression/invariants.ts (walkPages, expectSorted, expectEmptyPlusNotEmptyEqualsTotal,
 * expectAndNarrows); what it lacks lives here (count partitions, set equality, continuation, null block, mirror, text
 * order, tie-break, the closed audit window, the logging-settings gate).
 *
 * Honesty rules (rules §2.2, §2.3; core FilterPredicatesBuilder, SortOrderBuilder, SearchHelper):
 *   - a row-level predicate exists only for fields whose DTO mapping was read in core / interfaces (the tables below carry
 *     the evidence); every other field is checked by the count relations alone (`runGenericFieldOracles`);
 *   - string conditions use the WEAK predicates that hold on a case-sensitive server (core#712 open) and on a fixed one:
 *     positive conditions match case-insensitively, negative ones must not match case-sensitively; sampled substrings never
 *     contain a LIKE wildcard (`%`, `_`; core#2505), a backslash or a quote;
 *   - datetime values are filter literals copied from the DTO text (truncated to milliseconds, offset kept): the platform
 *     parses the offset and drops it (inventory-api §2.2 r17, Q4), so a literal from the server's own text is the one
 *     reading that cannot drift; the relations on datetimes are partitions and an ordering of the two sets, never an
 *     exact set;
 *   - text sort order is verified where the order is decidable without knowing the database collation (both strings made of
 *     [a-z0-9] only: code-unit order; otherwise either the code-unit or an `en` collator order is accepted) and enum
 *     columns, which the database stores by enum NAME while the DTO shows the CODE, are checked structurally only;
 *   - one re-read absorbs a concurrent change (`withReread`, API-CERT-50 wording); a second mismatch fails.
 *
 * Pure functions are exported and unit-tested without an environment (tests/unit/inventory-oracles*.spec.ts); the runner
 * talks to a `Transport` (`guardedTransport(api)` for the specs, a fake listing in the unit tests).
 */
import Ajv from 'ajv';
import { expect } from '@playwright/test';
import type { GuardedApi } from './guardedApi';
import { ALL_CONDITIONS, CONDITION_KINDS, CONDITION_SETS, prop, readProbe, sameSet, send } from './inventoryApi';
import type { CatalogueField, CatalogueGroup, Filter, Probe, Sort } from './inventoryApi';
import { expectAndNarrows, expectEmptyPlusNotEmptyEqualsTotal, expectSorted, InvariantViolation, walkPages } from './invariants';
import type { Row } from './invariants';

export { InvariantViolation };
export type { Row };

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
 * (`yyyy-MM-dd'T'HH:mm:ss.SSSXXX` is what FilterPredicatesBuilder.java:1101-1107 parses). A value that is not ISO text becomes
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

const member = (name: string) => (r: Row): Values => toValues(r[name]);

const nested = (...path: string[]) => (r: Row): Values => {
    let cur: unknown = r;
    for (const p of path) {
        if (cur === null || typeof cur !== 'object') return [];
        cur = (cur as Record<string, unknown>)[p];
    }
    return toValues(cur);
};

/** `row[array][i][name]` for every element: the names of the groups of a key, the uuids of the objects of an audit record. */
const elementsOf = (path: string[], name: string) => (r: Row): Values => {
    let cur: unknown = r;
    for (const p of path) {
        if (cur === null || typeof cur !== 'object') return [];
        cur = (cur as Record<string, unknown>)[p];
    }
    return Array.isArray(cur) ? cur.flatMap((o) => toValues(o && typeof o === 'object' ? (o as Record<string, unknown>)[name] : undefined)) : [];
};

// ====================================================================================================================
// 2. The catalogue contract (API-GEN-12)
// ====================================================================================================================

/**
 * The kinds of condition set a catalogue field can publish. Derived from core `SearchFieldTypeEnum` (STRING, DATE, DATETIME,
 * NUMBER, LIST, NATIVE_ARRAY, PRESENCE, FREE_TEXT, BOOLEAN) and `SearchHelper.availableConditions` / `prepareSearchForJSON`:
 *   string 10 · number 8 · date 10 (date and datetime) · time 8 (a TIME attribute: the date set without IN_NEXT / IN_PAST) ·
 *   list 4 · collection 8 (a list over a collection: + COUNT_*) · nativeArray 6 (+ CONTAINS, NOT_CONTAINS) ·
 *   jsonArray 4 (a string field over a JSON array path: the list set, SearchHelper.getInitialCapacity) · boolean 4 ·
 *   expectedBoolean 2 (EQUALS, NOT_EQUALS: PRIVATE_KEY, CBOM_HAS_CONTRIBUTED_ASSETS) · presence 2 (EMPTY, NOT_EMPTY: no
 *   attribute behind the field, or an attribute whose content no listing renders) · freeText 1 (CONTAINS: crypto assets).
 * (SearchHelper.java:107-210, enums/SearchFieldTypeEnum.java:1-90.)
 */
export type ConditionKind = 'string' | 'number' | 'date' | 'time' | 'list' | 'collection' | 'nativeArray' | 'jsonArray' | 'boolean' | 'expectedBoolean' | 'presence' | 'freeText';

export const KIND_CONDITIONS: Readonly<Record<ConditionKind, readonly string[]>> = {
    string: CONDITION_SETS.string,
    number: CONDITION_SETS.number,
    date: CONDITION_SETS.date,
    time: CONDITION_KINDS.time,
    list: CONDITION_SETS.list,
    collection: CONDITION_KINDS.collection,
    nativeArray: CONDITION_KINDS.nativeArray,
    jsonArray: CONDITION_SETS.list,
    boolean: CONDITION_SETS.boolean,
    expectedBoolean: CONDITION_KINDS.expectedBoolean,
    presence: CONDITION_KINDS.presence,
    freeText: ['CONTAINS'],
};

/** Which kinds a field of a `FilterFieldType` may publish (the type decides which of the equal-looking 4-sets it is). */
export const KINDS_OF_TYPE: Readonly<Record<string, readonly ConditionKind[]>> = {
    string: ['string', 'jsonArray', 'presence', 'freeText'],
    number: ['number', 'presence'],
    date: ['date', 'time', 'presence'],
    datetime: ['date', 'presence'],
    list: ['list', 'collection', 'nativeArray', 'presence'],
    boolean: ['boolean', 'expectedBoolean', 'presence'],
};

/** The kind a field's published conditions are, given its type; undefined when they are none of the known sets (a failure). */
export function classifyConditions(type: string, conditions: readonly string[]): ConditionKind | undefined {
    const allowed = KINDS_OF_TYPE[type];
    if (!allowed || !Array.isArray(conditions)) return undefined;
    return allowed.find((k) => sameSet(conditions, KIND_CONDITIONS[k]));
}

/** Kinds whose field may be sortable (SearchHelper.isOrderableField: an attribute behind it, not a native array, not derived). */
const SORTABLE_KINDS: ReadonlySet<ConditionKind> = new Set<ConditionKind>(['string', 'number', 'date', 'time', 'list', 'collection', 'boolean']);

const FIELD_TYPES = ['string', 'number', 'list', 'date', 'datetime', 'boolean'];
const SOURCES = ['property', 'meta', 'custom', 'data'];

/** SearchFieldDataByGroupDto / SearchFieldDataDto (interfaces model/core/search/), hand-written; extra members are allowed (reported). */
export const CATALOGUE_SCHEMA = {
    type: 'array',
    items: {
        type: 'object',
        required: ['filterFieldSource'],
        properties: {
            filterFieldSource: { enum: SOURCES },
            searchFieldData: {
                type: ['array', 'null'],
                items: {
                    type: 'object',
                    required: ['fieldIdentifier', 'fieldLabel', 'type', 'conditions'],
                    properties: {
                        fieldIdentifier: { type: 'string', minLength: 1 },
                        fieldLabel: { type: 'string', minLength: 1 },
                        type: { enum: FIELD_TYPES },
                        conditions: { type: 'array', minItems: 1, uniqueItems: true, items: { enum: [...ALL_CONDITIONS] } },
                        platformEnum: { type: ['string', 'null'] },
                        attributeContentType: { type: ['string', 'null'] },
                        multiValue: { type: ['boolean', 'null'] },
                        displayable: { type: ['boolean', 'null'] },
                        sortable: { type: ['boolean', 'null'] },
                    },
                },
            },
        },
    },
} as const;

let ajv: Ajv | undefined;
const validator = () => (ajv ??= new Ajv({ allErrors: true, strict: false })).compile(CATALOGUE_SCHEMA as unknown as object);

export interface CatalogueExpectations {
    /** The listing is wired to the configurable-column pipeline (SearchHelper.CONFIGURABLE_COLUMN_RESOURCES :248-250). */
    configurable: boolean;
    /** Only the Property source may be published (the audit log, AuditLogServiceImpl.java:193-205). */
    onlyProperty?: boolean;
    /** Known property fields: the type, the condition kind and, on a configurable listing, `sortable`. Each must be published. */
    known?: Readonly<Record<string, { type: CatalogueField['type']; kind: ConditionKind; sortable?: boolean }>>;
}

export interface CatalogueFieldFact {
    source: string;
    id: string;
    type: string;
    kind?: ConditionKind;
    sortable?: boolean;
    displayable?: boolean;
}

export interface CatalogueReport {
    problems: string[];
    fields: CatalogueFieldFact[];
}

/** Every problem of one searchable-fields catalogue body (pure). `problems` empty means the contract holds. */
export function catalogueProblems(body: unknown, exp: CatalogueExpectations): CatalogueReport {
    const problems: string[] = [];
    const fields: CatalogueFieldFact[] = [];
    const validate = validator();
    if (!validate(body)) {
        const first = (validate.errors ?? []).slice(0, 8).map((e) => `${e.instancePath || '/'} ${e.message ?? 'invalid'}`);
        return { problems: [`not a SearchFieldDataByGroupDto list: ${first.join('; ')}`], fields };
    }
    const groups = body as CatalogueGroup[];
    const sources = groups.map((g) => g.filterFieldSource);
    if (new Set(sources).size !== sources.length) problems.push(`a source is published twice: [${sources.join(', ')}]`);
    if (!sources.includes('property')) problems.push('no property group');
    if (exp.onlyProperty && sources.some((s) => s !== 'property')) problems.push(`only the property source may be published, got [${sources.join(', ')}]`);

    for (const g of groups) {
        const seen = new Set<string>();
        for (const f of g.searchFieldData ?? []) {
            const id = f.fieldIdentifier;
            const at = `${g.filterFieldSource}:${id}`;
            if (seen.has(id)) problems.push(`${at}: identifier published twice in the ${g.filterFieldSource} group`);
            seen.add(id);
            if (!f.fieldLabel.trim()) problems.push(`${at}: blank label`);
            if (!id.trim()) problems.push(`${at}: blank identifier`);
            const isProperty = g.filterFieldSource === 'property';
            if (isProperty && !/^[A-Z][A-Z0-9_]*$/.test(id)) problems.push(`${at}: a property identifier is a FilterField name (UPPER_SNAKE)`);
            if (!isProperty && !/^.+\|[A-Z][A-Z0-9_]*$/.test(id)) problems.push(`${at}: an attribute identifier is <name>|<CONTENT_TYPE> (SearchHelper.buildFieldIdentifier)`);
            if (isProperty && f.attributeContentType) problems.push(`${at}: a property field carries attributeContentType ${f.attributeContentType}`);
            if (!isProperty && !f.attributeContentType) problems.push(`${at}: an attribute field carries no attributeContentType`);

            const kind = classifyConditions(f.type, f.conditions);
            if (!kind) {
                problems.push(`${at}: conditions [${f.conditions.join(', ')}] are none of the absolute sets of type ${f.type} ` +
                    `(${(KINDS_OF_TYPE[f.type] ?? []).map((k) => `${k}: ${KIND_CONDITIONS[k].length}`).join(', ')})`);
            } else {
                if (kind === 'time' && (isProperty || String(f.attributeContentType).toLowerCase() !== 'time')) problems.push(`${at}: the 8-condition date set belongs to a TIME attribute only`);
                if ((kind === 'collection' || kind === 'jsonArray' || kind === 'expectedBoolean' || kind === 'freeText') && !isProperty) problems.push(`${at}: kind ${kind} exists on property fields only`);
                if (kind === 'nativeArray' && f.multiValue !== true) problems.push(`${at}: a native-array field is multiValue`);
            }
            if (isProperty && typeof f.multiValue === 'boolean' && f.multiValue !== (f.type === 'list')) problems.push(`${at}: multiValue ${f.multiValue} for type ${f.type} (SearchHelper.prepareSearch: only LIST types are multi-valued)`);
            if (f.sortable === true && f.displayable === false) problems.push(`${at}: sortable but not displayable (core#2180)`);
            if (!exp.configurable && (f.sortable === true || f.displayable === true)) {
                problems.push(`${at}: sortable ${String(f.sortable)} / displayable ${String(f.displayable)} on a listing that is not wired to configurable columns (SearchHelper.listingAppliesSort, RequestValidatorHelper.java:24-30)`);
            }
            if (f.sortable === true && kind && !SORTABLE_KINDS.has(kind)) problems.push(`${at}: sortable, but a ${kind} field has nothing to order by (SearchHelper.isOrderableField :336-340)`);
            fields.push({ source: g.filterFieldSource, id, type: f.type, kind, sortable: f.sortable ?? undefined, displayable: f.displayable ?? undefined });
        }
    }

    const property = new Map(fields.filter((f) => f.source === 'property').map((f) => [f.id, f]));
    for (const [id, want] of Object.entries(exp.known ?? {})) {
        const got = property.get(id);
        if (!got) {
            problems.push(`property:${id}: missing from the catalogue`);
            continue;
        }
        if (got.type !== want.type) problems.push(`property:${id}: type ${got.type}, expected ${want.type}`);
        if (got.kind !== want.kind) problems.push(`property:${id}: conditions of kind ${got.kind ?? '?'}, expected ${want.kind} [${KIND_CONDITIONS[want.kind].join(', ')}]`);
        if (exp.configurable && want.sortable !== undefined && (got.sortable ?? false) !== want.sortable) {
            problems.push(`property:${id}: sortable ${String(got.sortable)}, expected ${want.sortable}`);
        }
    }
    return { problems, fields };
}

// ====================================================================================================================
// 3. Row predicates, samples
// ====================================================================================================================

const EXACT_CONDITIONS = new Set(['EMPTY', 'NOT_EMPTY', 'EQUALS', 'NOT_EQUALS', 'GREATER', 'GREATER_OR_EQUAL', 'LESSER', 'LESSER_OR_EQUAL', 'COUNT_EQUAL', 'COUNT_NOT_EQUAL', 'COUNT_GREATER_THAN', 'COUNT_LESS_THAN']);

/** Conditions whose answer is decided by equality or order alone: the baseline implies the exact row set. */
export const isExactCondition = (condition: string): boolean => EXACT_CONDITIONS.has(condition);

const asList = (value: unknown): unknown[] => (Array.isArray(value) ? value : [value]);
const lower = (v: Scalar): string => String(v).toLowerCase();

/** The regex source that matches `text` literally: every non-alphanumeric character is escaped (Java and PostgreSQL agree on that form). */
export const regexLiteral = (text: string): string => text.replace(/[^A-Za-z0-9]/g, (c) => `\\${c}`);

/**
 * Does a row with these `values` satisfy the filter? Reference rules (inventory-api §2.2 r12-r16, FilterPredicatesBuilder
 * :540-720): EQUALS = any of the listed values equals a value; NOT_EQUALS / NOT_CONTAINS include rows without a value;
 * NOT_MATCHES excludes them; EMPTY = no value; number comparisons and the positive string conditions need a value.
 * STRING conditions are the WEAK forms (see the module header): CONTAINS / STARTS_WITH / ENDS_WITH / MATCHES match
 * case-insensitively, NOT_CONTAINS / NOT_MATCHES require no match case-sensitively. COUNT_* compare the number of values.
 */
export function satisfiesFilter(values: Values, condition: string, value?: unknown): boolean {
    const wanted = asList(value);
    const first = wanted.length ? String(wanted[0]) : '';
    switch (condition) {
        case 'EMPTY': return values.length === 0;
        case 'NOT_EMPTY': return values.length > 0;
        case 'EQUALS': return values.some((v) => wanted.some((w) => String(v) === String(w)));
        case 'NOT_EQUALS': return !values.some((v) => wanted.some((w) => String(v) === String(w)));
        case 'CONTAINS': return values.some((v) => lower(v).includes(first.toLowerCase()));
        case 'NOT_CONTAINS': return !values.some((v) => String(v).includes(first));
        case 'STARTS_WITH': return values.some((v) => lower(v).startsWith(first.toLowerCase()));
        case 'ENDS_WITH': return values.some((v) => lower(v).endsWith(first.toLowerCase()));
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
    get: (row: Row) => Values;
    /** Expected catalogue `sortable` (SearchHelper.isSortableField) on a configurable listing. */
    sortable: boolean;
    /** How the sort order is verified; `structure`: the column is an enum stored by NAME, the DTO shows the CODE; `none`: not sortable. */
    sort: 'text' | 'number' | 'datetime' | 'boolean' | 'structure' | 'minMaxText' | 'none';
    /** Where the mapping was verified (file:line in core / interfaces). */
    evidence: string;
}

/** Rows (from a complete baseline) the filter must return, for the exact conditions; undefined for the weak string ones. */
export function expectedRows(rows: Row[], field: Pick<FieldMap, 'get'>, condition: string, value?: unknown): Row[] | undefined {
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
export function sampleValues(rows: Row[], field: Pick<FieldMap, 'get' | 'shape'>, n = 3): Scalar[] {
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

// ====================================================================================================================
// 4. Pure checkers (besides invariants.ts)
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

export function expectKeysEqual(label: string, actual: Row[], expected: Row[], key: (r: Row) => string): void {
    const a = new Set(actual.map(key));
    const e = new Set(expected.map(key));
    const missing = [...e].filter((k) => !a.has(k));
    const extra = [...a].filter((k) => !e.has(k));
    if (missing.length || extra.length) throw new InvariantViolation(`${label}: missing ${preview(missing)}, unexpected ${preview(extra)} (returned ${a.size}, expected ${e.size})`);
}

export function expectSubset(label: string, sub: Row[], sup: Row[], key: (r: Row) => string): void {
    const s = new Set(sup.map(key));
    const outside = sub.map(key).filter((k) => !s.has(k));
    if (outside.length) throw new InvariantViolation(`${label}: ${outside.length} row(s) outside the superset ${preview(outside)}`);
}

/** A and B returns exactly the intersection of A and B (filters are ANDed, FilterPredicatesBuilder.java:121-151). */
export function expectIntersection(label: string, a: Row[], b: Row[], ab: Row[], key: (r: Row) => string): void {
    const inB = new Set(b.map(key));
    expectKeysEqual(label, ab, a.filter((r) => inB.has(key(r))), key);
}

/** Pages of one size, concatenated, are the first rows of one big request, in the same order. */
export function expectContinuation(label: string, pages: Row[][], whole: Row[], key: (r: Row) => string): void {
    const flat = pages.flat().map(key);
    const big = whole.map(key);
    if (flat.length < big.length) throw new InvariantViolation(`${label}: the pages hold ${flat.length} rows, the single request ${big.length}`);
    for (let i = 0; i < big.length; i++) {
        if (flat[i] !== big[i]) throw new InvariantViolation(`${label}: row ${i} is ${flat[i]} across the pages but ${big[i]} in the single request`);
    }
}

export function expectSameOrder(label: string, a: Row[], b: Row[], key: (r: Row) => string): void {
    const x = a.map(key);
    const y = b.map(key);
    const at = x.findIndex((k, i) => k !== y[i]);
    if (x.length !== y.length || at >= 0) throw new InvariantViolation(`${label}: two identical requests answered different orders (first difference at row ${at < 0 ? Math.min(x.length, y.length) : at})`);
}

/** Once a row without a value appears, no row with a value follows (empty values last). */
export function expectNullsLast(label: string, rows: Row[], isNull: (r: Row) => boolean, key: (r: Row) => string): void {
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
export function expectMirror(label: string, asc: Row[], desc: Row[], valueOf: (r: Row) => string | undefined): void {
    const a = asc.map(valueOf).filter((v): v is string => v !== undefined);
    const d = desc.map(valueOf).filter((v): v is string => v !== undefined).reverse();
    if (a.length !== d.length) throw new InvariantViolation(`${label}: ${a.length} values ascending, ${d.length} descending`);
    const at = a.findIndex((v, i) => v !== d[i]);
    if (at >= 0) throw new InvariantViolation(`${label}: ascending value ${at} is "${a[at]}", the mirrored descending one "${d[at]}"`);
}

const simpleText = (s: string): boolean => /^[a-z0-9]+$/.test(s);
const collator = new Intl.Collator('en');
const codeUnit = (a: string, b: string): number => (a < b ? -1 : a > b ? 1 : 0);

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
export function expectOrderedText(label: string, rows: Row[], valueOf: (r: Row) => string | undefined, dir: 'asc' | 'desc', key: (r: Row) => string): void {
    let prev: { v: string; r: Row } | undefined;
    for (const r of rows) {
        const v = valueOf(r);
        if (v === undefined) continue;
        if (prev && !textOrdered(prev.v, v, dir)) throw new InvariantViolation(`${label}: ${key(prev.r)}="${prev.v}" comes before ${key(r)}="${v}"`);
        prev = { v, r };
    }
}

/** Equal sort values are ordered by key ascending (core SortOrderBuilder.tieBreak :253-259 appends `uuid asc` in both directions; open question Q-G). */
export function expectTieBreakAscending(label: string, rows: Row[], valueOf: (r: Row) => string | undefined, key: (r: Row) => string): number {
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
export function expectRowsSatisfy(label: string, rows: Row[], field: Pick<FieldMap, 'get'>, condition: string, value: unknown, key: (r: Row) => string): void {
    const bad = rows.filter((r) => !satisfiesFilter(field.get(r), condition, value));
    if (bad.length) {
        const shown = bad.slice(0, 4).map((r) => `${key(r)}=${JSON.stringify(field.get(r))}`);
        throw new InvariantViolation(`${label}: ${bad.length} of ${rows.length} returned row(s) do not satisfy ${condition} ${JSON.stringify(value ?? null)}: ${shown.join('; ')}`);
    }
}

/** Every instant of the LOWER set is not after any instant of the UPPER set (the two halves of a datetime partition are ordered). */
export function expectInstantOrder(label: string, lowerSet: Row[], upperSet: Row[], valueOf: (r: Row) => number | undefined): void {
    const lo = lowerSet.map(valueOf).filter((v): v is number => v !== undefined);
    const hi = upperSet.map(valueOf).filter((v): v is number => v !== undefined);
    if (!lo.length || !hi.length) return;
    const maxLo = Math.max(...lo);
    const minHi = Math.min(...hi);
    if (maxLo > minHi) throw new InvariantViolation(`${label}: the lower half reaches ${new Date(maxLo).toISOString()}, the upper half starts at ${new Date(minHi).toISOString()}`);
}

/** A window predicate for IN_PAST / IN_NEXT: every instant lies in [from, to] widened by the skew tolerance. */
export function expectInstantsWithin(label: string, rows: Row[], valueOf: (r: Row) => number | undefined, from: number, to: number, toleranceMs: number): void {
    const bad = rows.filter((r) => {
        const t = valueOf(r);
        return t === undefined || t < from - toleranceMs || t > to + toleranceMs;
    });
    if (bad.length) {
        const shown = bad.slice(0, 3).map((r) => String(valueOf(r) === undefined ? 'no value' : new Date(valueOf(r)!).toISOString()));
        throw new InvariantViolation(`${label}: ${bad.length} row(s) outside [${new Date(from).toISOString()}, ${new Date(to).toISOString()}] ± ${toleranceMs} ms: ${shown.join(', ')}`);
    }
}

/** Collects what a run checked and what it noted (absorbed re-reads, skipped arms), for the test annotations. */
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

/** Runs `fn`; on an InvariantViolation runs it ONCE more from scratch (a concurrent change); a second violation fails with both texts. */
export async function withReread<T>(label: string, log: RunLog, fn: () => Promise<T>): Promise<T> {
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

// ====================================================================================================================
// 5. Listings: transport, pages, baseline
// ====================================================================================================================

export interface Transport {
    /** A read-only POST (a listing search); named `postRead` so the deny-by-default lint does not mistake it for a context `.post`. */
    postRead(url: string, body: unknown): Promise<Probe>;
    get(url: string): Promise<Probe>;
}

/** The transport of the specs: reads and read-only POSTs through the guarded `api` fixture (the guard judges every request). */
export function guardedTransport(api: GuardedApi): Transport {
    return {
        postRead: (url, body) => send(api, 'POST', url, { data: body }),
        get: (url) => readProbe(api, url),
    };
}

export interface ListingSpec {
    name: string;
    /** POST: `/api/v1/keys`, `/api/v1/discoveries/list`, `/api/v1/auditLogs`. */
    searchUrl: string;
    /** GET: the searchable-fields catalogue. */
    catalogueUrl: string;
    /** The member of the answer holding the rows (`cryptographicKeys`, `discoveries`, `items`). */
    rowsMember: string;
    rowKey: (row: Row) => string;
    configurable: boolean;
    /** The listing's resource label in "Sorting is not supported for the <label> listing." (Resource.getLabel). */
    refusalLabel: string;
    fields: FieldMap[];
    /** Filters attached to every request (the audit log's closed window). */
    baseFilters?: Filter[];
    /** Most rows a baseline or a filtered set is read in full (the area budget: 1000 for keys). */
    maxWalkRows: number;
}

export class ListingError extends Error {
    constructor(readonly status: number, readonly body: string, message: string) {
        super(message);
        this.name = 'ListingError';
    }
}

export interface ListingPage {
    rows: Row[];
    total: number;
    totalPages: number;
    itemsPerPage: number;
    pageNumber: number;
    /** The server's clock (Date header of the answer), epoch ms. */
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

/** One page of a listing (200 required); a refusal throws ListingError with the status and the first 300 characters. */
export async function listingPage(t: Transport, spec: ListingSpec, req: PageRequest = {}): Promise<ListingPage> {
    const body = requestBody(spec, req);
    const p = await t.postRead(spec.searchUrl, body);
    if (p.status !== 200) throw new ListingError(p.status, p.text.slice(0, 300), `${spec.name}: ${JSON.stringify(body).slice(0, 240)} answered ${p.status} ${p.text.slice(0, 300)}`);
    const json = p.json as Record<string, unknown> | undefined;
    const rows = json?.[spec.rowsMember];
    if (!Array.isArray(rows)) throw new ListingError(p.status, p.text.slice(0, 300), `${spec.name}: the answer has no "${spec.rowsMember}" array: ${p.text.slice(0, 200)}`);
    const date = p.headers.date ? Date.parse(p.headers.date) : NaN;
    return {
        rows: rows as Row[],
        total: Number(json!.totalItems),
        totalPages: Number(json!.totalPages),
        itemsPerPage: Number(json!.itemsPerPage),
        pageNumber: Number(json!.pageNumber),
        serverNow: Number.isNaN(date) ? undefined : date,
    };
}

export const listingTotal = async (t: Transport, spec: ListingSpec, filters: Filter[] = []): Promise<number> => (await listingPage(t, spec, { filters, size: 1 })).total;

export interface RowSet {
    rows: Row[];
    total: number;
    /** `rows` holds every row of the filtered set (total <= cap). */
    complete: boolean;
}

/** The rows of a filtered (and optionally sorted) set, page by page up to `cap`; a complete set must hold exactly `total` distinct rows. */
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
    rows: Row[];
    total: number;
    complete: boolean;
}

/**
 * The unfiltered listing: when it fits the budget, every page walked with invariants.walkPages (totalItems = sum of pages,
 * totalPages = ceil(total / size), no row on two pages); else its first `maxWalkRows` rows only (`complete: false`).
 */
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

// ====================================================================================================================
// 6. Field oracles (API-GEN-13 / -14 / -15)
// ====================================================================================================================

const SKEW_MS = 120_000;
const DAY_MS = 86_400_000;

/**
 * Every oracle of one mapped property field against the live listing, with the published conditions of its catalogue entry
 * deciding what runs. Throws InvariantViolation / ListingError on the first violation.
 */
export async function runFieldOracles(t: Transport, spec: ListingSpec, field: FieldMap, live: CatalogueField, base: Baseline, log: RunLog): Promise<void> {
    const adv = new Set(live.conditions);
    const key = spec.rowKey;
    const cap = spec.maxWalkRows;
    const f = (condition: string, value?: unknown): Filter[] => [prop(field.id, condition, value)];
    const baseline = base.complete ? base.rows : undefined;
    const sampleRows = base.rows;
    const here = (c: string, v?: unknown) => `${field.id} ${c}${v === undefined ? '' : ` ${JSON.stringify(v)}`}`;

    /** One filtered set, with the row-level predicate and (for exact conditions on a complete baseline) the exact set checked. */
    const check = async (condition: string, value?: unknown): Promise<RowSet> => {
        const set = await fetchRows(t, spec, f(condition, value), cap);
        expectRowsSatisfy(here(condition, value), set.rows, field, condition, value, key);
        if (baseline && set.complete) {
            const want = expectedRows(baseline, field, condition, value);
            if (want) expectKeysEqual(`${here(condition, value)}: the returned set differs from the one the full listing implies`, set.rows, want, key);
        }
        return set;
    };

    // |EMPTY| + |NOT_EMPTY| = total (rules §2.4, API-CERT-50 wording).
    let notEmptyTotal: number | undefined;
    if (adv.has('EMPTY') && adv.has('NOT_EMPTY')) {
        const e = await check('EMPTY');
        const n = await check('NOT_EMPTY');
        notEmptyTotal = n.total;
        expectCountsAdd(`${field.id}: EMPTY + NOT_EMPTY`, [['EMPTY', e.total], ['NOT_EMPTY', n.total]], base.total);
        if (e.complete && n.complete && base.complete) expectEmptyPlusNotEmptyEqualsTotal({ total: base.total, empty: e.rows, notEmpty: n.rows }, field.id, { key });
        log.step(`${field.id}: EMPTY ${e.total} + NOT_EMPTY ${n.total} = ${base.total}`);
    }
    const notEmpty = async (): Promise<number> => (notEmptyTotal ??= await listingTotal(t, spec, f('NOT_EMPTY')));

    const samples = sampleValues(sampleRows, field, 3);
    if (!samples.length) log.note(`${field.id}: no row of the first ${sampleRows.length} carries a value; the value conditions were not exercised`);

    // EQUALS v + NOT_EQUALS v = total.
    if (adv.has('EQUALS') && adv.has('NOT_EQUALS') && field.shape !== 'datetime') {
        for (const v of samples) {
            const eq = await check('EQUALS', v);
            const ne = await check('NOT_EQUALS', v);
            expectCountsAdd(`${here('EQUALS/NOT_EQUALS', v)}`, [['EQUALS', eq.total], ['NOT_EQUALS', ne.total]], base.total);
            log.step(`${field.id}: EQUALS ${JSON.stringify(v)} ${eq.total} + NOT_EQUALS ${ne.total} = ${base.total}`);
        }
    }

    // STRING: CONTAINS / NOT_CONTAINS complement, STARTS_WITH, ENDS_WITH, MATCHES / NOT_MATCHES partition of the non-null rows.
    if (field.shape === 'text') {
        for (const v of samples.map(String)) {
            const inner = textProbe(v, 'inner');
            if (inner && adv.has('CONTAINS') && adv.has('NOT_CONTAINS')) {
                const c = await check('CONTAINS', inner);
                const nc = await check('NOT_CONTAINS', inner);
                expectCountsAdd(here('CONTAINS/NOT_CONTAINS', inner), [['CONTAINS', c.total], ['NOT_CONTAINS', nc.total]], base.total);
                log.step(`${field.id}: CONTAINS ${JSON.stringify(inner)} ${c.total} + NOT_CONTAINS ${nc.total} = ${base.total}`);
            }
            const prefix = textProbe(v, 'prefix');
            if (prefix && adv.has('STARTS_WITH')) {
                await check('STARTS_WITH', prefix);
                log.step(`${field.id}: STARTS_WITH ${JSON.stringify(prefix)}: every row satisfies it`);
            }
            if (prefix && adv.has('MATCHES') && adv.has('NOT_MATCHES')) {
                const re = `^${regexLiteral(prefix)}`;
                const m = await check('MATCHES', re);
                const nm = await check('NOT_MATCHES', re);
                expectCountsAdd(here('MATCHES/NOT_MATCHES', re), [['MATCHES', m.total], ['NOT_MATCHES', nm.total]], await notEmpty());
                log.step(`${field.id}: MATCHES ${JSON.stringify(re)} ${m.total} + NOT_MATCHES ${nm.total} = NOT_EMPTY ${await notEmpty()}`);
            }
            const suffix = textProbe(v, 'suffix');
            if (suffix && adv.has('ENDS_WITH')) {
                await check('ENDS_WITH', suffix);
                log.step(`${field.id}: ENDS_WITH ${JSON.stringify(suffix)}: every row satisfies it`);
            }
        }
    }

    // NUMBER: GREATER n and LESSER_OR_EQUAL n (GREATER_OR_EQUAL n and LESSER n) partition the non-null rows.
    if (field.shape === 'number' && adv.has('GREATER') && adv.has('LESSER_OR_EQUAL') && adv.has('GREATER_OR_EQUAL') && adv.has('LESSER')) {
        for (const n of samples) {
            const gt = await check('GREATER', n);
            const le = await check('LESSER_OR_EQUAL', n);
            expectCountsAdd(here('GREATER/LESSER_OR_EQUAL', n), [['GREATER', gt.total], ['LESSER_OR_EQUAL', le.total]], await notEmpty());
            const ge = await check('GREATER_OR_EQUAL', n);
            const lt = await check('LESSER', n);
            expectCountsAdd(here('GREATER_OR_EQUAL/LESSER', n), [['GREATER_OR_EQUAL', ge.total], ['LESSER', lt.total]], await notEmpty());
            log.step(`${field.id}: ${n}: GREATER ${gt.total} + LESSER_OR_EQUAL ${le.total} = NOT_EMPTY ${await notEmpty()}; GREATER_OR_EQUAL ${ge.total} + LESSER ${lt.total}`);
        }
    }

    // DATETIME: the literals are copied from the DTO text; partitions and the order of the halves, IN_PAST / IN_NEXT windows.
    if (field.shape === 'datetime' && adv.has('GREATER') && adv.has('LESSER_OR_EQUAL') && adv.has('GREATER_OR_EQUAL') && adv.has('LESSER')) {
        const instant = (r: Row): number | undefined => instantMs(field.get(r)[0]);
        for (const raw of samples) {
            const literal = datetimeLiteral(raw);
            const gt = await fetchRows(t, spec, f('GREATER', literal), cap);
            const le = await fetchRows(t, spec, f('LESSER_OR_EQUAL', literal), cap);
            expectCountsAdd(here('GREATER/LESSER_OR_EQUAL', literal), [['GREATER', gt.total], ['LESSER_OR_EQUAL', le.total]], await notEmpty());
            if (gt.complete && le.complete) expectInstantOrder(here('GREATER vs LESSER_OR_EQUAL', literal), le.rows, gt.rows, instant);
            const ge = await listingTotal(t, spec, f('GREATER_OR_EQUAL', literal));
            const lt = await listingTotal(t, spec, f('LESSER', literal));
            expectCountsAdd(here('GREATER_OR_EQUAL/LESSER', literal), [['GREATER_OR_EQUAL', ge], ['LESSER', lt]], await notEmpty());
            log.step(`${field.id}: ${literal}: GREATER ${gt.total} + LESSER_OR_EQUAL ${le.total} = NOT_EMPTY ${await notEmpty()}; GREATER_OR_EQUAL ${ge} + LESSER ${lt}`);
        }
        if (adv.has('IN_PAST') && adv.has('IN_NEXT')) await runWindowOracles(t, spec, field, base, log, f, cap, instant);
    }

    // COLLECTION: the COUNT_* conditions count the values of the row (0 = none).
    if (adv.has('COUNT_EQUAL') && adv.has('COUNT_NOT_EQUAL') && adv.has('COUNT_GREATER_THAN') && adv.has('COUNT_LESS_THAN')) {
        const counts = [...new Set(sampleRows.map((r) => field.get(r).length))].sort((a, b) => a - b);
        for (const n of pickSpread(counts, 3)) {
            const eq = await check('COUNT_EQUAL', n);
            const ne = await check('COUNT_NOT_EQUAL', n);
            const gt = await check('COUNT_GREATER_THAN', n);
            const lt = await check('COUNT_LESS_THAN', n);
            expectCountsAdd(here('COUNT_EQUAL/COUNT_NOT_EQUAL', n), [['COUNT_EQUAL', eq.total], ['COUNT_NOT_EQUAL', ne.total]], base.total);
            expectCountsAdd(here('COUNT_GREATER_THAN/COUNT_EQUAL/COUNT_LESS_THAN', n), [['COUNT_GREATER_THAN', gt.total], ['COUNT_EQUAL', eq.total], ['COUNT_LESS_THAN', lt.total]], base.total);
            log.step(`${field.id}: COUNT ${n}: = ${eq.total}, != ${ne.total}, > ${gt.total}, < ${lt.total}`);
        }
    }
}

/** IN_PAST / IN_NEXT: nested windows are subsets of each other and every row lies in its window (server clock, ±120 s). */
async function runWindowOracles(t: Transport, spec: ListingSpec, field: FieldMap, base: Baseline, log: RunLog, f: (c: string, v?: unknown) => Filter[], cap: number, instant: (r: Row) => number | undefined): Promise<void> {
    const key = spec.rowKey;
    const windows: Array<['IN_PAST' | 'IN_NEXT', string, number]> = [['IN_PAST', 'P1D', DAY_MS], ['IN_PAST', 'P3650D', 3650 * DAY_MS], ['IN_NEXT', 'P1D', DAY_MS], ['IN_NEXT', 'P3650D', 3650 * DAY_MS]];
    const got = new Map<string, RowSet>();
    for (const [condition, duration, ms] of windows) {
        const probe = await listingPage(t, spec, { filters: f(condition, duration), size: 1 });
        const set = await fetchRows(t, spec, f(condition, duration), cap);
        const now = probe.serverNow ?? Date.now();
        if (condition === 'IN_PAST') expectInstantsWithin(`${field.id} IN_PAST ${duration}`, set.rows, instant, now - ms, now, SKEW_MS);
        else expectInstantsWithin(`${field.id} IN_NEXT ${duration}`, set.rows, instant, now, now + ms, SKEW_MS);
        got.set(`${condition} ${duration}`, set);
        if (set.total > base.total) throw new InvariantViolation(`${field.id} ${condition} ${duration}: ${set.total} rows, more than the ${base.total} of the listing`);
    }
    for (const condition of ['IN_PAST', 'IN_NEXT']) {
        const small = got.get(`${condition} P1D`)!;
        const large = got.get(`${condition} P3650D`)!;
        if (small.total > large.total) throw new InvariantViolation(`${field.id} ${condition}: P1D holds ${small.total} rows, P3650D only ${large.total}`);
        if (small.complete && large.complete) expectSubset(`${field.id} ${condition} P1D vs P3650D`, small.rows, large.rows, key);
    }
    log.step(`${field.id}: IN_PAST P1D ${got.get('IN_PAST P1D')!.total} <= P3650D ${got.get('IN_PAST P3650D')!.total}; IN_NEXT P1D ${got.get('IN_NEXT P1D')!.total} <= P3650D ${got.get('IN_NEXT P3650D')!.total}`);
}

/**
 * Count relations for a catalogue field WITHOUT a verified DTO mapping (attribute fields, fields a newer core adds):
 * |EMPTY| + |NOT_EMPTY| = total; for a list field with published values |EQUALS v| + |NOT_EQUALS v| = total; a boolean,
 * a number and a string get the matching complement / partition. `source` is the catalogue group of the field.
 */
export async function runGenericFieldOracles(t: Transport, spec: ListingSpec, source: string, live: CatalogueField, base: Baseline, log: RunLog): Promise<void> {
    const adv = new Set(live.conditions);
    const filter = (condition: string, value?: unknown): Filter[] => [{ fieldSource: source as Filter['fieldSource'], fieldIdentifier: live.fieldIdentifier, condition, ...(value === undefined ? {} : { value }) }];
    const id = `${source}:${live.fieldIdentifier}`;
    const total = (condition: string, value?: unknown) => listingTotal(t, spec, filter(condition, value));
    let nonEmpty: number | undefined;
    if (adv.has('EMPTY') && adv.has('NOT_EMPTY')) {
        const e = await total('EMPTY');
        nonEmpty = await total('NOT_EMPTY');
        expectCountsAdd(`${id}: EMPTY + NOT_EMPTY`, [['EMPTY', e], ['NOT_EMPTY', nonEmpty]], base.total);
        log.step(`${id}: EMPTY ${e} + NOT_EMPTY ${nonEmpty} = ${base.total}`);
    }
    const values = Array.isArray(live.value) ? (live.value as unknown[]).filter((v) => typeof v === 'string' || typeof v === 'number') : [];
    if (live.type === 'list' && adv.has('EQUALS') && adv.has('NOT_EQUALS') && values.length) {
        const v = values[0];
        expectCountsAdd(`${id}: EQUALS/NOT_EQUALS ${JSON.stringify(v)}`, [['EQUALS', await total('EQUALS', v)], ['NOT_EQUALS', await total('NOT_EQUALS', v)]], base.total);
        log.step(`${id}: EQUALS + NOT_EQUALS ${JSON.stringify(v)} = ${base.total}`);
    } else if (live.type === 'boolean' && adv.has('EQUALS') && adv.has('NOT_EQUALS')) {
        expectCountsAdd(`${id}: EQUALS/NOT_EQUALS true`, [['EQUALS', await total('EQUALS', true)], ['NOT_EQUALS', await total('NOT_EQUALS', true)]], base.total);
        log.step(`${id}: EQUALS true + NOT_EQUALS true = ${base.total}`);
    } else if (live.type === 'number' && adv.has('GREATER') && adv.has('LESSER_OR_EQUAL') && nonEmpty !== undefined) {
        expectCountsAdd(`${id}: GREATER/LESSER_OR_EQUAL 0`, [['GREATER', await total('GREATER', 0)], ['LESSER_OR_EQUAL', await total('LESSER_OR_EQUAL', 0)]], nonEmpty);
        log.step(`${id}: GREATER 0 + LESSER_OR_EQUAL 0 = NOT_EMPTY ${nonEmpty}`);
    } else if (live.type === 'string' && adv.has('CONTAINS') && adv.has('NOT_CONTAINS')) {
        expectCountsAdd(`${id}: CONTAINS/NOT_CONTAINS "e"`, [['CONTAINS', await total('CONTAINS', 'e')], ['NOT_CONTAINS', await total('NOT_CONTAINS', 'e')]], base.total);
        log.step(`${id}: CONTAINS "e" + NOT_CONTAINS "e" = ${base.total}`);
    }
}

// ====================================================================================================================
// 7. AND, paging
// ====================================================================================================================

export interface AndPair {
    a: Filter;
    b: Filter;
    describe: string;
}

/**
 * Up to `max` pairs of EQUALS filters over two different mapped fields, chosen so the intersection is non-empty and smaller than
 * both sides when the data allows it (a pair of filters that cannot narrow anything proves nothing).
 */
export function findAndPairs(fields: FieldMap[], rows: Row[], liveIds: ReadonlySet<string>, max = 2): AndPair[] {
    const candidates: Array<{ field: FieldMap; v: Scalar; set: Set<Row> }> = [];
    for (const field of fields.filter((x) => liveIds.has(x.id) && x.shape !== 'datetime')) {
        for (const v of sampleValues(rows, field, 3)) {
            const set = new Set(rows.filter((r) => satisfiesFilter(field.get(r), 'EQUALS', v)));
            if (set.size > 0 && set.size < rows.length) candidates.push({ field, v, set });
        }
    }
    const out: Array<{ pair: AndPair; score: number }> = [];
    for (let i = 0; i < candidates.length; i++) {
        for (let j = i + 1; j < candidates.length; j++) {
            const x = candidates[i];
            const y = candidates[j];
            if (x.field.id === y.field.id) continue;
            const both = [...x.set].filter((r) => y.set.has(r)).length;
            const narrows = both > 0 && both < Math.min(x.set.size, y.set.size);
            out.push({
                pair: { a: prop(x.field.id, 'EQUALS', x.v), b: prop(y.field.id, 'EQUALS', y.v), describe: `${x.field.id} = ${JSON.stringify(x.v)} AND ${y.field.id} = ${JSON.stringify(y.v)}` },
                score: (narrows ? 2 : both > 0 ? 1 : 0) * 1000 + Math.min(x.set.size, y.set.size),
            });
        }
    }
    return out.sort((p, q) => q.score - p.score).slice(0, max).map((o) => o.pair);
}

/** A AND B = A ∩ B, B AND A = A AND B, both subsets of each side (invariants.expectAndNarrows plus the exact intersection). */
export async function runAndOracle(t: Transport, spec: ListingSpec, pair: AndPair, log: RunLog): Promise<void> {
    const cap = spec.maxWalkRows;
    const key = spec.rowKey;
    const a = await fetchRows(t, spec, [pair.a], cap);
    const b = await fetchRows(t, spec, [pair.b], cap);
    const ab = await fetchRows(t, spec, [pair.a, pair.b], cap);
    const ba = await fetchRows(t, spec, [pair.b, pair.a], cap);
    if (ab.total > Math.min(a.total, b.total)) throw new InvariantViolation(`${pair.describe}: A and B returns ${ab.total} rows, more than min(|A| ${a.total}, |B| ${b.total})`);
    if (ab.total !== ba.total) throw new InvariantViolation(`${pair.describe}: the filter order changes the total (${ab.total} vs ${ba.total})`);
    if (a.complete && b.complete && ab.complete && ba.complete) {
        expectAndNarrows(a.rows, b.rows, ab.rows, ba.rows, { key });
        expectIntersection(`${pair.describe}: A and B is not the intersection of A and B`, a.rows, b.rows, ab.rows, key);
    }
    log.step(`${pair.describe}: |A| ${a.total}, |B| ${b.total}, |A and B| ${ab.total}`);
}

// ====================================================================================================================
// 8. Sorting (API-GEN-11)
// ====================================================================================================================

export interface SortTarget {
    id: string;
    source?: 'property' | 'meta' | 'custom' | 'data';
    /** The DTO values (property fields with a verified mapping); undefined: emptiness comes from the EMPTY filter. */
    get?: (row: Row) => Values;
    sort: FieldMap['sort'];
    /** The catalogue's EMPTY / NOT_EMPTY, for the filter-defined emptiness of a field without a mapping. */
    emptyFilter?: Filter;
}

export const targetOf = (field: FieldMap): SortTarget => ({ id: field.id, source: 'property', get: field.get, sort: field.sort });

const HEAD_MAX = 200;
const HEAD_PAGE = 50;

/** The value a sort puts a row at: the first value; the smallest (asc) / largest (desc) text of a multi-valued field. */
function sortText(target: SortTarget, row: Row, dir: 'asc' | 'desc'): string | undefined {
    const values = target.get?.(row).map(String) ?? [];
    if (!values.length) return undefined;
    if (target.sort === 'minMaxText') return [...values].sort(codeUnit)[dir === 'asc' ? 0 : values.length - 1];
    return values[0];
}

/**
 * Both directions of one sortable field over the listing (rules §2.2 r21-r23; core#2031, #2394): in each direction the pages
 * of 50 concatenated equal one request of up to 200 rows, a second read answers the same order, the values are ordered (where
 * decidable), rows without a value come last (head window and, past 200 rows, the last page), and ascending and descending list
 * the same values in opposite order. Reads <= ~20 requests per field.
 */
export async function runSortField(t: Transport, spec: ListingSpec, target: SortTarget, base: Baseline, log: RunLog): Promise<void> {
    const total = base.total;
    if (total === 0) return;
    const key = spec.rowKey;
    const head = Math.min(total, HEAD_MAX);
    const source = target.source ?? 'property';
    const emptyKeys = target.get || !target.emptyFilter
        ? undefined
        : new Set((await fetchRows(t, spec, [target.emptyFilter], spec.maxWalkRows)).rows.map(key));
    const isNull = (r: Row): boolean => (target.get ? target.get(r).length === 0 : (emptyKeys?.has(key(r)) ?? false));
    const emptyCount = target.get
        ? (base.complete ? base.rows.filter(isNull).length : undefined)
        : (target.emptyFilter ? await listingTotal(t, spec, [target.emptyFilter]) : undefined);
    const walks: Record<'asc' | 'desc', Row[]> = { asc: [], desc: [] };

    for (const dir of ['asc', 'desc'] as const) {
        const sort: Sort = { fieldSource: source, fieldIdentifier: target.id, direction: dir };
        const label = `${target.id} ${dir}`;
        const pages: Row[][] = [];
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
export async function runSortComposition(t: Transport, spec: ListingSpec, target: SortTarget, base: Baseline, log: RunLog): Promise<void> {
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
 * The uuid tie-break (open question Q-G): equal sort values are ordered by ascending key in both directions
 * (SortOrderBuilder.java:253-259). Returns the number of equal-value runs seen (0: no ties in the head window, nothing proven).
 */
export async function runTieBreak(t: Transport, spec: ListingSpec, target: SortTarget, base: Baseline, log: RunLog): Promise<number> {
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
export async function probeSort(t: Transport, url: string, sort: unknown, extra: Record<string, unknown> = {}): Promise<Probe> {
    return t.postRead(url, { filters: [], itemsPerPage: 1, pageNumber: 1, sort, ...extra });
}

/** The refusal text of a listing outside the configurable-column pipeline (RequestValidatorHelper.java:24-30). */
export const unsupportedSortText = (label: string): string => `Sorting is not supported for the ${label} listing.`;

// ====================================================================================================================
// 10. Audit log: logging gate, closed window, own activity
// ====================================================================================================================

export interface AuditGate {
    enabled: boolean;
    why?: string;
}

/**
 * Is a record of (module, resource) written to the DATABASE under these `GET /v1/settings/logging` settings? The gate
 * mirrors AuditLogAspect.java:100-125 (output NONE writes nothing), LoggingHelper.isLogFilteredBasedOnModuleAndResource
 * :265-273 and AuditLogServiceImpl.handleAuditLogging (database / all only). Unknown settings (undefined): not decidable, enabled.
 */
export function auditGate(settings: unknown, module: string, resource: string): AuditGate {
    const a = (settings as { auditLogs?: Record<string, unknown> } | undefined)?.auditLogs;
    if (!a) return { enabled: true, why: 'logging settings not readable: not decidable' };
    const output = String(a.output ?? '').toUpperCase();
    if (output !== 'ALL' && output !== 'DATABASE') return { enabled: false, why: `audit log output is ${output || 'unset'}: nothing is written to the database` };
    const list = (v: unknown): string[] => (Array.isArray(v) ? v.map(String) : []);
    if (list(a.ignoredModules).includes(module) || (!a.logAllModules && !list(a.loggedModules).includes(module))) return { enabled: false, why: `module ${module} is not logged (settings)` };
    if (list(a.ignoredResources).includes(resource) || (!a.logAllResources && !list(a.loggedResources).includes(resource))) return { enabled: false, why: `resource ${resource} is not logged (settings)` };
    return { enabled: true };
}

export async function readLoggingSettings(t: Transport): Promise<unknown | undefined> {
    const p = await t.get('/api/v1/settings/logging');
    return p.status === 200 ? p.json : undefined;
}

/** The names of the custom attributes the platform lists as disabled (core#2507: their filters answer inconsistently). */
export async function disabledCustomAttributeNames(t: Transport): Promise<Set<string>> {
    const p = await t.get('/api/v1/attributes/custom');
    const rows = Array.isArray(p.json) ? (p.json as Array<Record<string, unknown>>) : [];
    return new Set(rows.filter((r) => r.enabled === false).map((r) => String(r.name)));
}

const AUDIT_TIMESTAMP = 'AUDIT_LOG_TIMESTAMP';

export interface AuditWindow {
    filters: Filter[];
    lower: string;
    upper: string;
    /** Rows in the window (a fixed set once both bounds are in the past). */
    total: number;
}

/**
 * A CLOSED window of the audit log that no new entry can enter: bounded below by the timestamp of the oldest of up to 300
 * entries older than two minutes and above by the newest of them, both literals copied from the DTO text. Returns the reason
 * instead when the log is too small or too busy to hold one. The audit log is append-only and every request of the suite
 * (this one included) is itself logged, so an unbounded relation on it would chase its own tail.
 */
export async function closedAuditWindow(t: Transport, spec: ListingSpec, wanted = 300): Promise<AuditWindow | { skip: string }> {
    const first = await listingPage(t, spec, { size: 100 });
    const now = first.serverNow ?? Date.now();
    const old: Row[] = [];
    let page = first;
    for (let n = 1; n <= 5; n++) {
        for (const r of page.rows) if ((instantMs(r.timestamp) ?? Infinity) <= now - 120_000) old.push(r);
        if (old.length >= wanted || n >= page.totalPages) break;
        page = await listingPage(t, spec, { size: 100, page: n + 1 });
    }
    if (old.length < 20) return { skip: `the audit log holds ${old.length} entr${old.length === 1 ? 'y' : 'ies'} older than two minutes within the newest 500 (a closed window needs 20)` };
    const slice = old.slice(0, wanted);
    const times = slice.map((r) => instantMs(r.timestamp)!);
    const upperRow = slice[times.indexOf(Math.max(...times))];
    const lowerRow = slice[times.indexOf(Math.min(...times))];
    const lower = datetimeLiteral(lowerRow.timestamp);
    const upper = datetimeLiteral(upperRow.timestamp);
    const filters = [prop(AUDIT_TIMESTAMP, 'GREATER_OR_EQUAL', lower), prop(AUDIT_TIMESTAMP, 'LESSER_OR_EQUAL', upper)];
    const windowed = { ...spec, baseFilters: filters };
    const rows = await fetchRows(t, windowed, [], spec.maxWalkRows);
    if (rows.total === 0) return { skip: 'the closed audit window answered no entry (the platform reads filter timestamps in another zone than it serves them)' };
    const outside = rows.rows.filter((r) => {
        const ms = instantMs(r.timestamp);
        return ms === undefined || ms < Math.min(...times) - 1000 || ms > Math.max(...times) + 1000;
    });
    if (outside.length) return { skip: `the closed audit window returned ${outside.length} entr${outside.length === 1 ? 'y' : 'ies'} outside its bounds (the platform reads filter timestamps in another zone than it serves them; inventory-api §2.2 r17, Q4)` };
    return { filters, lower, upper, total: rows.total };
}

export interface ActivityQuery {
    /** Resource code (`dashboard`, `groups`, `certificates`). */
    resource: string;
    /** Operation code (`statistics`, `create`, `inspect`). */
    operation: string;
    module?: string;
    /** The own object the entry names (AUDIT_LOG_RESOURCE_UUID). */
    objectUuid?: string;
}

/** The filters that locate an activity in the audit log: resource, operation, module, object, and the last 15 minutes. */
export function activityFilters(q: ActivityQuery): Filter[] {
    return [
        prop('AUDIT_LOG_RESOURCE', 'EQUALS', q.resource),
        prop('AUDIT_LOG_OPERATION', 'EQUALS', q.operation),
        ...(q.module ? [prop('AUDIT_LOG_MODULE', 'EQUALS', q.module)] : []),
        ...(q.objectUuid ? [prop('AUDIT_LOG_RESOURCE_UUID', 'EQUALS', q.objectUuid)] : []),
        prop(AUDIT_TIMESTAMP, 'IN_PAST', 'PT15M'),
    ];
}

/** The entries of `rows` that are this activity and are not older than `t0` (a server-clock instant): resource, operation, module, object. */
export function activityMatches(rows: Row[], q: ActivityQuery, t0: Date): Row[] {
    return rows.filter((r) => {
        const at = instantMs(r.timestamp);
        if (at === undefined || at < t0.getTime()) return false;
        if (nested('resource', 'type')(r)[0] !== q.resource || String(r.operation) !== q.operation) return false;
        if (q.module && String(r.module) !== q.module) return false;
        if (q.objectUuid && !elementsOf(['resource', 'objects'], 'uuid')(r).includes(q.objectUuid)) return false;
        return true;
    });
}

/** Polls (<= timeoutMs, default 10 s) until the activity is in the audit log; the entries are published asynchronously (AuditLogAspect.java:181-194). */
export async function waitForActivity(t: Transport, spec: ListingSpec, q: ActivityQuery, t0: Date, timeoutMs = 10_000): Promise<Row[]> {
    let found: Row[] = [];
    await expect
        .poll(
            async () => {
                const page = await listingPage(t, spec, { filters: activityFilters(q), size: 100 });
                found = activityMatches(page.rows, q, t0);
                return found.length;
            },
            { timeout: timeoutMs, intervals: [250, 500, 1000], message: `audit log: no ${q.resource} / ${q.operation} entry at or after ${t0.toISOString()} within ${timeoutMs} ms` },
        )
        .toBeGreaterThan(0);
    return found;
}

// ====================================================================================================================
// 11. The listings: field tables (each DTO mapping read in core / interfaces; file:line in `evidence`)
// ====================================================================================================================

const KEY_ITEM = 'core CryptographicKeyItem.mapToSummaryDto (dao/entity/CryptographicKeyItem.java:211-245) → interfaces KeyItemDto';
const DISCOVERY_ROW = 'core DiscoveryDtoMapper.toListDto (:91-104) → interfaces DiscoveryListDto';
const AUDIT_ROW = 'core AuditLog.mapToDto (dao/entity/AuditLog.java:102-119) → interfaces AuditLogDto, LogRecord records';

/** `POST /api/v1/keys`: the rows are KEY ITEMS (`cryptographicKeys[]`, CryptographicKeyServiceImpl.java:304-335). */
export const KEYS: ListingSpec = {
    name: 'keys',
    searchUrl: '/api/v1/keys',
    catalogueUrl: '/api/v1/keys/search',
    rowsMember: 'cryptographicKeys',
    rowKey: (r) => String(r.uuid),
    configurable: true,
    refusalLabel: 'Key',
    maxWalkRows: 1000,
    fields: [
        { id: 'CKI_NAME', type: 'string', kind: 'string', shape: 'text', get: member('name'), sortable: true, sort: 'text', evidence: `${KEY_ITEM}: name; FilterField.java:205` },
        { id: 'CKI_TYPE', type: 'list', kind: 'list', shape: 'code', get: member('type'), sortable: true, sort: 'structure', evidence: `${KEY_ITEM}: type (code); FilterField.java:206` },
        { id: 'CKI_FORMAT', type: 'list', kind: 'list', shape: 'code', get: member('format'), sortable: true, sort: 'structure', evidence: `${KEY_ITEM}: format; FilterField.java:208` },
        { id: 'CKI_STATE', type: 'list', kind: 'list', shape: 'code', get: member('state'), sortable: true, sort: 'structure', evidence: `${KEY_ITEM}: state; FilterField.java:210` },
        { id: 'CKI_CRYPTOGRAPHIC_ALGORITHM', type: 'list', kind: 'list', shape: 'code', get: member('keyAlgorithm'), sortable: true, sort: 'structure', evidence: `${KEY_ITEM}: keyAlgorithm; FilterField.java:212` },
        // KeyUsage is a BitMaskEnum: EMPTY = bit mask 0 (FilterPredicatesBuilder.java:1147-1149), EQUALS = the bit is set (:556-560); not sortable (SearchHelper.isBitMaskField :336-340, rules §2.2 r24).
        { id: 'CKI_USAGE', type: 'list', kind: 'list', shape: 'code', get: member('usage'), sortable: false, sort: 'none', evidence: `${KEY_ITEM}: usage (KeyUsage codes of the bit mask); FilterField.java:214` },
        { id: 'CKI_LENGTH', type: 'number', kind: 'number', shape: 'number', get: member('length'), sortable: true, sort: 'number', evidence: `${KEY_ITEM}: length (nullable Integer); FilterField.java:216` },
        { id: 'CKI_ENABLED', type: 'boolean', kind: 'boolean', shape: 'boolean', get: member('enabled'), sortable: true, sort: 'boolean', evidence: `${KEY_ITEM}: enabled (primitive; the column is primitive too, CryptographicKeyItem.java:121-122); FilterField.java:218` },
        { id: 'CKI_CREATED', type: 'datetime', kind: 'date', shape: 'datetime', get: member('creationTime'), sortable: true, sort: 'datetime', evidence: `${KEY_ITEM}: creationTime = the key's created (:235); FilterField.java:221 "the key's created, not the item's"` },
        { id: 'CK_TOKEN_PROFILE', type: 'list', kind: 'list', shape: 'code', get: member('tokenProfileName'), sortable: true, sort: 'text', evidence: `${KEY_ITEM}: tokenProfileName (:240-243); FilterField.java:223` },
        { id: 'CK_TOKEN_INSTANCE', type: 'list', kind: 'list', shape: 'code', get: member('tokenInstanceName'), sortable: true, sort: 'text', evidence: `${KEY_ITEM}: tokenInstanceName (:236-239); FilterField.java:226` },
        { id: 'CK_GROUP', type: 'list', kind: 'collection', shape: 'code', get: elementsOf(['groups'], 'name'), sortable: true, sort: 'minMaxText', evidence: `${KEY_ITEM}: groups[].name (:228-230); FilterField.java:229 (a collection join: COUNT_*)` },
        { id: 'CK_OWNER', type: 'list', kind: 'list', shape: 'code', get: member('owner'), sortable: true, sort: 'text', evidence: `${KEY_ITEM}: owner = ownerUsername (:231-234); FilterField.java:231` },
    ],
};

/** `POST /api/v1/discoveries/list` (DiscoveryServiceImpl.java:274-299). */
export const DISCOVERIES: ListingSpec = {
    name: 'discoveries',
    searchUrl: '/api/v1/discoveries/list',
    catalogueUrl: '/api/v1/discoveries/search',
    rowsMember: 'discoveries',
    rowKey: (r) => String(r.uuid),
    configurable: true,
    refusalLabel: 'Discovery',
    maxWalkRows: 1000,
    fields: [
        { id: 'DISCOVERY_NAME', type: 'string', kind: 'string', shape: 'text', get: member('name'), sortable: true, sort: 'text', evidence: `${DISCOVERY_ROW}: name; FilterField.java:235` },
        { id: 'DISCOVERY_START_TIME', type: 'datetime', kind: 'date', shape: 'datetime', get: member('startTime'), sortable: true, sort: 'datetime', evidence: `${DISCOVERY_ROW}: startTime (nullable); FilterField.java:236` },
        { id: 'DISCOVERY_END_TIME', type: 'datetime', kind: 'date', shape: 'datetime', get: member('endTime'), sortable: true, sort: 'datetime', evidence: `${DISCOVERY_ROW}: endTime (nullable); FilterField.java:238` },
        { id: 'DISCOVERY_STATUS', type: 'list', kind: 'list', shape: 'code', get: member('status'), sortable: true, sort: 'structure', evidence: `${DISCOVERY_ROW}: status (code); FilterField.java:239` },
        { id: 'DISCOVERY_TOTAL_CERT_DISCOVERED', type: 'number', kind: 'number', shape: 'number', get: member('totalCertificatesDiscovered'), sortable: true, sort: 'number', evidence: `${DISCOVERY_ROW}: totalCertificatesDiscovered (nullable Integer); FilterField.java:241` },
        { id: 'DISCOVERY_CONNECTOR_NAME', type: 'list', kind: 'list', shape: 'code', get: member('connectorName'), sortable: true, sort: 'text', evidence: `${DISCOVERY_ROW}: connectorName; FilterField.java:243` },
        { id: 'DISCOVERY_KIND', type: 'string', kind: 'string', shape: 'text', get: member('kind'), sortable: true, sort: 'text', evidence: `${DISCOVERY_ROW}: kind (absent for a v2 run: JsonInclude NON_NULL); FilterField.java:245` },
    ],
};

/**
 * `POST /api/v1/auditLogs` (AuditLogServiceImpl.java:96-125): rows `items[]`, newest first (id desc), NO sort (any sort is refused).
 * The enum columns are stored by name and filtered by CODE (FilterPredicatesBuilder.findEnumByCustomValue :1167-1173).
 */
export const AUDIT_LOGS: ListingSpec = {
    name: 'auditLogs',
    searchUrl: '/api/v1/auditLogs',
    catalogueUrl: '/api/v1/auditLogs/search',
    rowsMember: 'items',
    rowKey: (r) => String(r.id),
    configurable: false,
    refusalLabel: 'Audit logs',
    maxWalkRows: 1000,
    fields: [
        { id: 'AUDIT_LOG_TIMESTAMP', type: 'datetime', kind: 'date', shape: 'datetime', get: member('timestamp'), sortable: false, sort: 'none', evidence: `${AUDIT_ROW}: timestamp; FilterField.java:281` },
        { id: 'AUDIT_LOG_MODULE', type: 'list', kind: 'list', shape: 'code', get: member('module'), sortable: false, sort: 'none', evidence: `${AUDIT_ROW}: module; FilterField.java:282` },
        { id: 'AUDIT_LOG_ACTOR_TYPE', type: 'list', kind: 'list', shape: 'code', get: nested('actor', 'type'), sortable: false, sort: 'none', evidence: `${AUDIT_ROW}: actor.type (AuditLog.fromLogRecord :155); FilterField.java:284` },
        { id: 'AUDIT_LOG_ACTOR_NAME', type: 'string', kind: 'string', shape: 'text', get: nested('actor', 'name'), sortable: false, sort: 'none', evidence: `${AUDIT_ROW}: actor.name (:158); FilterField.java:286` },
        { id: 'AUDIT_LOG_ACTOR_AUTH_METHOD', type: 'list', kind: 'list', shape: 'code', get: nested('actor', 'authMethod'), sortable: false, sort: 'none', evidence: `${AUDIT_ROW}: actor.authMethod (:156); FilterField.java:287` },
        { id: 'AUDIT_LOG_RESOURCE', type: 'list', kind: 'list', shape: 'code', get: nested('resource', 'type'), sortable: false, sort: 'none', evidence: `${AUDIT_ROW}: resource.type (:159); FilterField.java:291` },
        { id: 'AUDIT_LOG_AFFILIATED_RESOURCE', type: 'list', kind: 'list', shape: 'code', get: nested('affiliatedResource', 'type'), sortable: false, sort: 'none', evidence: `${AUDIT_ROW}: affiliatedResource.type (:160-162); FilterField.java:293` },
        { id: 'AUDIT_LOG_OPERATION', type: 'list', kind: 'list', shape: 'code', get: member('operation'), sortable: false, sort: 'none', evidence: `${AUDIT_ROW}: operation; FilterField.java:295` },
        { id: 'AUDIT_LOG_OPERATION_RESULT', type: 'list', kind: 'list', shape: 'code', get: member('operationResult'), sortable: false, sort: 'none', evidence: `${AUDIT_ROW}: operationResult; FilterField.java:297` },
        { id: 'AUDIT_LOG_SOURCE_IP_ADDRESS', type: 'string', kind: 'string', shape: 'text', get: nested('source', 'ipAddress'), sortable: false, sort: 'none', evidence: `${AUDIT_ROW}: source.ipAddress (JSON path logRecord.source.ipAddress); FilterField.java:299` },
        { id: 'AUDIT_LOG_SOURCE_PATH', type: 'string', kind: 'string', shape: 'text', get: nested('source', 'path'), sortable: false, sort: 'none', evidence: `${AUDIT_ROW}: source.path (JSON path); FilterField.java:301` },
        { id: 'AUDIT_LOG_MESSAGE', type: 'string', kind: 'string', shape: 'text', get: member('message'), sortable: false, sort: 'none', evidence: `${AUDIT_ROW}: message; FilterField.java:303` },
        { id: 'AUDIT_LOG_RESOURCE_UUID', type: 'string', kind: 'jsonArray', shape: 'code', get: elementsOf(['resource', 'objects'], 'uuid'), sortable: false, sort: 'none', evidence: `${AUDIT_ROW}: resource.objects[].uuid (JSON array path; EQUALS = array contains, EMPTY = [] / [null] / null, FilterPredicatesBuilder.java:864-869, :1151-1156); FilterField.java:304` },
        { id: 'AUDIT_LOG_RESOURCE_NAME', type: 'string', kind: 'jsonArray', shape: 'code', get: elementsOf(['resource', 'objects'], 'name'), sortable: false, sort: 'none', evidence: `${AUDIT_ROW}: resource.objects[].name; FilterField.java:306` },
        { id: 'AUDIT_LOG_AFFILIATED_RESOURCE_UUID', type: 'string', kind: 'jsonArray', shape: 'code', get: elementsOf(['affiliatedResource', 'objects'], 'uuid'), sortable: false, sort: 'none', evidence: `${AUDIT_ROW}: affiliatedResource.objects[].uuid; FilterField.java:308` },
        { id: 'AUDIT_LOG_AFFILIATED_RESOURCE_NAME', type: 'string', kind: 'jsonArray', shape: 'code', get: elementsOf(['affiliatedResource', 'objects'], 'name'), sortable: false, sort: 'none', evidence: `${AUDIT_ROW}: affiliatedResource.objects[].name; FilterField.java:310` },
    ],
};

/** The catalogue expectations of a listing derived from its field table (the known fields must be published exactly so). */
export function expectationsOf(spec: ListingSpec, onlyProperty = false): CatalogueExpectations {
    return {
        configurable: spec.configurable,
        onlyProperty,
        known: Object.fromEntries(spec.fields.map((x) => [x.id, { type: x.type, kind: x.kind, sortable: x.sortable }])),
    };
}

/** The searchable-fields catalogues of every resource with one (`GET <listing>/search`; interfaces core/web/*Controller.java). */
export interface CatalogueRow {
    name: string;
    url: string;
    /** SearchHelper.CONFIGURABLE_COLUMN_RESOURCES (:248-250). */
    configurable: boolean;
    /** The listing table, when the area owns its oracles (keys, discoveries, audit logs). */
    listing?: ListingSpec;
    onlyProperty?: boolean;
    /** Not named in the ledger row of API-GEN-12 (an extra resource with a catalogue). */
    extra?: boolean;
}

export const CATALOGUES: readonly CatalogueRow[] = [
    { name: 'keys', url: KEYS.catalogueUrl, configurable: true, listing: KEYS },
    { name: 'discoveries', url: DISCOVERIES.catalogueUrl, configurable: true, listing: DISCOVERIES },
    { name: 'auditLogs', url: AUDIT_LOGS.catalogueUrl, configurable: false, listing: AUDIT_LOGS, onlyProperty: true },
    { name: 'oids', url: '/api/v1/oids/search', configurable: false },
    { name: 'locations', url: '/api/v1/locations/search', configurable: false },
    { name: 'secrets', url: '/api/v1/secrets/search', configurable: true },
    { name: 'connectorsV2', url: '/api/v2/connectors/search', configurable: true },
    { name: 'signingRecords', url: '/api/v1/signingRecords/search', configurable: true },
    { name: 'vaults', url: '/api/v1/vaults/search', configurable: false },
    { name: 'vaultProfiles', url: '/api/v1/vaultProfiles/search', configurable: false },
    { name: 'signingProfiles', url: '/api/v1/signingProfiles/search', configurable: false },
    { name: 'tspProfiles', url: '/api/v1/tspProfiles/search', configurable: false },
    { name: 'cryptoAssets', url: '/api/v1/cryptoAssets/search', configurable: true },
    { name: 'entities', url: '/api/v1/entities/search', configurable: false },
    { name: 'certificates', url: '/api/v1/certificates/search', configurable: true },
    { name: 'cboms', url: '/api/v1/cboms/search', configurable: true, extra: true },
    { name: 'timeQualityConfigurations', url: '/api/v1/timeQualityConfigurations/search', configurable: false, extra: true },
];

/** The listings that refuse ANY sort (Resource not in CONFIGURABLE_COLUMN_RESOURCES): `POST <url>` and the label of the refusal text. */
export const SORT_REFUSING_LISTINGS: ReadonlyArray<{ name: string; url: string; label: string; evidence: string }> = [
    { name: 'auditLogs', url: AUDIT_LOGS.searchUrl, label: 'Audit logs', evidence: 'AuditLogServiceImpl.java:99; Resource.AUDIT_LOG "Audit logs" (Resource.java:23)' },
    { name: 'oids', url: '/api/v1/oids/list', label: 'OID', evidence: 'CustomOidEntryServiceImpl.java:415; Resource.OID "OID" (Resource.java:57); OID is not in SearchHelper.CONFIGURABLE_COLUMN_RESOURCES' },
    { name: 'locations', url: '/api/v1/locations', label: 'Location', evidence: 'LocationServiceImpl.java:223; Resource.LOCATION "Location" (Resource.java:61)' },
    { name: 'entities', url: '/api/v1/entities/list', label: 'Entity', evidence: 'EntityInstanceServiceImpl.java:131; Resource.ENTITY "Entity" (Resource.java:60)' },
    { name: 'vaults', url: '/api/v1/vaults/list', label: 'Vault', evidence: 'VaultInstanceServiceImpl.java:197; Resource.VAULT "Vault" (Resource.java:109)' },
    { name: 'vaultProfiles', url: '/api/v1/vaultProfiles/list', label: 'Vault Profile', evidence: 'VaultProfileServiceImpl.java:126; Resource.VAULT_PROFILE "Vault Profile" (Resource.java:110)' },
];
