/**
 * Unit tests for the pure parts of utils/regression/inventoryOracles.ts (API-GEN-11…15 of the inventory-api area): the
 * catalogue contract (shape, absolute condition sets, kinds), the row predicates, sampling, every checker the module adds
 * to invariants.ts, the audit-log gate and the activity helpers. Each checker passes on a correct input and names the
 * field, the neighbouring rows or the sets on a wrong one. No environment, no network.
 */
import { expect, test } from '@playwright/test';
import {
    activityFilters, activityMatches, auditGate, AUDIT_LOGS, CATALOGUES, catalogueProblems, classifyConditions, datetimeLiteral, DISCOVERIES, expectationsOf,
    expectContinuation, expectCountsAdd, expectInstantOrder, expectInstantsWithin, expectIntersection, expectKeysEqual, expectMirror, expectNullsLast, expectOrderedText,
    expectRowsSatisfy, expectSameOrder, expectSubset, expectTieBreakAscending, expectedRows, findAndPairs, instantMs, InvariantViolation, isExactCondition, KEYS,
    KIND_CONDITIONS, pickSpread, regexLiteral, RunLog, sampleValues, satisfiesFilter, SORT_REFUSING_LISTINGS, textOrdered, textProbe, toValues, unsupportedSortText,
    withReread, type ConditionKind, type FieldMap, type Row,
} from '../../utils/regression/inventoryOracles';

const key = (r: Row): string => String(r.uuid);
const rows = (...ids: string[]): Row[] => ids.map((uuid) => ({ uuid }));

// ------------------------------------------------------------------ values

test('toValues: null, undefined, empty arrays and objects are no value; arrays flatten; the empty string IS a value', () => {
    expect(toValues(null)).toEqual([]);
    expect(toValues(undefined)).toEqual([]);
    expect(toValues([])).toEqual([]);
    expect(toValues({ a: 1 })).toEqual([]);
    expect(toValues(['a', null, ['b', undefined]])).toEqual(['a', 'b']);
    expect(toValues('')).toEqual(['']);
    expect(toValues(0)).toEqual([0]);
    expect(toValues(false)).toEqual([false]);
});

test('instantMs reads ISO text with any fraction length, epoch seconds and epoch milliseconds', () => {
    const ms = Date.UTC(2026, 9, 14, 10, 0, 0, 123);
    expect(instantMs('2026-10-14T10:00:00.123456Z')).toBe(ms);
    expect(instantMs('2026-10-14T12:00:00.123456789+02:00')).toBe(ms);
    expect(instantMs(ms / 1000)).toBe(ms);
    expect(instantMs(ms)).toBe(ms);
    expect(instantMs('not a date')).toBeUndefined();
    expect(instantMs({})).toBeUndefined();
});

test('datetimeLiteral keeps the server text, cuts the fraction to milliseconds and keeps the offset', () => {
    expect(datetimeLiteral('2026-10-14T10:00:00.123456Z')).toBe('2026-10-14T10:00:00.123Z');
    expect(datetimeLiteral('2026-10-14T12:00:00.5+02:00')).toBe('2026-10-14T12:00:00.500+02:00');
    expect(datetimeLiteral('2026-10-14T10:00:00Z')).toBe('2026-10-14T10:00:00Z');
    expect(datetimeLiteral(Date.UTC(2026, 9, 14, 10, 0, 0, 7))).toBe('2026-10-14T10:00:00.007Z');
    expect(() => datetimeLiteral('x')).toThrow(/not a datetime/);
});

// ------------------------------------------------------------------ condition kinds

test('classifyConditions: the type decides which of the equal-looking sets a field publishes', () => {
    const k = (type: string, kind: ConditionKind) => classifyConditions(type, KIND_CONDITIONS[kind]);
    expect(k('string', 'string')).toBe('string');
    expect(k('string', 'jsonArray')).toBe('jsonArray');
    expect(k('list', 'list')).toBe('list');
    expect(k('boolean', 'boolean')).toBe('boolean');
    expect(k('list', 'collection')).toBe('collection');
    expect(k('list', 'nativeArray')).toBe('nativeArray');
    expect(k('number', 'number')).toBe('number');
    expect(k('datetime', 'date')).toBe('date');
    expect(k('date', 'time')).toBe('time');
    expect(k('boolean', 'expectedBoolean')).toBe('expectedBoolean');
    expect(k('string', 'freeText')).toBe('freeText');
    for (const type of ['string', 'number', 'list', 'date', 'datetime', 'boolean']) expect(classifyConditions(type, ['EMPTY', 'NOT_EMPTY'])).toBe('presence');
    // none of the sets: a missing condition, an extra one, the wrong type for the set
    expect(classifyConditions('number', ['EQUALS', 'NOT_EQUALS', 'GREATER'])).toBeUndefined();
    expect(classifyConditions('string', [...KIND_CONDITIONS.string, 'IN_PAST'])).toBeUndefined();
    expect(classifyConditions('number', KIND_CONDITIONS.string)).toBeUndefined();
    expect(classifyConditions('list', KIND_CONDITIONS.date)).toBeUndefined();
    expect(classifyConditions('nope', ['EQUALS'])).toBeUndefined();
    // set sizes of the plan table (inventory-api §2.2 "Absolute condition sets") and the core code
    expect(Object.fromEntries(Object.entries(KIND_CONDITIONS).map(([n, c]) => [n, c.length]))).toEqual({
        string: 10, number: 8, date: 10, time: 8, list: 4, collection: 8, nativeArray: 6, jsonArray: 4, boolean: 4, expectedBoolean: 2, presence: 2, freeText: 1,
    });
});

// ------------------------------------------------------------------ the catalogue contract

/** A catalogue built from a listing table: every field with the conditions of its kind. */
function catalogueOf(spec: typeof KEYS, patch: (f: Record<string, unknown>) => void = () => undefined, extraGroups: unknown[] = []): unknown[] {
    const fields = spec.fields.map((f) => ({
        fieldIdentifier: f.id,
        fieldLabel: f.id.toLowerCase(),
        type: f.type,
        conditions: [...KIND_CONDITIONS[f.kind]],
        multiValue: f.type === 'list',
        displayable: spec.configurable && f.id !== 'CKI_USAGE',
        sortable: spec.configurable && f.sortable,
    }));
    fields.forEach(patch);
    return [{ filterFieldSource: 'property', searchFieldData: fields }, ...extraGroups];
}

const problems = (body: unknown, spec: typeof KEYS, onlyProperty = false): string[] => catalogueProblems(body, expectationsOf(spec, onlyProperty)).problems;

test('catalogueProblems: the catalogues the field tables describe are sound (keys, discoveries, audit logs)', () => {
    expect(problems(catalogueOf(KEYS), KEYS)).toEqual([]);
    expect(problems(catalogueOf(DISCOVERIES), DISCOVERIES)).toEqual([]);
    expect(problems(catalogueOf(AUDIT_LOGS), AUDIT_LOGS, true)).toEqual([]);
    const report = catalogueProblems(catalogueOf(KEYS), expectationsOf(KEYS));
    expect(report.fields.find((f) => f.id === 'CKI_LENGTH')).toMatchObject({ type: 'number', kind: 'number' });
    expect(report.fields.find((f) => f.id === 'CK_GROUP')).toMatchObject({ kind: 'collection' });
});

test('catalogueProblems: CKI_LENGTH must be a number with the 8 number conditions; any other set is named', () => {
    const wrongType = catalogueOf(KEYS, (f) => {
        if (f.fieldIdentifier === 'CKI_LENGTH') f.type = 'list';
    });
    expect(problems(wrongType, KEYS).join('\n')).toMatch(/CKI_LENGTH.*none of the absolute sets of type list|CKI_LENGTH: type list, expected number/);
    const sevenConditions = catalogueOf(KEYS, (f) => {
        if (f.fieldIdentifier === 'CKI_LENGTH') f.conditions = KIND_CONDITIONS.number.slice(0, 7);
    });
    expect(problems(sevenConditions, KEYS).join('\n')).toMatch(/property:CKI_LENGTH: conditions \[.*\] are none of the absolute sets of type number \(number: 8, presence: 2\)/);
    const stringSetOnNumber = catalogueOf(KEYS, (f) => {
        if (f.fieldIdentifier === 'CKI_LENGTH') f.conditions = [...KIND_CONDITIONS.string];
    });
    expect(problems(stringSetOnNumber, KEYS).join('\n')).toMatch(/CKI_LENGTH.*none of the absolute sets/);
});

test('catalogueProblems: shape, duplicates, blank labels, unknown conditions, duplicate conditions', () => {
    expect(problems({ not: 'an array' }, KEYS)[0]).toMatch(/not a SearchFieldDataByGroupDto list/);
    expect(problems([{ searchFieldData: [] }], KEYS)[0]).toMatch(/not a SearchFieldDataByGroupDto list.*filterFieldSource/);
    expect(problems([{ filterFieldSource: 'bogus', searchFieldData: [] }], KEYS)[0]).toMatch(/not a SearchFieldDataByGroupDto list/);
    expect(problems(catalogueOf(KEYS, (f) => {
        if (f.fieldIdentifier === 'CKI_NAME') f.fieldLabel = '   ';
    }), KEYS).join('\n')).toMatch(/property:CKI_NAME: blank label/);
    expect(problems(catalogueOf(KEYS, (f) => {
        if (f.fieldIdentifier === 'CKI_NAME') f.fieldLabel = '';
    }), KEYS)[0]).toMatch(/not a SearchFieldDataByGroupDto list/); // minLength 1 in the schema
    const dup = catalogueOf(KEYS);
    (dup[0] as { searchFieldData: unknown[] }).searchFieldData.push({ ...(dup[0] as { searchFieldData: Record<string, unknown>[] }).searchFieldData[0] });
    expect(problems(dup, KEYS).join('\n')).toMatch(/property:CKI_NAME: identifier published twice/);
    expect(problems(catalogueOf(KEYS, (f) => {
        if (f.fieldIdentifier === 'CKI_NAME') f.conditions = [...KIND_CONDITIONS.string, 'NOPE'];
    }), KEYS)[0]).toMatch(/not a SearchFieldDataByGroupDto list/);
    expect(problems(catalogueOf(KEYS, (f) => {
        if (f.fieldIdentifier === 'CKI_NAME') f.conditions = [...KIND_CONDITIONS.string, 'EQUALS'];
    }), KEYS)[0]).toMatch(/not a SearchFieldDataByGroupDto list/); // uniqueItems
    expect(problems(catalogueOf(KEYS, (f) => {
        if (f.fieldIdentifier === 'CKI_NAME') f.fieldIdentifier = 'cki_name';
    }), KEYS).join('\n')).toMatch(/a property identifier is a FilterField name/);
});

test('catalogueProblems: the audit log publishes the Property source only and no sortable or displayable field', () => {
    const extra = catalogueOf(AUDIT_LOGS, () => undefined, [{ filterFieldSource: 'custom', searchFieldData: [] }]);
    expect(problems(extra, AUDIT_LOGS, true).join('\n')).toMatch(/only the property source may be published, got \[property, custom\]/);
    const sortable = catalogueOf(AUDIT_LOGS, (f) => {
        if (f.fieldIdentifier === 'AUDIT_LOG_MESSAGE') {
            f.sortable = true;
            f.displayable = true;
        }
    });
    expect(problems(sortable, AUDIT_LOGS, true).join('\n')).toMatch(/AUDIT_LOG_MESSAGE: sortable true \/ displayable true on a listing that is not wired to configurable columns/);
    const missing = catalogueOf(AUDIT_LOGS);
    (missing[0] as { searchFieldData: Array<{ fieldIdentifier: string }> }).searchFieldData = (missing[0] as { searchFieldData: Array<{ fieldIdentifier: string }> }).searchFieldData.filter((f) => f.fieldIdentifier !== 'AUDIT_LOG_OPERATION');
    expect(problems(missing, AUDIT_LOGS, true).join('\n')).toMatch(/property:AUDIT_LOG_OPERATION: missing from the catalogue/);
    const noProperty = [{ filterFieldSource: 'custom', searchFieldData: [] }];
    expect(problems(noProperty, AUDIT_LOGS, true).join('\n')).toMatch(/no property group/);
});

test('catalogueProblems: sortable consistency on a configurable listing (core#2180, bit masks, presence, native arrays)', () => {
    const sortableNotDisplayable = catalogueOf(KEYS, (f) => {
        if (f.fieldIdentifier === 'CKI_NAME') f.displayable = false;
    });
    expect(problems(sortableNotDisplayable, KEYS).join('\n')).toMatch(/CKI_NAME: sortable but not displayable \(core#2180\)/);
    const usageSortable = catalogueOf(KEYS, (f) => {
        if (f.fieldIdentifier === 'CKI_USAGE') {
            f.sortable = true;
            f.displayable = true;
        }
    });
    expect(problems(usageSortable, KEYS).join('\n')).toMatch(/CKI_USAGE: sortable true, expected false/);
    const presenceSortable = catalogueOf(KEYS, (f) => {
        if (f.fieldIdentifier === 'CKI_NAME') {
            f.conditions = [...KIND_CONDITIONS.presence];
            f.sortable = true;
        }
    });
    expect(problems(presenceSortable, KEYS).join('\n')).toMatch(/CKI_NAME: sortable, but a presence field has nothing to order by/);
    const multi = catalogueOf(KEYS, (f) => {
        if (f.fieldIdentifier === 'CKI_NAME') f.multiValue = true;
    });
    expect(problems(multi, KEYS).join('\n')).toMatch(/CKI_NAME: multiValue true for type string/);
});

test('catalogueProblems: attribute fields (<name>|<TYPE>), the TIME set, native arrays and kinds that exist on property fields only', () => {
    const attr = (over: Record<string, unknown>) => ({ fieldIdentifier: 'department|STRING', fieldLabel: 'Department', type: 'string', conditions: [...KIND_CONDITIONS.string], attributeContentType: 'string', multiValue: false, displayable: true, sortable: true, ...over });
    const withAttr = (a: Record<string, unknown>) => catalogueOf(KEYS, () => undefined, [{ filterFieldSource: 'custom', searchFieldData: [a] }]);
    expect(problems(withAttr(attr({})), KEYS)).toEqual([]);
    expect(problems(withAttr(attr({ fieldIdentifier: 'department' })), KEYS).join('\n')).toMatch(/an attribute identifier is <name>\|<CONTENT_TYPE>/);
    expect(problems(withAttr(attr({ attributeContentType: undefined })), KEYS).join('\n')).toMatch(/carries no attributeContentType/);
    // a TIME attribute publishes the 8-condition date set, a date attribute 10
    expect(problems(withAttr(attr({ fieldIdentifier: 't|TIME', type: 'date', conditions: [...KIND_CONDITIONS.time], attributeContentType: 'time' })), KEYS)).toEqual([]);
    expect(problems(withAttr(attr({ fieldIdentifier: 't|DATE', type: 'date', conditions: [...KIND_CONDITIONS.time], attributeContentType: 'date' })), KEYS).join('\n')).toMatch(/the 8-condition date set belongs to a TIME attribute only/);
    // a collection or an expected-value boolean is a property kind
    expect(problems(withAttr(attr({ fieldIdentifier: 'g|LIST', type: 'list', conditions: [...KIND_CONDITIONS.collection], multiValue: true })), KEYS).join('\n')).toMatch(/kind collection exists on property fields only/);
    // a native array is multi-valued
    expect(problems(withAttr(attr({ fieldIdentifier: 'n|LIST', type: 'list', conditions: [...KIND_CONDITIONS.nativeArray], multiValue: false })), KEYS).join('\n')).toMatch(/a native-array field is multiValue/);
    // the encrypted / withheld attribute publishes the presence pair
    expect(problems(withAttr(attr({ fieldIdentifier: 's|SECRET', conditions: [...KIND_CONDITIONS.presence], displayable: false, sortable: false })), KEYS)).toEqual([]);
});

test('every catalogue row names an endpoint of a GET <listing>/search and a configurable flag from SearchHelper', () => {
    const names = CATALOGUES.map((c) => c.name);
    expect(new Set(names).size).toBe(names.length);
    for (const c of CATALOGUES) expect(c.url, c.name).toMatch(/^\/api\/v[12]\/[A-Za-z]+(\/[A-Za-z]+)?\/search$/);
    // CONFIGURABLE_COLUMN_RESOURCES: certificates, keys, discoveries, connectors v2, secrets, CBOMs, signing records, crypto assets
    expect(CATALOGUES.filter((c) => c.configurable).map((c) => c.name).sort()).toEqual(['cboms', 'certificates', 'connectorsV2', 'cryptoAssets', 'discoveries', 'keys', 'secrets', 'signingRecords']);
    expect(CATALOGUES.find((c) => c.name === 'auditLogs')).toMatchObject({ configurable: false, onlyProperty: true });
    expect(SORT_REFUSING_LISTINGS.map((l) => l.name)).toEqual(['auditLogs', 'oids', 'locations', 'entities', 'vaults', 'vaultProfiles']);
    expect(unsupportedSortText('Audit logs')).toBe('Sorting is not supported for the Audit logs listing.');
    expect(unsupportedSortText('OID')).toBe('Sorting is not supported for the OID listing.');
});

// ------------------------------------------------------------------ row predicates

test('satisfiesFilter: the reference rules of rules §2.2 r12-r16 (nulls, complements, weak string forms, COUNT_*)', () => {
    // EMPTY / NOT_EMPTY: no value; the empty string is a value
    expect(satisfiesFilter([], 'EMPTY')).toBe(true);
    expect(satisfiesFilter([''], 'EMPTY')).toBe(false);
    expect(satisfiesFilter([''], 'NOT_EMPTY')).toBe(true);
    // EQUALS = any of the listed values; NOT_EQUALS = none of them, rows without a value included
    expect(satisfiesFilter(['a', 'b'], 'EQUALS', 'b')).toBe(true);
    expect(satisfiesFilter(['a', 'b'], 'EQUALS', ['x', 'b'])).toBe(true);
    expect(satisfiesFilter(['a', 'b'], 'NOT_EQUALS', 'b')).toBe(false);
    expect(satisfiesFilter([], 'NOT_EQUALS', 'b')).toBe(true);
    expect(satisfiesFilter([2048], 'EQUALS', 2048)).toBe(true);
    expect(satisfiesFilter([true], 'EQUALS', true)).toBe(true);
    expect(satisfiesFilter([false], 'EQUALS', true)).toBe(false);
    // weak string forms: positive ones ignore case, negative ones are case-sensitive
    expect(satisfiesFilter(['Alpha-1'], 'CONTAINS', 'alp')).toBe(true);
    expect(satisfiesFilter(['Alpha-1'], 'NOT_CONTAINS', 'alp'), 'a case-sensitive server returns it for NOT_CONTAINS "alp"').toBe(true);
    expect(satisfiesFilter(['Alpha-1'], 'NOT_CONTAINS', 'Alp')).toBe(false);
    expect(satisfiesFilter([], 'NOT_CONTAINS', 'x')).toBe(true);
    expect(satisfiesFilter([], 'CONTAINS', 'x')).toBe(false);
    expect(satisfiesFilter(['Alpha-1'], 'STARTS_WITH', 'ALPH')).toBe(true);
    expect(satisfiesFilter(['Alpha-1'], 'ENDS_WITH', '-1')).toBe(true);
    expect(satisfiesFilter(['Alpha-1'], 'MATCHES', '^alpha')).toBe(true);
    expect(satisfiesFilter(['Alpha-1'], 'NOT_MATCHES', '^alpha'), 'case-sensitive: "Alpha" does not match ^alpha').toBe(true);
    expect(satisfiesFilter([], 'NOT_MATCHES', '^a'), 'NOT_MATCHES excludes rows without a value').toBe(false);
    expect(satisfiesFilter([], 'MATCHES', '^a')).toBe(false);
    // numbers: a comparison needs a value
    expect(satisfiesFilter([2048], 'GREATER', 1024)).toBe(true);
    expect(satisfiesFilter([2048], 'GREATER', 2048)).toBe(false);
    expect(satisfiesFilter([2048], 'GREATER_OR_EQUAL', 2048)).toBe(true);
    expect(satisfiesFilter([2048], 'LESSER', 4096)).toBe(true);
    expect(satisfiesFilter([2048], 'LESSER_OR_EQUAL', 2047)).toBe(false);
    expect(satisfiesFilter([], 'GREATER', 0)).toBe(false);
    expect(satisfiesFilter([], 'LESSER_OR_EQUAL', 0)).toBe(false);
    // COUNT_* count the values of the row
    expect(satisfiesFilter(['g1', 'g2'], 'COUNT_EQUAL', 2)).toBe(true);
    expect(satisfiesFilter([], 'COUNT_EQUAL', 0)).toBe(true);
    expect(satisfiesFilter(['g1'], 'COUNT_NOT_EQUAL', 0)).toBe(true);
    expect(satisfiesFilter(['g1', 'g2'], 'COUNT_GREATER_THAN', 1)).toBe(true);
    expect(satisfiesFilter(['g1', 'g2'], 'COUNT_LESS_THAN', 2)).toBe(false);
    expect(() => satisfiesFilter(['a'], 'IN_PAST', 'P1D')).toThrow(/no reference rule for IN_PAST/);
});

test('expectedRows answers for the exact conditions only; the weak string ones are checked by relations', () => {
    const f = { get: (r: Row) => toValues(r.n) };
    const data: Row[] = [{ uuid: 'a', n: 1 }, { uuid: 'b', n: 5 }, { uuid: 'c' }];
    expect(expectedRows(data, f, 'GREATER', 1)?.map(key)).toEqual(['b']);
    expect(expectedRows(data, f, 'NOT_EQUALS', 1)?.map(key)).toEqual(['b', 'c']);
    expect(expectedRows(data, f, 'EMPTY')?.map(key)).toEqual(['c']);
    expect(expectedRows(data, f, 'CONTAINS', '1')).toBeUndefined();
    expect(isExactCondition('MATCHES')).toBe(false);
    expect(isExactCondition('COUNT_EQUAL')).toBe(true);
});

test('regexLiteral escapes every non-alphanumeric character and nothing else', () => {
    expect(regexLiteral('abc123')).toBe('abc123');
    expect(regexLiteral('a.b-c d')).toBe('a\\.b\\-c\\ d');
    for (const text of ['a.b-c d', 'x:y/z', 'k1.2']) expect(new RegExp(`^${regexLiteral(text)}$`).test(text)).toBe(true);
    expect(new RegExp(`^${regexLiteral('a.b')}$`).test('aXb')).toBe(false);
});

test('textProbe returns prefix, suffix and inner probes of <= 4 safe characters only', () => {
    expect(textProbe('certKey-123', 'prefix')).toBe('cert');
    expect(textProbe('certKey-123', 'suffix')).toBe('-123');
    expect(textProbe('certKey-123', 'inner')).toBe('cert');
    expect(textProbe('a_b%c', 'prefix'), 'a LIKE wildcard in the probe is refused (core#2505)').toBeUndefined();
    expect(textProbe('abc_', 'suffix')).toBeUndefined();
    expect(textProbe('x_yyyy%z', 'inner')).toBe('yyyy');
    expect(textProbe('%%', 'inner')).toBeUndefined();
    expect(textProbe('a\\b"c', 'prefix')).toBeUndefined();
    expect(textProbe('', 'prefix')).toBeUndefined();
});

// ------------------------------------------------------------------ sampling

const numberField: Pick<FieldMap, 'get' | 'shape'> = { get: (r) => toValues(r.n), shape: 'number' };
const textField: Pick<FieldMap, 'get' | 'shape'> = { get: (r) => toValues(r.t), shape: 'text' };
const datetimeField: Pick<FieldMap, 'get' | 'shape'> = { get: (r) => toValues(r.d), shape: 'datetime' };

test('pickSpread: first, middle, last; fewer than n values are all returned', () => {
    expect(pickSpread([1, 2, 3, 4, 5, 6, 7])).toEqual([1, 4, 7]);
    expect(pickSpread([1, 2])).toEqual([1, 2]);
    expect(pickSpread([1, 2, 3, 4], 2)).toEqual([1, 4]);
    expect(pickSpread([9], 3)).toEqual([9]);
    expect(pickSpread([], 3)).toEqual([]);
});

test('sampleValues: numbers spread over the range, datetimes over time, text first / most frequent / last; at most 3, distinct', () => {
    const nums: Row[] = [{ n: 4096 }, { n: 2048 }, { n: 2048 }, { n: 1024 }, { n: null }, { n: 3072 }, {}];
    expect(sampleValues(nums, numberField)).toEqual([1024, 2048, 4096]);
    expect(sampleValues(nums, numberField, 2)).toEqual([1024, 4096]);
    const dates: Row[] = [{ d: '2026-10-03T00:00:00Z' }, { d: '2026-10-01T00:00:00Z' }, { d: '2026-10-02T00:00:00Z' }, { d: null }];
    expect(sampleValues(dates, datetimeField)).toEqual(['2026-10-01T00:00:00Z', '2026-10-02T00:00:00Z', '2026-10-03T00:00:00Z']);
    const text: Row[] = [{ t: 'first' }, { t: 'common' }, { t: 'common' }, { t: 'common' }, { t: 'last' }, { t: null }];
    expect(sampleValues(text, textField)).toEqual(['first', 'common', 'last']);
    expect(sampleValues([{ t: 'only' }, { t: 'only' }], textField)).toEqual(['only']);
    expect(sampleValues([{ t: null }, {}], textField)).toEqual([]);
    expect(sampleValues([], numberField)).toEqual([]);
    // arrays contribute every element
    const groups: Row[] = [{ t: ['g1', 'g2'] }, { t: ['g2'] }, { t: [] }];
    expect(sampleValues(groups, textField)).toEqual(['g1', 'g2']);
});

test('findAndPairs prefers a pair whose intersection is non-empty and narrower than both sides', () => {
    const f = (id: string, member: string): FieldMap => ({ id, type: 'list', kind: 'list', shape: 'code', get: (r) => toValues(r[member]), sortable: false, sort: 'none', evidence: 'test' });
    const data: Row[] = [
        { uuid: '1', a: 'x', b: 'p' }, { uuid: '2', a: 'x', b: 'q' }, { uuid: '3', a: 'y', b: 'p' }, { uuid: '4', a: 'y', b: 'q' }, { uuid: '5', a: 'x', b: 'p' }, { uuid: '6', a: 'z', b: 'r' },
    ];
    const pairs = findAndPairs([f('A', 'a'), f('B', 'b')], data, new Set(['A', 'B']), 2);
    expect(pairs.length).toBeGreaterThan(0);
    const first = pairs[0];
    const matchesA = data.filter((r) => satisfiesFilter(toValues(r.a), 'EQUALS', first.a.value));
    const matchesB = data.filter((r) => satisfiesFilter(toValues(r.b), 'EQUALS', first.b.value));
    const both = matchesA.filter((r) => matchesB.includes(r));
    expect(both.length, first.describe).toBeGreaterThan(0);
    expect(both.length).toBeLessThan(Math.min(matchesA.length, matchesB.length));
    // a field that the live catalogue does not publish is never used; one field alone gives no pair
    expect(findAndPairs([f('A', 'a'), f('B', 'b')], data, new Set(['A']))).toEqual([]);
    expect(findAndPairs([f('A', 'a'), f('B', 'b')], [], new Set(['A', 'B']))).toEqual([]);
});

// ------------------------------------------------------------------ checkers

test('expectCountsAdd names the parts and the expected total', () => {
    expect(() => expectCountsAdd('x EQUALS', [['EQUALS', 3], ['NOT_EQUALS', 7]], 10)).not.toThrow();
    expect(() => expectCountsAdd('x EQUALS', [['EQUALS', 3], ['NOT_EQUALS', 6]], 10)).toThrow(/x EQUALS: EQUALS 3 \+ NOT_EQUALS 6 = 9, expected 10/);
});

test('expectKeysEqual, expectSubset and expectIntersection name the missing and the unexpected rows', () => {
    expect(() => expectKeysEqual('s', rows('a', 'b'), rows('b', 'a'), key)).not.toThrow();
    expect(() => expectKeysEqual('s', rows('a'), rows('a', 'b'), key)).toThrow(/s: missing \[b\], unexpected \[\]/);
    expect(() => expectKeysEqual('s', rows('a', 'c'), rows('a'), key)).toThrow(/unexpected \[c\]/);
    expect(() => expectSubset('s', rows('a'), rows('a', 'b'), key)).not.toThrow();
    expect(() => expectSubset('s', rows('a', 'z'), rows('a', 'b'), key)).toThrow(/1 row\(s\) outside the superset \[z\]/);
    expect(() => expectIntersection('i', rows('a', 'b', 'c'), rows('b', 'c', 'd'), rows('c', 'b'), key)).not.toThrow();
    expect(() => expectIntersection('i', rows('a', 'b', 'c'), rows('b', 'c', 'd'), rows('b'), key)).toThrow(/i: missing \[c\]/);
    expect(() => expectIntersection('i', rows('a', 'b'), rows('b', 'c'), rows('b', 'a'), key), 'A and B returned a row that is not in B').toThrow(/unexpected \[a\]/);
});

test('expectContinuation: pages concatenated equal the big request in order; a gap, a repeat, a swap or a short read is named', () => {
    const whole = rows('a', 'b', 'c', 'd', 'e');
    expect(() => expectContinuation('c', [rows('a', 'b'), rows('c', 'd'), rows('e')], whole, key)).not.toThrow();
    expect(() => expectContinuation('c', [rows('a', 'b'), rows('c', 'd'), rows('e', 'f')], whole, key), 'a last page longer than the head window is cut').not.toThrow();
    expect(() => expectContinuation('c', [rows('a', 'b'), rows('b', 'c'), rows('d', 'e')], whole, key)).toThrow(/c: row 2 is b across the pages but c in the single request/);
    expect(() => expectContinuation('c', [rows('a', 'b'), rows('d', 'c'), rows('e')], whole, key)).toThrow(/row 2 is d/);
    expect(() => expectContinuation('c', [rows('a', 'b'), rows('c')], whole, key)).toThrow(/the pages hold 3 rows, the single request 5/);
});

test('expectSameOrder: two identical requests must answer one order', () => {
    expect(() => expectSameOrder('o', rows('a', 'b'), rows('a', 'b'), key)).not.toThrow();
    expect(() => expectSameOrder('o', rows('a', 'b'), rows('b', 'a'), key)).toThrow(/different orders \(first difference at row 0\)/);
    expect(() => expectSameOrder('o', rows('a', 'b'), rows('a'), key)).toThrow(/different orders/);
});

test('expectNullsLast: once a row without a value appears, no row with a value follows', () => {
    const v = (r: Row) => r.v === undefined;
    const data = (...vals: Array<number | undefined>): Row[] => vals.map((x, i) => ({ uuid: `r${i}`, v: x }));
    expect(() => expectNullsLast('n', data(1, 2, undefined, undefined), v, key)).not.toThrow();
    expect(() => expectNullsLast('n', data(1, 2), v, key)).not.toThrow();
    expect(() => expectNullsLast('n', data(undefined, undefined), v, key), 'all empty').not.toThrow();
    expect(() => expectNullsLast('n', data(1, undefined, 2), v, key)).toThrow(/n: row 2 r2 has a value after the empty row 1 r1/);
    expect(() => expectNullsLast('n', data(undefined, 1), v, key)).toThrow(/row 1 r1 has a value after the empty row 0 r0/);
});

test('expectMirror: ascending and descending list the same values in opposite order; ties may reorder their rows', () => {
    const val = (r: Row) => (r.v === undefined ? undefined : String(r.v));
    const asc: Row[] = [{ uuid: 'a', v: 1 }, { uuid: 'b', v: 2 }, { uuid: 'c', v: 2 }, { uuid: 'd', v: 3 }, { uuid: 'e' }];
    const desc: Row[] = [{ uuid: 'd', v: 3 }, { uuid: 'b', v: 2 }, { uuid: 'c', v: 2 }, { uuid: 'a', v: 1 }, { uuid: 'e' }];
    expect(() => expectMirror('m', asc, desc, val)).not.toThrow();
    expect(() => expectMirror('m', asc, asc, val)).toThrow(/m: ascending value 0 is "1", the mirrored descending one "3"/);
    expect(() => expectMirror('m', asc, desc.slice(0, 3), val)).toThrow(/m: 4 values ascending, 3 descending/);
});

test('textOrdered: code-unit order for [a-z0-9] strings, either code-unit or en collator order for any other pair', () => {
    expect(textOrdered('alpha', 'beta', 'asc')).toBe(true);
    expect(textOrdered('beta', 'alpha', 'asc')).toBe(false);
    expect(textOrdered('beta', 'alpha', 'desc')).toBe(true);
    expect(textOrdered('same', 'same', 'asc')).toBe(true);
    expect(textOrdered('key2', 'key10', 'asc'), 'simple strings: code units, "key10" < "key2"').toBe(false);
    // a collation that sorts "a-c" and "ab" either way is not flagged
    expect(textOrdered('a-c', 'ab', 'asc')).toBe(true);
    expect(textOrdered('Zed', 'alpha', 'asc'), 'code units put "Z" first').toBe(true);
    expect(textOrdered('alpha', 'Zed', 'asc'), 'an en collator puts "alpha" first').toBe(true);
    // a clearly wrong pair is flagged in the mixed case too
    expect(textOrdered('Mango-2', 'Apple-1', 'asc')).toBe(false);
    expect(textOrdered('Apple-1', 'Mango-2', 'desc')).toBe(false);
});

test('expectOrderedText skips rows without a value and names the two neighbours', () => {
    const val = (r: Row) => (r.v === undefined ? undefined : String(r.v));
    const data = (...vals: Array<string | undefined>): Row[] => vals.map((x, i) => ({ uuid: `r${i}`, v: x }));
    expect(() => expectOrderedText('t asc', data('a', 'b', 'c', undefined), val, 'asc', key)).not.toThrow();
    expect(() => expectOrderedText('t desc', data('c', 'b', 'a', undefined), val, 'desc', key)).not.toThrow();
    expect(() => expectOrderedText('t asc', data('a', undefined, 'c', 'b'), val, 'asc', key)).toThrow(/t asc: r2="c" comes before r3="b"/);
});

test('expectTieBreakAscending counts equal-value neighbours and names rows ordered by descending key', () => {
    const val = (r: Row) => (r.v === undefined ? undefined : String(r.v));
    const ok: Row[] = [{ uuid: '1', v: 'x' }, { uuid: '2', v: 'x' }, { uuid: '3', v: 'y' }, { uuid: '4' }];
    expect(expectTieBreakAscending('tb', ok, val, key)).toBe(1);
    expect(expectTieBreakAscending('tb', [{ uuid: '1', v: 'x' }, { uuid: '2', v: 'y' }], val, key), 'no ties, nothing proven').toBe(0);
    const bad: Row[] = [{ uuid: '2', v: 'x' }, { uuid: '1', v: 'x' }];
    expect(() => expectTieBreakAscending('tb', bad, val, key)).toThrow(/tb: rows with the equal value "x" are ordered 2 then 1, not by ascending key/);
});

test('expectRowsSatisfy lists the offending rows with the value they carry', () => {
    const f = { get: (r: Row) => toValues(r.n) };
    const data: Row[] = [{ uuid: 'a', n: 1 }, { uuid: 'b', n: 5 }, { uuid: 'c' }];
    expect(() => expectRowsSatisfy('n GREATER', [data[1]], f, 'GREATER', 1, key)).not.toThrow();
    expect(() => expectRowsSatisfy('n GREATER', data, f, 'GREATER', 1, key)).toThrow(/n GREATER: 2 of 3 returned row\(s\) do not satisfy GREATER 1: a=\[1\]; c=\[\]/);
});

test('expectInstantOrder and expectInstantsWithin: the halves of a partition are ordered; a window holds its rows', () => {
    const at = (iso: string): Row => ({ uuid: iso, t: iso });
    const ms = (r: Row) => instantMs(r.t);
    expect(() => expectInstantOrder('d', [at('2026-10-01T00:00:00Z'), at('2026-10-02T00:00:00Z')], [at('2026-10-02T00:00:00Z'), at('2026-10-03T00:00:00Z')], ms)).not.toThrow();
    expect(() => expectInstantOrder('d', [at('2026-10-04T00:00:00Z')], [at('2026-10-03T00:00:00Z')], ms)).toThrow(/d: the lower half reaches 2026-10-04T00:00:00.000Z, the upper half starts at 2026-10-03T00:00:00.000Z/);
    expect(() => expectInstantOrder('d', [], [at('2026-10-03T00:00:00Z')], ms), 'an empty half proves nothing').not.toThrow();
    const now = Date.parse('2026-10-14T12:00:00Z');
    expect(() => expectInstantsWithin('w', [at('2026-10-14T11:59:00Z')], ms, now - 900_000, now, 120_000)).not.toThrow();
    expect(() => expectInstantsWithin('w', [at('2026-10-14T11:00:00Z')], ms, now - 900_000, now, 120_000)).toThrow(/w: 1 row\(s\) outside/);
    expect(() => expectInstantsWithin('w', [at('2026-10-14T12:30:00Z')], ms, now - 900_000, now, 120_000)).toThrow(/outside/);
    expect(() => expectInstantsWithin('w', [{ uuid: 'x' }], ms, now - 900_000, now, 120_000)).toThrow(/no value/);
});

test('withReread: a transient disagreement is absorbed and noted once; a second one fails with both texts; other errors are not retried', async () => {
    const log = new RunLog();
    let calls = 0;
    const v = await withReread('field F', log, async () => {
        calls += 1;
        if (calls === 1) throw new InvariantViolation('F: EMPTY 3 + NOT_EMPTY 8 = 11, expected 10');
        return 'ok';
    });
    expect(v).toBe('ok');
    expect(calls).toBe(2);
    expect(log.notes).toEqual([expect.stringMatching(/field F: the first read disagreed \(F: EMPTY 3 \+ NOT_EMPTY 8 = 11, expected 10\); read again once/)]);

    calls = 0;
    await expect(withReread('field F', new RunLog(), async () => {
        calls += 1;
        throw new InvariantViolation(`mismatch ${calls}`);
    })).rejects.toThrow(/field F, second read: mismatch 2 \| first read: mismatch 1/);
    expect(calls).toBe(2);

    calls = 0;
    await expect(withReread('x', new RunLog(), async () => {
        calls += 1;
        throw new Error('network down');
    })).rejects.toThrow(/network down/);
    expect(calls, 'only an InvariantViolation is re-read').toBe(1);
});

// ------------------------------------------------------------------ the audit log gate and the activity helpers

test('auditGate mirrors AuditLogAspect / LoggingHelper: database output and a logged module and resource', () => {
    const settings = (over: Record<string, unknown> = {}) => ({
        auditLogs: { output: 'ALL', verbose: false, logAllModules: false, logAllResources: false, loggedModules: ['core'], ignoredModules: [], loggedResources: ['dashboard', 'groups'], ignoredResources: [], ...over },
        eventLogs: {},
    });
    expect(auditGate(settings(), 'core', 'dashboard')).toEqual({ enabled: true });
    expect(auditGate(settings({ output: 'DATABASE' }), 'core', 'groups').enabled).toBe(true);
    expect(auditGate(settings({ output: 'NONE' }), 'core', 'groups')).toMatchObject({ enabled: false, why: expect.stringMatching(/output is NONE/) });
    expect(auditGate(settings({ output: 'CONSOLE' }), 'core', 'groups').enabled, 'console output writes no database row').toBe(false);
    expect(auditGate(settings(), 'certificates', 'groups')).toMatchObject({ enabled: false, why: 'module certificates is not logged (settings)' });
    expect(auditGate(settings(), 'core', 'certificates')).toMatchObject({ enabled: false, why: 'resource certificates is not logged (settings)' });
    expect(auditGate(settings({ logAllModules: true, logAllResources: true }), 'certificates', 'certificates').enabled).toBe(true);
    expect(auditGate(settings({ logAllModules: true, ignoredModules: ['core'] }), 'core', 'groups').enabled, 'an ignored module wins').toBe(false);
    expect(auditGate(settings({ logAllResources: true, ignoredResources: ['groups'] }), 'core', 'groups').enabled).toBe(false);
    expect(auditGate(undefined, 'core', 'groups')).toMatchObject({ enabled: true, why: expect.stringMatching(/not decidable/) });
    expect(auditGate({}, 'core', 'groups').enabled).toBe(true);
});

test('activityFilters and activityMatches: resource, operation, module, own object and the server-clock lower bound', () => {
    expect(activityFilters({ resource: 'dashboard', operation: 'statistics' })).toEqual([
        { fieldSource: 'property', fieldIdentifier: 'AUDIT_LOG_RESOURCE', condition: 'EQUALS', value: 'dashboard' },
        { fieldSource: 'property', fieldIdentifier: 'AUDIT_LOG_OPERATION', condition: 'EQUALS', value: 'statistics' },
        { fieldSource: 'property', fieldIdentifier: 'AUDIT_LOG_TIMESTAMP', condition: 'IN_PAST', value: 'PT15M' },
    ]);
    const q = { resource: 'groups', operation: 'create', module: 'core', objectUuid: '11111111-1111-4111-8111-111111111111' };
    expect(activityFilters(q).map((f) => f.fieldIdentifier)).toEqual(['AUDIT_LOG_RESOURCE', 'AUDIT_LOG_OPERATION', 'AUDIT_LOG_MODULE', 'AUDIT_LOG_RESOURCE_UUID', 'AUDIT_LOG_TIMESTAMP']);
    const t0 = new Date('2026-10-14T12:00:00Z');
    const entry = (over: Row = {}): Row => ({
        id: 1, timestamp: '2026-10-14T12:00:03.250+00:00', module: 'core', operation: 'create', operationResult: 'success',
        resource: { type: 'groups', objects: [{ name: 'g', uuid: q.objectUuid }] }, ...over,
    });
    expect(activityMatches([entry()], q, t0)).toHaveLength(1);
    expect(activityMatches([entry({ timestamp: '2026-10-14T11:59:59Z' })], q, t0), 'older than t0').toEqual([]);
    expect(activityMatches([entry({ operation: 'update' })], q, t0)).toEqual([]);
    expect(activityMatches([entry({ module: 'auth' })], q, t0)).toEqual([]);
    expect(activityMatches([entry({ resource: { type: 'roles', objects: [] } })], q, t0)).toEqual([]);
    expect(activityMatches([entry({ resource: { type: 'groups', objects: [{ name: 'other', uuid: '22222222-2222-4222-8222-222222222222' }] } })], q, t0), 'another object').toEqual([]);
    expect(activityMatches([entry()], { resource: 'groups', operation: 'create' }, t0), 'no module / object constraint').toHaveLength(1);
});
