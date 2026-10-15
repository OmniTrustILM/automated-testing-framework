/**
 * Unit tests for the filter, sort and paging oracles (utils/regression/invariants.ts) on hand-made rows: each oracle
 * passes on a correct result and names the field, the condition and the offending rows on a wrong one.
 */
import { test, expect } from '@playwright/test';
import {
    expectAndNarrows,
    expectEmptyPlusNotEmptyEqualsTotal,
    expectFilterProperty,
    expectPagingInvariants,
    expectSorted,
    InvariantViolation,
    Row,
    satisfies,
    walkPages,
} from '../../utils/regression/invariants';

const rows = (...ids: string[]): Row[] => ids.map((uuid) => ({ uuid }));

test('EMPTY + NOT_EMPTY add up to the total and do not overlap', () => {
    expect(() => expectEmptyPlusNotEmptyEqualsTotal({ total: 3, empty: rows('a'), notEmpty: rows('b', 'c') }, 'owner')).not.toThrow();
    expect(() => expectEmptyPlusNotEmptyEqualsTotal({ total: 4, empty: rows('a'), notEmpty: rows('b', 'c') }, 'owner')).toThrow(/owner: EMPTY \(1\) \+ NOT_EMPTY \(2\) = 3, unfiltered total 4/);
    expect(() => expectEmptyPlusNotEmptyEqualsTotal({ total: 3, empty: rows('a', 'b'), notEmpty: rows('b') }, 'owner')).toThrow(/overlap in 1 row\(s\) \[b\]/);
});

test('the reference evaluator covers each condition, arrays and dates', () => {
    const r: Row = { uuid: 'x', commonName: 'qa-reg-x-flt-1', groups: [{ name: 'g1' }, { name: 'g2' }], notAfter: '2027-01-01T00:00:00Z', owner: null, keySize: 2048 };
    expect(satisfies(r, { field: 'commonName', condition: 'STARTS_WITH', value: 'qa-reg-x' })).toBe(true);
    expect(satisfies(r, { field: 'commonName', condition: 'CONTAINS', value: 'FLT', ignoreCase: true })).toBe(true);
    expect(satisfies(r, { field: 'commonName', condition: 'CONTAINS', value: 'FLT' })).toBe(false);
    expect(satisfies(r, { field: 'groups.name', condition: 'EQUALS', value: 'g2' }), 'array field: any element').toBe(true);
    expect(satisfies(r, { field: 'groups.name', condition: 'NOT_EQUALS', value: 'g2' })).toBe(false);
    expect(satisfies(r, { field: 'owner', condition: 'EMPTY' })).toBe(true);
    expect(satisfies(r, { field: 'groups', condition: 'NOT_EMPTY' })).toBe(true);
    expect(satisfies(r, { field: 'notAfter', condition: 'GREATER', value: '2026-12-31T23:59:59Z' }), 'ISO dates compare as time').toBe(true);
    expect(satisfies(r, { field: 'keySize', condition: 'LESSER_OR_EQUAL', value: 2048 })).toBe(true);
    expect(satisfies(r, { field: 'commonName', condition: 'ENDS_WITH', value: '-1' })).toBe(true);
    expect(satisfies(r, { field: 'x', condition: 'EQUALS', value: 'y', get: () => 'y' }), 'custom getter').toBe(true);
});

test('a filtered result with a row that violates the filter is reported with the row', () => {
    const result: Row[] = [{ uuid: 'a', state: 'issued' }, { uuid: 'b', state: 'revoked' }];
    expect(() => expectFilterProperty(result.slice(0, 1), { field: 'state', condition: 'EQUALS', value: 'issued' })).not.toThrow();
    expect(() => expectFilterProperty(result, { field: 'state', condition: 'EQUALS', value: 'issued' })).toThrow(/state EQUALS "issued": 1 of 2 .* b="revoked"/);
});

test('A and B narrows, is a subset of both, and is order independent', () => {
    const a = rows('1', '2', '3');
    const b = rows('2', '3', '4');
    expect(() => expectAndNarrows(a, b, rows('2', '3'), rows('3', '2'))).not.toThrow();
    expect(() => expectAndNarrows(a, b, rows('2', '3', '4'))).toThrow(/not a subset of both: not in A \[4\]/);
    expect(() => expectAndNarrows(rows('1'), b, rows('1', '2'))).toThrow(/more than min/);
    expect(() => expectAndNarrows(a, b, rows('2', '3'), rows('2'))).toThrow(/filter order changes the set: only in A,B \[3\]/);
});

test('sorted ascending and descending with nulls last pass', () => {
    const asc: Row[] = [{ uuid: 'a', cn: 'alpha' }, { uuid: 'b', cn: 'beta' }, { uuid: 'c', cn: null }, { uuid: 'd' }];
    expect(() => expectSorted(asc, 'cn', 'asc')).not.toThrow();
    const desc: Row[] = [{ uuid: 'b', n: 10 }, { uuid: 'a', n: 9 }, { uuid: 'c', n: null }];
    expect(() => expectSorted(desc, 'n', 'desc')).not.toThrow();
    const dates: Row[] = [{ uuid: 'a', d: '2026-01-02T00:00:00Z' }, { uuid: 'b', d: '2026-01-10T00:00:00Z' }];
    expect(() => expectSorted(dates, 'd', 'asc')).not.toThrow();
});

test('a wrongly sorted result is caught with the two neighbouring rows', () => {
    const wrong: Row[] = [{ uuid: 'a', cn: 'beta' }, { uuid: 'b', cn: 'alpha' }];
    expect(() => expectSorted(wrong, 'cn', 'asc')).toThrow(/cn asc nulls last: row 0 a="beta" comes before row 1 b="alpha"/);
    expect(() => expectSorted([{ uuid: 'a', n: 1 }, { uuid: 'b', n: 2 }], 'n', 'desc')).toThrow(InvariantViolation);
});

test('a null first is caught when nulls must be last, and accepted when nulls come first', () => {
    const nullFirst: Row[] = [{ uuid: 'a', owner: null }, { uuid: 'b', owner: 'x' }];
    expect(() => expectSorted(nullFirst, 'owner', 'asc')).toThrow(/row 0 a=null comes before row 1 b="x"/);
    expect(() => expectSorted(nullFirst, 'owner', 'asc', { nullsLast: false })).not.toThrow();
});

test('equal values must follow the uuid tie-break when asked', () => {
    const tie: Row[] = [{ uuid: 'b', s: 'x' }, { uuid: 'a', s: 'x' }];
    expect(() => expectSorted(tie, 's', 'asc')).not.toThrow();
    expect(() => expectSorted(tie, 's', 'asc', { tieBreak: 'uuid' })).toThrow(/row 0 b="x" comes before row 1 a="x"/);
});

test('walkPages fetches every page and checks totals, sizes and overlap', async () => {
    const all = rows('1', '2', '3', '4', '5');
    const good = async (n: number, size: number) => ({ items: all.slice((n - 1) * size, n * size), totalItems: 5, totalPages: Math.ceil(5 / size) });
    const result = await walkPages(good, { pageSize: 2 });
    expect(result.items.map((r) => r.uuid)).toEqual(['1', '2', '3', '4', '5']);
    expect(result.pages).toHaveLength(3);

    const pages = [rows('1', '2'), rows('2', '3'), rows('5')];
    const overlapping = async (n: number) => ({ items: pages[n - 1], totalItems: 5 });
    await expect(walkPages(overlapping, { pageSize: 2 })).rejects.toThrow(/2 appears on page 1 and again on page 2/);
    const wrongCount = async () => ({ items: all.slice(0, 2), totalItems: 5, totalPages: 2 });
    await expect(walkPages(wrongCount, { pageSize: 2 })).rejects.toThrow(/totalPages 2, but ceil\(totalItems 5 \/ pageSize 2\) = 3/);
    let calls = 0;
    const drifting = async (n: number, size: number) => ({ items: all.slice((n - 1) * size, n * size), totalItems: 5 + calls++ });
    await expect(walkPages(drifting, { pageSize: 2 })).rejects.toThrow(/totalItems changed from 5 to 6 on page 2/);
});

test('pages add up to the unpaged result', () => {
    expect(() => expectPagingInvariants([rows('1', '2'), rows('3')], rows('3', '1', '2'))).not.toThrow();
    expect(() => expectPagingInvariants([rows('1', '2'), rows('2')], rows('1', '2', '3'))).toThrow(/missing \[3\].*1 duplicate/);
    expect(() => expectPagingInvariants([rows('1')], rows('1', '2'))).toThrow(/pages hold 1 rows, the unpaged result 2/);
});
