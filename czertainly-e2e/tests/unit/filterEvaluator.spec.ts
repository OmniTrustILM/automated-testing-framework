/**
 * filterEvaluator — unit tests of the one filter evaluator and of the decisions its callers take from it.
 *
 * Checks `satisfiesFilter` refuses a one-value condition given several values and a non-numeric value for an ordering, and
 * orders numerically ("999" before "1000"). The callers (`expectedRows`, `expectRowsSatisfy`, `matchesCondition`,
 * `findAndPairs`) decide what they decided before, and the certificate list stand-in models only its old conditions. Four
 * modules share this function; a change must not move their answers unnoticed.
 */
import { expect, test } from '@playwright/test';
import { expectedRows, satisfiesFilter, toValues, type FieldMap } from '../../utils/regression/inventory/oracles/values';
import { expectRowsSatisfy } from '../../utils/regression/inventory/oracles/listExpectations';
import { findAndPairs } from '../../utils/regression/inventory/oracles/fieldOracles';
import { matchesCondition, type ListRow } from '../../utils/regression/inventory/listInvariants';
import { fakeData, listAnswer } from './helpers/fakeCertificateListApp';

const key = (r: ListRow): string => String(r.uuid);

test('satisfiesFilter: a condition that takes one value refuses a list of values', () => {
    for (const condition of ['CONTAINS', 'NOT_CONTAINS', 'STARTS_WITH', 'ENDS_WITH', 'MATCHES', 'NOT_MATCHES']) {
        expect(() => satisfiesFilter(['abc'], condition, ['a', 'b']), condition).toThrow(/does not model .* with 2 wanted values/);
        expect(() => satisfiesFilter(['abc'], condition, ['a']), `${condition} with a list of one`).not.toThrow();
    }
    for (const condition of ['GREATER', 'GREATER_OR_EQUAL', 'LESSER', 'LESSER_OR_EQUAL', 'COUNT_EQUAL', 'COUNT_NOT_EQUAL', 'COUNT_GREATER_THAN', 'COUNT_LESS_THAN']) {
        expect(() => satisfiesFilter([1], condition, [1, 2]), condition).toThrow(/does not model .* with 2 wanted values/);
    }
    expect(satisfiesFilter(['a'], 'EQUALS', ['a', 'b'])).toBe(true);
    expect(satisfiesFilter(['c'], 'NOT_EQUALS', ['a', 'b'])).toBe(true);
});

test('satisfiesFilter: an ordering or a count with a value that is no number is refused, not answered false', () => {
    expect(() => satisfiesFilter([1], 'GREATER', 'abc')).toThrow(/does not model GREATER with the non-numeric value "abc"/);
    expect(() => satisfiesFilter([1], 'COUNT_EQUAL', 'abc')).toThrow(/non-numeric/);
    expect(() => satisfiesFilter([1], 'LESSER')).toThrow(/non-numeric/);
    expect(satisfiesFilter(['abc'], 'GREATER', 1), 'a row value that is no number never satisfies an ordering').toBe(false);
});

test('satisfiesFilter: ordering reads numeric-looking strings as numbers, "999" is below "1000"', () => {
    expect(satisfiesFilter(['999'], 'GREATER', '1000')).toBe(false);
    expect(satisfiesFilter(['1000'], 'GREATER', '999')).toBe(true);
    expect(satisfiesFilter(['999'], 'LESSER', '1000')).toBe(true);
    expect(satisfiesFilter(['1000'], 'LESSER_OR_EQUAL', '999')).toBe(false);
    expect(satisfiesFilter([999], 'LESSER', 1000)).toBe(true);
    expect(satisfiesFilter(['1000'], 'GREATER_OR_EQUAL', '1000')).toBe(true);
});

const f = (get: (r: ListRow) => ReturnType<typeof toValues>): Pick<FieldMap, 'get'> => ({ get });
const data: ListRow[] = [
    { uuid: 'a', t: 'Alpha-1', n: 1, g: ['x', 'y'] },
    { uuid: 'b', t: 'beta-2', n: 1000, g: ['y'] },
    { uuid: 'c', n: 999, g: [] },
];
const text = f((r) => toValues(r.t));
const num = f((r) => toValues(r.n));
const list = f((r) => toValues(r.g));

test('expectedRows: the exact conditions decide the row set, the weak ones decide nothing', () => {
    const ids = (field: Pick<FieldMap, 'get'>, condition: string, value?: unknown): string[] | undefined => expectedRows(data, field, condition, value)?.map(key);
    expect(ids(text, 'EQUALS', 'beta-2')).toEqual(['b']);
    expect(ids(text, 'EQUALS', ['Alpha-1', 'beta-2'])).toEqual(['a', 'b']);
    expect(ids(text, 'NOT_EQUALS', 'beta-2')).toEqual(['a', 'c']);
    expect(ids(text, 'EMPTY')).toEqual(['c']);
    expect(ids(text, 'NOT_EMPTY')).toEqual(['a', 'b']);
    expect(ids(num, 'GREATER', 999)).toEqual(['b']);
    expect(ids(num, 'GREATER_OR_EQUAL', 999)).toEqual(['b', 'c']);
    expect(ids(num, 'LESSER', 1000)).toEqual(['a', 'c']);
    expect(ids(num, 'LESSER_OR_EQUAL', 999)).toEqual(['a', 'c']);
    expect(ids(list, 'COUNT_EQUAL', 1)).toEqual(['b']);
    expect(ids(list, 'COUNT_NOT_EQUAL', 1)).toEqual(['a', 'c']);
    expect(ids(list, 'COUNT_GREATER_THAN', 0)).toEqual(['a', 'b']);
    expect(ids(list, 'COUNT_LESS_THAN', 2)).toEqual(['b', 'c']);
    for (const weak of ['CONTAINS', 'NOT_CONTAINS', 'STARTS_WITH', 'ENDS_WITH', 'MATCHES', 'NOT_MATCHES']) expect(ids(text, weak, 'a'), weak).toBeUndefined();
});

test('expectRowsSatisfy: the same predicate; the weak string forms are case-insensitive, NOT_CONTAINS is case-sensitive', () => {
    const passes = (rows: ListRow[], field: Pick<FieldMap, 'get'>, condition: string, value?: unknown): boolean => {
        try {
            expectRowsSatisfy('x', rows, field, condition, value, key);
            return true;
        } catch {
            return false;
        }
    };
    expect(passes([data[0]], text, 'CONTAINS', 'ALPHA')).toBe(true);
    expect(passes([data[0]], text, 'STARTS_WITH', 'alp')).toBe(true);
    expect(passes([data[1]], text, 'ENDS_WITH', '-2')).toBe(true);
    expect(passes([data[0]], text, 'NOT_CONTAINS', 'alpha'), 'case-sensitive complement').toBe(true);
    expect(passes([data[0]], text, 'NOT_CONTAINS', 'Alpha')).toBe(false);
    expect(passes([data[2]], text, 'NOT_CONTAINS', 'x'), 'a row without a value is in the complement').toBe(true);
    expect(passes([data[2]], text, 'CONTAINS', 'x')).toBe(false);
    expect(passes([data[0]], text, 'MATCHES', '^alpha')).toBe(true);
    expect(passes([data[0]], text, 'NOT_MATCHES', '^alpha')).toBe(true);
    expect(passes([data[2]], text, 'NOT_MATCHES', '^a'), 'NOT_MATCHES excludes a row without a value').toBe(false);
    expect(passes([data[1]], num, 'GREATER', 999)).toBe(true);
    expect(passes([data[2]], num, 'GREATER', 1000), '999 is not above 1000').toBe(false);
    expect(passes([data[0], data[1]], list, 'COUNT_LESS_THAN', 2)).toBe(false);
});

test('matchesCondition: every condition it offers, with and without ignoreCase, on arrays and dates', () => {
    const r: ListRow = { uuid: 'x', commonName: 'Qa-Reg-X', groups: [{ name: 'g1' }, { name: 'g2' }], notAfter: '2027-01-01T00:00:00Z', owner: null, keySize: '999' };
    const is = (field: string, condition: Parameters<typeof matchesCondition>[1]['condition'], value?: unknown, ignoreCase?: boolean): boolean => matchesCondition(r, { field, condition, value, ignoreCase });
    expect(is('commonName', 'EQUALS', 'Qa-Reg-X')).toBe(true);
    expect(is('commonName', 'EQUALS', 'qa-reg-x')).toBe(false);
    expect(is('commonName', 'EQUALS', 'qa-reg-x', true)).toBe(true);
    expect(is('commonName', 'NOT_EQUALS', 'qa-reg-x')).toBe(true);
    expect(is('commonName', 'NOT_EQUALS', 'qa-reg-x', true)).toBe(false);
    expect(is('commonName', 'CONTAINS', 'reg')).toBe(false);
    expect(is('commonName', 'CONTAINS', 'reg', true)).toBe(true);
    expect(is('commonName', 'NOT_CONTAINS', 'Reg')).toBe(false);
    expect(is('commonName', 'NOT_CONTAINS', 'zzz')).toBe(true);
    expect(is('commonName', 'STARTS_WITH', 'Qa-')).toBe(true);
    expect(is('commonName', 'STARTS_WITH', 'qa-')).toBe(false);
    expect(is('commonName', 'ENDS_WITH', '-x', true)).toBe(true);
    expect(is('groups.name', 'EQUALS', ['g9', 'g2'])).toBe(true);
    expect(is('groups.name', 'NOT_EQUALS', 'g2')).toBe(false);
    expect(is('owner', 'EMPTY')).toBe(true);
    expect(is('groups', 'NOT_EMPTY')).toBe(true);
    expect(is('notAfter', 'GREATER', '2026-12-31T23:59:59Z')).toBe(true);
    expect(is('notAfter', 'LESSER', '2026-12-31T23:59:59Z')).toBe(false);
    expect(is('notAfter', 'GREATER_OR_EQUAL', '2027-01-01T00:00:00Z')).toBe(true);
    expect(is('notAfter', 'LESSER_OR_EQUAL', '2027-01-01T00:00:00Z')).toBe(true);
    expect(is('keySize', 'GREATER', '1000'), 'numeric-looking strings order as numbers').toBe(false);
    expect(is('keySize', 'LESSER', '1000')).toBe(true);
    expect(() => is('commonName', 'CONTAINS', ['a', 'b'])).toThrow(/does not model/);
});

test('findAndPairs: the pair it picks does not change', () => {
    const rows: ListRow[] = [
        { uuid: '1', a: 'a1', b: 'b1' }, { uuid: '2', a: 'a1', b: 'b1' }, { uuid: '3', a: 'a1', b: 'b2' },
        { uuid: '4', a: 'a2', b: 'b1' }, { uuid: '5', a: 'a2', b: 'b2' }, { uuid: '6', a: 'a3', b: 'b2' },
    ];
    const field = (id: string, member: string): FieldMap => ({ id, type: 'string', kind: 'string', shape: 'code', get: (r: ListRow) => toValues(r[member]), sortable: false, sort: 'none', evidence: 'test' });
    const pairs = findAndPairs([field('A', 'a'), field('B', 'b')], rows, new Set(['A', 'B']), 3);
    expect(pairs.length).toBeGreaterThan(0);
    expect(pairs[0].describe).toBe('A = "a1" AND B = "b1"');
});

test('the certificate list stand-in models the conditions it always modelled and refuses the others', () => {
    const answer = (fieldIdentifier: string, condition: string, value?: unknown) => listAnswer(fakeData(), { filters: [{ fieldIdentifier, condition, value }] });
    for (const [fieldIdentifier, condition, value] of [
        ['COMMON_NAME', 'STARTS_WITH', 'qa-reg'], ['COMMON_NAME', 'NOT_MATCHES', '^zzz'], ['CERTIFICATE_STATE', 'EQUALS', 'issued'], ['KEY_SIZE', 'NOT_EQUALS', '2048'],
        ['GROUP_NAME', 'NOT_EMPTY', undefined], ['NOT_AFTER', 'GREATER_OR_EQUAL', '2026-01-01T00:00:00Z'], ['NOT_BEFORE', 'IN_PAST', 'P3650D'],
    ] as Array<[string, string, unknown]>) {
        expect(answer(fieldIdentifier, condition, value).status, `${fieldIdentifier} ${condition}`).toBe(200);
    }
    for (const [fieldIdentifier, condition, value] of [
        ['COMMON_NAME', 'GREATER', '1'], ['CERTIFICATE_STATE', 'CONTAINS', 'iss'], ['KEY_SIZE', 'GREATER', '1'], ['GROUP_NAME', 'CONTAINS', 'g'],
        ['NOT_AFTER', 'NOT_EQUALS', '2026-01-01T00:00:00Z'], ['SUBJECT_TYPE', 'EMPTY', undefined], ['OWNER', 'EQUALS', 'x'],
    ] as Array<[string, string, unknown]>) {
        const res = answer(fieldIdentifier, condition, value);
        expect(res.status, `${fieldIdentifier} ${condition}`).toBe(422);
        expect(JSON.stringify(res.json)).toContain(`does not model ${fieldIdentifier} ${condition}`);
    }
});
