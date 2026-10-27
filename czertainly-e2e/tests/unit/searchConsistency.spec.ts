/**
 * Unit tests of utils/regression/inventory/searchConsistency.ts: the relations between filtered searches against
 * an in-memory engine. A correct engine passes, mutants are caught, and one re-read absorbs a transient change.
 */
import { expect, test } from '@playwright/test';
import { CatalogueGroup, Filter } from '../../utils/regression/inventory/searchApi';
import { andNarrows, anyOfBound, catalogueFields, contradictions, CountFn, emptyPartition, equalsPartition, FieldRef, filterOf, listValues, narrowingPairs, pickSample } from '../../utils/regression/inventory/searchConsistency';

// ------------------------------------------------------------------ an in-memory engine over a small data set

type Doc = Record<string, unknown>;

const DOCS: Doc[] = [
    { CERTIFICATE_STATE: 'issued', KEY_SIZE: 2048, COMMON_NAME: 'a', OWNER: 'u1', GROUP_NAME: ['g1', 'g2'] },
    { CERTIFICATE_STATE: 'issued', KEY_SIZE: 3072, COMMON_NAME: 'b', OWNER: null, GROUP_NAME: ['g1'] },
    { CERTIFICATE_STATE: 'revoked', KEY_SIZE: 2048, COMMON_NAME: 'c', OWNER: null, GROUP_NAME: [] },
    { CERTIFICATE_STATE: 'failed', KEY_SIZE: 4096, COMMON_NAME: 'd', OWNER: 'u2', GROUP_NAME: [] },
    { CERTIFICATE_STATE: 'issued', KEY_SIZE: 2048, COMMON_NAME: 'e', OWNER: null, GROUP_NAME: ['g2'] },
];

const catalogue = (): CatalogueGroup[] => [
    {
        filterFieldSource: 'property',
        searchFieldData: [
            { fieldIdentifier: 'CERTIFICATE_STATE', fieldLabel: 'State', type: 'list', conditions: ['EQUALS', 'NOT_EQUALS', 'EMPTY', 'NOT_EMPTY'], value: ['failed', 'issued', 'revoked'] },
            { fieldIdentifier: 'KEY_SIZE', fieldLabel: 'Key Size', type: 'list', conditions: ['EQUALS', 'NOT_EQUALS', 'EMPTY', 'NOT_EMPTY'], value: [2048, 3072, 4096, null] },
            { fieldIdentifier: 'COMMON_NAME', fieldLabel: 'CN', type: 'string', conditions: ['EQUALS', 'EMPTY', 'NOT_EMPTY'] },
            { fieldIdentifier: 'OWNER', fieldLabel: 'Owner', type: 'list', conditions: ['EQUALS', 'NOT_EQUALS', 'EMPTY', 'NOT_EMPTY'], value: ['u1', 'u2'] },
            { fieldIdentifier: 'GROUP_NAME', fieldLabel: 'Group', type: 'list', conditions: ['EQUALS', 'NOT_EQUALS', 'EMPTY', 'NOT_EMPTY'], value: ['g1', 'g2'] },
            { fieldIdentifier: 'CRL_VALIDATION', fieldLabel: 'CRL', type: 'list', conditions: ['EQUALS', 'EMPTY', 'NOT_EMPTY'], value: ['valid'] },
            { fieldIdentifier: 'PRIVATE_KEY', fieldLabel: 'Private key', type: 'boolean', conditions: ['EQUALS', 'NOT_EQUALS'] },
        ],
    },
];

interface Mutations {
    /** NOT_EQUALS leaves out the rows that have no value (the bug core#813 fixed). */
    notEqualsDropsNulls?: boolean;
    /** EMPTY returns every row (core#741). */
    emptyReturnsAll?: boolean;
    /** AND acts as OR. */
    andIsOr?: boolean;
    /** A row appears once between two reads (a concurrent upload). */
    transientExtraRow?: boolean;
}

function engine(mut: Mutations = {}): { count: CountFn; reads: () => number } {
    let reads = 0;
    const one = (doc: Doc, f: Filter): boolean => {
        const v = doc[f.fieldIdentifier];
        const arr = Array.isArray(v) ? v : v === null || v === undefined ? [] : [v];
        const wanted = Array.isArray(f.value) ? f.value : [f.value];
        switch (f.condition) {
            case 'EMPTY':
                return mut.emptyReturnsAll ? true : arr.length === 0;
            case 'NOT_EMPTY':
                return arr.length > 0;
            case 'EQUALS':
                return arr.some((x) => wanted.includes(x));
            case 'NOT_EQUALS':
                return mut.notEqualsDropsNulls && arr.length === 0 ? false : !arr.some((x) => wanted.includes(x));
            default:
                throw new Error(`fake engine: ${f.condition}`);
        }
    };
    let flaky = mut.transientExtraRow ? 1 : 0;
    return {
        reads: () => reads,
        count: async (filters) => {
            reads += 1;
            let n = DOCS.filter((d) => (mut.andIsOr ? filters.some((f) => one(d, f)) || filters.length === 0 : filters.every((f) => one(d, f)))).length;
            if (flaky && filters.length === 0) {
                flaky -= 1;
                n += 1; // the unfiltered total moved once
            }
            return n;
        },
    };
}

const fields = (): FieldRef[] => catalogueFields(catalogue());

test('catalogueFields drops the three known-500 validation fields; listValues keeps scalars only; sample is deterministic and bounded', () => {
    const ids = fields().map((f) => f.field.fieldIdentifier);
    expect(ids).not.toContain('CRL_VALIDATION');
    expect(ids).toContain('CERTIFICATE_STATE');
    expect(listValues(fields().find((f) => f.field.fieldIdentifier === 'KEY_SIZE')!)).toEqual([2048, 3072, 4096]);
    expect(listValues(fields().find((f) => f.field.fieldIdentifier === 'COMMON_NAME')!), 'a string field has no catalogue values').toEqual([]);
    expect(pickSample([1, 2, 3, 4, 5, 6, 7, 8, 9, 10], 4)).toEqual([1, 4, 7, 10]);
    expect(pickSample([1, 2], 4)).toEqual([1, 2]);
    expect(pickSample([1, 2, 3], 2)).toEqual([1, 3]);
});

test('a correct engine satisfies every relation', async () => {
    const { count } = engine();
    const total = () => count([]);
    const f = fields();
    expect(await emptyPartition(f, count, total)).toEqual([]);
    expect(await equalsPartition(f, count, total)).toEqual([]);
    expect(await anyOfBound(f, count)).toEqual([]);
    expect(await andNarrows(narrowingPairs(f), count)).toEqual([]);
    expect(await contradictions(f, count)).toEqual([]);
});

test('mutants are caught: NOT_EQUALS dropping nulls (b), EMPTY returning everything (a), AND acting as OR (d and e)', async () => {
    const f = fields();
    const m1 = engine({ notEqualsDropsNulls: true });
    const b = await equalsPartition(f, m1.count, () => m1.count([]));
    expect([...new Set(b.map((v) => v.field))].sort(), 'one violation per sampled value of the fields with empty rows').toEqual(['GROUP_NAME', 'OWNER']);
    expect(b.every((v) => v.relation === 'b')).toBe(true);
    const m2 = engine({ emptyReturnsAll: true });
    const a = await emptyPartition(f, m2.count, () => m2.count([]));
    expect(a.length, 'every field that advertises EMPTY + NOT_EMPTY breaks').toBeGreaterThan(3);
    expect(a[0].relation).toBe('a');
    const m3 = engine({ andIsOr: true });
    expect((await contradictions(f, m3.count)).map((v) => v.field)).toContain('CERTIFICATE_STATE');
    expect((await andNarrows(narrowingPairs(f), m3.count)).length).toBeGreaterThan(0);
});

test('one re-read absorbs a transient change of the total; a persistent mismatch is reported', async () => {
    const transient = engine({ transientExtraRow: true });
    expect(await emptyPartition(fields(), transient.count, () => transient.count([]))).toEqual([]);
    // A total that is always one too high is not transient: the second read fails too.
    const { count } = engine();
    const always = await emptyPartition(fields(), count, async () => (await count([])) + 1);
    expect(always.length).toBeGreaterThan(0);
    expect(always[0].detail).toMatch(/EMPTY \d+ \+ NOT_EMPTY \d+ = \d+, total \d+/);
});

test('filterOf builds the request filter with the field source', () => {
    const r = fields().find((x) => x.field.fieldIdentifier === 'OWNER')!;
    expect(filterOf(r, 'EMPTY')).toEqual({ fieldSource: 'property', fieldIdentifier: 'OWNER', condition: 'EMPTY' });
    expect(filterOf(r, 'EQUALS', ['u1'])).toEqual({ fieldSource: 'property', fieldIdentifier: 'OWNER', condition: 'EQUALS', value: ['u1'] });
});
