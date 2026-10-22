/**
 * fieldOracles — property oracles per catalogue field.
 *
 * WHAT: Property oracles per catalogue field over whatever data the tier holds (no exact counts): every returned row satisfies
 *       the filter, the exact conditions return the set the baseline implies, the complementary conditions partition the
 *       total, and AND is the intersection. String conditions use the weak case rule; datetimes use partitions only.
 * WHY: The tier's data is unknown, so a field is checked by properties that hold for any data.
 * HOW: Every returned row satisfies the filter, exact conditions return the set the baseline implies, complementary conditions partition the total and AND is the intersection; string conditions use the weak case rule and datetimes use partitions only.
 */
import { propertyFilter } from '../searchApi';
import type { CatalogueField, Filter } from '../searchApi';
import { expectAndNarrowsResults, expectEmptyPlusNotEmptyEqualsTotal, InvariantViolation } from '../listInvariants';
import type { ListRow } from '../listInvariants';
import { FieldMap, Scalar, datetimeLiteral, expectedRows, instantMs, pickSpread, regexLiteral, pickSampleValues, satisfiesFilter, textProbe } from './values';
import { expectCountsAdd, expectInstantOrder, expectInstantsWithin, expectIntersection, expectKeysEqual, expectRowsSatisfy, expectSubset } from './listExpectations';
import { ListingRun, RowSet, fetchRows, listingPage, listingTotal } from './listing';

// ====================================================================================================================
// 6. Field oracles (API-GEN-13 / -14 / -15)
// ====================================================================================================================

const SKEW_MS = 120_000;
const DAY_MS = 86_400_000;

/**
 * Every oracle of one mapped property field against the live listing, with the published conditions of its catalogue entry
 * deciding what runs. Throws InvariantViolation / ListingError on the first violation.
 */
export async function runFieldOracles(run: ListingRun, field: FieldMap, live: CatalogueField): Promise<void> {
    const { transport: t, spec, baseline: base, log } = run;
    const adv = new Set(live.conditions);
    const key = spec.rowKey;
    const cap = spec.maxWalkRows;
    const f = (condition: string, value?: unknown): Filter[] => [propertyFilter(field.id, condition, value)];
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

    // |EMPTY| + |NOT_EMPTY| = total (API-CERT-50 wording).
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

    const samples = pickSampleValues(sampleRows, field, 3);
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
        const instant = (r: ListRow): number | undefined => instantMs(field.get(r)[0]);
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
        if (adv.has('IN_PAST') && adv.has('IN_NEXT')) await runWindowOracles(run, field, f, cap, instant);
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
async function runWindowOracles(run: ListingRun, field: FieldMap, f: (c: string, v?: unknown) => Filter[], cap: number, instant: (r: ListRow) => number | undefined): Promise<void> {
    const { transport: t, spec, baseline: base, log } = run;
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
export async function runGenericFieldOracles(run: ListingRun, source: string, live: CatalogueField): Promise<void> {
    const { transport: t, spec, baseline: base, log } = run;
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
export function findAndPairs(fields: FieldMap[], rows: ListRow[], liveIds: ReadonlySet<string>, max = 2): AndPair[] {
    const candidates: Array<{ field: FieldMap; v: Scalar; set: Set<ListRow> }> = [];
    for (const field of fields.filter((x) => liveIds.has(x.id) && x.shape !== 'datetime')) {
        for (const v of pickSampleValues(rows, field, 3)) {
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
                pair: { a: propertyFilter(x.field.id, 'EQUALS', x.v), b: propertyFilter(y.field.id, 'EQUALS', y.v), describe: `${x.field.id} = ${JSON.stringify(x.v)} AND ${y.field.id} = ${JSON.stringify(y.v)}` },
                score: (narrows ? 2 : both > 0 ? 1 : 0) * 1000 + Math.min(x.set.size, y.set.size),
            });
        }
    }
    return out.sort((p, q) => q.score - p.score).slice(0, max).map((o) => o.pair);
}

/** A AND B = A ∩ B, B AND A = A AND B, both subsets of each side (invariants.expectAndNarrowsResults plus the exact intersection). */
export async function runAndOracle(run: Omit<ListingRun, 'baseline'>, pair: AndPair): Promise<void> {
    const { transport: t, spec, log } = run;
    const cap = spec.maxWalkRows;
    const key = spec.rowKey;
    const a = await fetchRows(t, spec, [pair.a], cap);
    const b = await fetchRows(t, spec, [pair.b], cap);
    const ab = await fetchRows(t, spec, [pair.a, pair.b], cap);
    const ba = await fetchRows(t, spec, [pair.b, pair.a], cap);
    if (ab.total > Math.min(a.total, b.total)) throw new InvariantViolation(`${pair.describe}: A and B returns ${ab.total} rows, more than min(|A| ${a.total}, |B| ${b.total})`);
    if (ab.total !== ba.total) throw new InvariantViolation(`${pair.describe}: the filter order changes the total (${ab.total} vs ${ba.total})`);
    if (a.complete && b.complete && ab.complete && ba.complete) {
        expectAndNarrowsResults(a.rows, b.rows, ab.rows, ba.rows, { key });
        expectIntersection(`${pair.describe}: A and B is not the intersection of A and B`, a.rows, b.rows, ab.rows, key);
    }
    log.step(`${pair.describe}: |A| ${a.total}, |B| ${b.total}, |A and B| ${ab.total}`);
}
