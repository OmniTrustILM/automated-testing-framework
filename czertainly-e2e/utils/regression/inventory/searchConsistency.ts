/**
 * Relations between certificate searches that hold over whatever data a tier holds (no exact counts): empty plus not
 * empty is the total, equals plus not equals is the total, a second AND filter never widens, contradicting filters give 0.
 * Pure logic over a `count(filters)` callback; one re-read absorbs a concurrent change, a second mismatch fails.
 */
import type { CatalogueField, CatalogueGroup, Filter } from './searchApi';

/** Count of the certificates matching the filters (any source), `includeArchived` is the callback's business. */
export type CountFn = (filters: Filter[]) => Promise<number>;

/** Fields whose filters answer 500 today (core#2503): excluded from every relation. */
export const FIELDS_ANSWERING_500: readonly string[] = ['CRL_VALIDATION', 'OCSP_VALIDATION', 'SIGNATURE_VALIDATION'];

/** Property LIST fields whose value is ONE thing at a time (a certificate has one state, one key size, …): contradiction rows (e). */
export const SINGLE_VALUED_FIELDS: readonly string[] = [
    'CERTIFICATE_STATE', 'CERTIFICATE_VALIDATION_STATUS', 'COMPLIANCE_STATUS', 'SUBJECT_TYPE', 'KEY_SIZE', 'SIGNATURE_ALGORITHM', 'PUBLIC_KEY_ALGORITHM',
];

export interface FieldRef {
    source: CatalogueGroup['filterFieldSource'];
    field: CatalogueField;
}

/** Every field of a catalogue with its source, minus the known-500 ones. */
export function catalogueFields(catalogue: CatalogueGroup[]): FieldRef[] {
    return catalogue.flatMap((g) => (g.searchFieldData ?? []).map((field) => ({ source: g.filterFieldSource, field })))
        .filter((r) => !FIELDS_ANSWERING_500.includes(r.field.fieldIdentifier));
}

export const filterOf = (r: FieldRef, condition: string, value?: unknown): Filter =>
    value === undefined ? { fieldSource: r.source, fieldIdentifier: r.field.fieldIdentifier, condition } : { fieldSource: r.source, fieldIdentifier: r.field.fieldIdentifier, condition, value };

const advertises = (r: FieldRef, ...conditions: string[]): boolean => conditions.every((c) => r.field.conditions?.includes(c));

/** The scalar values of a property LIST field's catalogue `value` (non-null strings / numbers), sorted and de-duplicated. */
export function listValues(r: FieldRef): Array<string | number> {
    if (r.source !== 'property' || r.field.type !== 'list' || !Array.isArray(r.field.value)) return [];
    const scalars = (r.field.value as unknown[]).filter((v): v is string | number => typeof v === 'string' || typeof v === 'number');
    return [...new Set(scalars)].sort((a, b) => String(a).localeCompare(String(b), 'en'));
}

/** At most `max` values spread evenly over the sorted list (deterministic; first and last always included). */
export function pickSample<T>(values: readonly T[], max: number): T[] {
    if (values.length <= max) return [...values];
    const out: T[] = [];
    for (let i = 0; i < max; i++) out.push(values[Math.round((i * (values.length - 1)) / (max - 1))]);
    return [...new Set(out)];
}

export interface Violation {
    relation: 'a' | 'b' | 'c' | 'd' | 'e';
    field: string;
    detail: string;
}

type Check = () => Promise<Violation | undefined>;

/** Runs a check; on a violation re-reads ONCE (a concurrent upload may have moved a total between the two reads). */
async function settled(check: Check): Promise<Violation | undefined> {
    const first = await check();
    if (!first) return undefined;
    return check();
}

/** (a) EMPTY + NOT_EMPTY = total, per field that advertises both. */
export async function emptyPartition(fields: FieldRef[], count: CountFn, total: () => Promise<number>): Promise<Violation[]> {
    const out: Violation[] = [];
    for (const r of fields.filter((x) => advertises(x, 'EMPTY', 'NOT_EMPTY'))) {
        const v = await settled(async () => {
            const [t, e, n] = [await total(), await count([filterOf(r, 'EMPTY')]), await count([filterOf(r, 'NOT_EMPTY')])];
            return e + n === t ? undefined : { relation: 'a' as const, field: r.field.fieldIdentifier, detail: `EMPTY ${e} + NOT_EMPTY ${n} = ${e + n}, total ${t}` };
        });
        if (v) out.push(v);
    }
    return out;
}

/** (b) EQUALS v + NOT_EQUALS v = total for sampled values of every property LIST field. */
export async function equalsPartition(fields: FieldRef[], count: CountFn, total: () => Promise<number>, maxValues = 6): Promise<Violation[]> {
    const out: Violation[] = [];
    for (const r of fields.filter((x) => advertises(x, 'EQUALS', 'NOT_EQUALS'))) {
        for (const value of pickSample(listValues(r), maxValues)) {
            const v = await settled(async () => {
                const [t, e, n] = [await total(), await count([filterOf(r, 'EQUALS', [value])]), await count([filterOf(r, 'NOT_EQUALS', [value])])];
                return e + n === t ? undefined : { relation: 'b' as const, field: r.field.fieldIdentifier, detail: `value ${JSON.stringify(value)}: EQUALS ${e} + NOT_EQUALS ${n} = ${e + n}, total ${t}` };
            });
            if (v) out.push(v);
        }
    }
    return out;
}

/** (c) any-of is at most the sum of the singles, for fields with at least two sampled values. */
export async function anyOfBound(fields: FieldRef[], count: CountFn, maxValues = 4): Promise<Violation[]> {
    const out: Violation[] = [];
    for (const r of fields.filter((x) => advertises(x, 'EQUALS'))) {
        const values = pickSample(listValues(r), maxValues);
        if (values.length < 2) continue;
        const [v1, v2] = [values[0], values[values.length - 1]];
        const v = await settled(async () => {
            const [any, a, b] = [await count([filterOf(r, 'EQUALS', [v1, v2])]), await count([filterOf(r, 'EQUALS', [v1])]), await count([filterOf(r, 'EQUALS', [v2])])];
            return any <= a + b ? undefined : { relation: 'c' as const, field: r.field.fieldIdentifier, detail: `EQUALS [${v1}, ${v2}] = ${any} > ${a} + ${b}` };
        });
        if (v) out.push(v);
    }
    return out;
}

/** (d) a second AND filter never increases the total: |A and B| <= min(|A|, |B|) over pairs of single filters. */
export async function andNarrows(pairs: Array<[Filter, Filter]>, count: CountFn): Promise<Violation[]> {
    const out: Violation[] = [];
    for (const [a, b] of pairs) {
        const v = await settled(async () => {
            const [ca, cb, cab] = [await count([a]), await count([b]), await count([a, b])];
            return cab <= Math.min(ca, cb) ? undefined : { relation: 'd' as const, field: `${a.fieldIdentifier} and ${b.fieldIdentifier}`, detail: `|A and B| ${cab} > min(|A| ${ca}, |B| ${cb})` };
        });
        if (v) out.push(v);
    }
    return out;
}

/** (e) contradicting filters on a single-valued field: EQUALS [v1] and EQUALS [v2] (v1 != v2) = 0. */
export async function contradictions(fields: FieldRef[], count: CountFn): Promise<Violation[]> {
    const out: Violation[] = [];
    for (const r of fields.filter((x) => SINGLE_VALUED_FIELDS.includes(x.field.fieldIdentifier) && advertises(x, 'EQUALS'))) {
        const values = listValues(r);
        if (values.length < 2) continue;
        const [v1, v2] = [values[0], values[values.length - 1]];
        const v = await settled(async () => {
            const n = await count([filterOf(r, 'EQUALS', [v1]), filterOf(r, 'EQUALS', [v2])]);
            return n === 0 ? undefined : { relation: 'e' as const, field: r.field.fieldIdentifier, detail: `EQUALS [${v1}] and EQUALS [${v2}] returned ${n} (core#741)` };
        });
        if (v) out.push(v);
    }
    return out;
}

/** The pairs for (d): the first advertised EMPTY / NOT_EMPTY of two different fields and one list value of each (bounded). */
export function narrowingPairs(fields: FieldRef[], limit = 8): Array<[Filter, Filter]> {
    const usable = fields.filter((x) => advertises(x, 'NOT_EMPTY'));
    const pairs: Array<[Filter, Filter]> = [];
    for (let i = 0; i + 1 < usable.length && pairs.length < limit; i += 2) pairs.push([filterOf(usable[i], 'NOT_EMPTY'), filterOf(usable[i + 1], 'NOT_EMPTY')]);
    const lists = fields.filter((x) => advertises(x, 'EQUALS') && listValues(x).length);
    for (let i = 0; i + 1 < lists.length && pairs.length < limit + 4; i += 2) {
        pairs.push([filterOf(lists[i], 'EQUALS', [listValues(lists[i])[0]]), filterOf(lists[i + 1], 'NOT_EQUALS', [listValues(lists[i + 1])[0]])]);
    }
    return pairs;
}

export const describeViolations = (v: Violation[]): string => v.map((x) => `(${x.relation}) ${x.field}: ${x.detail}`).join('\n');
