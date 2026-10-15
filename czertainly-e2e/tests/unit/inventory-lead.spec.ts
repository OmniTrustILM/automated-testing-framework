/**
 * Inventory area, the lead's specs (API-CERT-41…56): the metamorphic relations of API-CERT-50 against an in-memory engine
 * (a correct one passes, mutants are caught, one re-read absorbs a transient change), and the guard's verdict on every
 * request shape the lead's specs send (searches with sorts / attribute filters / arrays, catalogue reads, the own PATCH
 * and bulk archive). No ILM environment: the guard judges the request; nothing is sent (`api.check`).
 */
import { expect, request, test } from '@playwright/test';
import { guardApi, GuardedApi } from '../../utils/regression/guardedApi';
import { CatalogueGroup, Filter } from '../../utils/regression/inventoryApi';
import {
    andNarrows, anyOfBound, catalogueFields, contradictions, CountFn, emptyPartition, equalsPartition, FieldRef, filterOf, listValues, narrowingPairs, sample,
} from '../../utils/regression/inventoryInvariants';
import { RUN_ID } from '../../utils/regression/regressionRun';

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
    expect(sample([1, 2, 3, 4, 5, 6, 7, 8, 9, 10], 4)).toEqual([1, 4, 7, 10]);
    expect(sample([1, 2], 4)).toEqual([1, 2]);
    expect(sample([1, 2, 3], 2)).toEqual([1, 3]);
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

// ------------------------------------------------------------------ the guard's verdict on the request shapes of the specs

test.describe('the guard accepts the request shapes of API-CERT-41…56 (nothing is sent)', () => {
    let api: GuardedApi;
    const saved: Record<string, string | undefined> = {};
    const KEYS = ['BASE_URL', 'TIER_KIND', 'REG_RUN_ID', 'REG_STATE_DIR'];

    test.beforeEach(async ({}, testInfo) => {
        for (const k of KEYS) saved[k] = process.env[k];
        process.env.BASE_URL = 'http://127.0.0.1:1/administrator/';
        process.env.TIER_KIND = 'shared';
        process.env.REG_RUN_ID = RUN_ID;
        process.env.REG_STATE_DIR = testInfo.outputPath('state');
        api = guardApi(await request.newContext({ baseURL: process.env.BASE_URL, extraHTTPHeaders: { Authorization: 'Bearer X' } }));
    });
    test.afterEach(async () => {
        await api.dispose();
        for (const k of KEYS) {
            if (saved[k] === undefined) delete process.env[k];
            else process.env[k] = saved[k];
        }
    });

    const P = `${RUN_ID}-flt-abc-`;
    const search = (extra: Record<string, unknown>) => ({ filters: [{ fieldSource: 'property', fieldIdentifier: 'COMMON_NAME', condition: 'STARTS_WITH', value: P }], itemsPerPage: 100, pageNumber: 1, ...extra });

    const BODIES: Array<[string, Record<string, unknown>]> = [
        ['a sort on a property field', search({ sort: { fieldSource: 'property', fieldIdentifier: 'NOT_AFTER', direction: 'desc' } })],
        ['a sort on a custom attribute', search({ sort: { fieldSource: 'custom', fieldIdentifier: `${P}num|INTEGER`, direction: 'asc' } })],
        ['includeArchived', search({ includeArchived: true })],
        ['array values', { ...search({}), filters: [{ fieldSource: 'property', fieldIdentifier: 'KEY_SIZE', condition: 'EQUALS', value: [3072, 4096] }] }],
        ['a value-less EMPTY', { ...search({}), filters: [{ fieldSource: 'property', fieldIdentifier: 'GROUP_NAME', condition: 'EMPTY' }] }],
        ['an empty value list and an empty string', { ...search({}), filters: [{ fieldSource: 'property', fieldIdentifier: 'COMMON_NAME', condition: 'EQUALS', value: [] }, { fieldSource: 'property', fieldIdentifier: 'NOT_AFTER', condition: 'IN_NEXT', value: '' }] }],
        ['a regex and a literal-quote sequence', { ...search({}), filters: [{ fieldSource: 'property', fieldIdentifier: 'COMMON_NAME', condition: 'MATCHES', value: '\\Qabc\\E' }, { fieldSource: 'property', fieldIdentifier: 'COMMON_NAME', condition: 'MATCHES', value: '(' }] }],
        ['an attribute filter with a boolean', { ...search({}), filters: [{ fieldSource: 'custom', fieldIdentifier: `${P}flag|BOOLEAN`, condition: 'EQUALS', value: true }] }],
        ['a datetime with an offset', { ...search({}), filters: [{ fieldSource: 'property', fieldIdentifier: 'NOT_AFTER', condition: 'EQUALS', value: '2030-03-30T10:00:00+02:00' }] }],
    ];
    for (const [name, body] of BODIES) {
        test(`POST /api/v1/certificates: ${name}`, async () => {
            await api.check('POST', '/api/v1/certificates', body);
        });
    }

    test('POST /api/v1/keys (the CKI_LENGTH number probe) and the catalogue reads', async () => {
        await api.check('POST', '/api/v1/keys', { filters: [{ fieldSource: 'property', fieldIdentifier: 'CKI_LENGTH', condition: 'GREATER', value: 'abc' }], itemsPerPage: 1, pageNumber: 1 });
        await api.check('GET', '/api/v1/keys/search');
        await api.check('GET', '/api/v1/certificates/search');
        await api.check('GET', '/api/v1/attributes/custom/resources/certificates');
        await api.check('GET', '/api/v1/statistics', undefined, { params: { includeArchived: true } });
    });

    test('the listing searches and catalogue reads of API-GEN-11…15 / 23…25', async () => {
        const body = { filters: [], itemsPerPage: 10, pageNumber: 1 };
        for (const url of ['/api/v1/certificates', '/api/v1/keys', '/api/v1/discoveries/list', '/api/v1/auditLogs', '/api/v1/oids/list', '/api/v1/locations', '/api/v1/secrets', '/api/v1/entities/list', '/api/v1/vaults/list', '/api/v1/vaultProfiles/list']) {
            await api.check('POST', url, body);
            await api.check('POST', url, { ...body, sort: { fieldSource: 'property', fieldIdentifier: 'ANY_FIELD', direction: 'asc' } });
        }
        for (const url of ['/api/v1/auditLogs/search', '/api/v1/keys/search', '/api/v1/discoveries/search', '/api/v1/settings/logging', '/api/v1/attributes/custom', '/api/v1/listViews?resource=certificates', '/api/v1/oids/1.2.3.4']) {
            await api.check('GET', url);
        }
        await api.check('GET', '/api/v1/certificates/00000000-0000-4000-8000-000000000000/raw', undefined, { params: { encoding: 'pem' } }).catch((e) => expect(String(e)).toMatch(/ownership|probe|own/i));
    });
});
