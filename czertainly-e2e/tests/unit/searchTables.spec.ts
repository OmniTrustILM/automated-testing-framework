/**
 * Unit tests of utils/regression/inventory/searchTables.ts: every expected row set equals the seed predicate
 * (double entry), row ids are unique, and the sort comparators order empty values last. No environment.
 */
import { expect, test } from '@playwright/test';
import { planSeedA } from '../../utils/regression/inventory/seedFull';
import { ALL_ROW_TABLES, ATTRIBUTE_EDGES, COLLECTION_ROWS, DATE_ROWS, expectedOrderGroups, LIST_ROWS, notAfterOf, orderProblem, sortKey, TEXT_ROWS } from '../../utils/regression/inventory/searchTables';

const CLOCK = new Date('2026-10-14T10:00:00.000Z');
const planName = (suffix: string) => `qa-reg-20261014-100000-abcd-${suffix}`;

const certById0 = (m: ReturnType<typeof planSeedA>, id: string) => m.certificates.find((c) => c.id === id)!;

function tableRows(): Array<{ table: string; row: (typeof TEXT_ROWS)[number] }> {
    return Object.entries(ALL_ROW_TABLES).flatMap(([table, rows]) => rows.map((row) => ({ table, row })));
}

test('double entry: the expected set of every row equals the seed predicate (a mistake in the table or the predicate shows here)', () => {
    const m = planSeedA(CLOCK, planName, 'x1');
    const problems: string[] = [];
    for (const { table, row } of tableRows()) {
        const got = row.expect(m);
        const ok = typeof row.plan === 'number' ? got.length === row.plan : [...got].sort().join(',') === [...row.plan].sort().join(',');
        if (!ok) problems.push(`${table} ${row.row} (${row.title}): predicate gives {${got.join(', ')}} (${got.length}), plan says ${typeof row.plan === 'number' ? row.plan : `{${row.plan.join(', ')}}`}`);
    }
    expect(problems).toEqual([]);
    expect(tableRows().length).toBeGreaterThan(100);
});

test('row ids are unique, filters build, and the bug / pin markers are where the plan puts them', () => {
    const m = planSeedA(CLOCK, planName, 'x1');
    const rows = tableRows().map((r) => r.row);
    expect(new Set(rows.map((r) => r.row)).size).toBe(rows.length);
    for (const r of rows) {
        const filters = r.filters(m, { signatureSha384: 'x', signatureSha512: 'y', rsa: 'RSA' });
        expect(filters.length, r.row).toBeGreaterThan(0);
        for (const f of filters) expect(['property', 'custom']).toContain(f.fieldSource);
    }
    expect(TEXT_ROWS.filter((r) => r.bug).map((r) => r.bug)).toEqual(['core#2505', 'core#2505']);
    expect(TEXT_ROWS.filter((r) => r.pin).map((r) => r.row)).toEqual(['T-11', 'T-12']);
    expect(DATE_ROWS.filter((r) => r.pin).map((r) => r.row)).toEqual(['D-2']);
    expect(LIST_ROWS.length + COLLECTION_ROWS.length).toBeGreaterThan(30);
    expect(ATTRIBUTE_EDGES.withoutSuffixText(m).test(`Filter field identifier ${m.attributes.txt.name} does not name an attribute.`)).toBe(true);
    expect(notAfterOf(m, 'C03')).toMatch(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.000Z$/);
});

test('sort comparators: nulls last in both directions, min asc / max desc for multi-valued fields, ties as groups', () => {
    const m = planSeedA(CLOCK, planName, 'x1');
    const flat = (g: string[][]) => g.map((x) => x.join('+'));
    // num: -5, 0, 10, 20 … 100, 1000 then the 14 without a value.
    const asc = expectedOrderGroups(m, 'num', 'asc');
    expect(asc.slice(0, 10).map((g) => g[0])).toEqual(['C07', 'C08', 'C01', 'C02', 'C03', 'C04', 'C05', 'C06', 'C09', 'C10']);
    expect(asc[10]).toHaveLength(14);
    const desc = expectedOrderGroups(m, 'num', 'desc');
    expect(desc.slice(0, 3).map((g) => g[0])).toEqual(['C10', 'C09', 'C06']);
    expect(desc[10], 'nulls last in descending order too').toHaveLength(14);
    // NOT_AFTER: C21 and C22 form one group; everything else is its own group.
    const na = expectedOrderGroups(m, 'NOT_AFTER', 'asc');
    expect(flat(na)).toContain('C21+C22');
    expect(na).toHaveLength(23);
    // GROUP_NAME: asc by the smallest name (a-members, then b-only), desc by the largest (b-members first), 16 nulls last.
    const ga = expectedOrderGroups(m, 'GROUP_NAME', 'asc');
    expect(ga.map((g) => g.length)).toEqual([6, 2, 16]);
    const gd = expectedOrderGroups(m, 'GROUP_NAME', 'desc');
    expect(gd.map((g) => g.length)).toEqual([4, 4, 16]);
    expect([...gd[0]].sort()).toEqual(['C03', 'C04', 'C07', 'C08']);
    // OWNER: the two owned seeds tie on the owner's name, 22 without.
    expect(expectedOrderGroups(m, 'OWNER', 'asc').map((g) => g.length)).toEqual([2, 22]);
    // pick: min asc / max desc.
    expect(sortKey(m, certById0(m, 'C02'), 'pick', 'asc')).toBe('a');
    expect(sortKey(m, certById0(m, 'C02'), 'pick', 'desc')).toBe('b');
    expect(orderProblem(['C07', 'C08', 'C01'], [['C07'], ['C08'], ['C01']])).toBeUndefined();
    expect(orderProblem(['C07', 'C01', 'C08'], [['C07'], ['C08'], ['C01']])).toMatch(/group 2/);
    expect(orderProblem(['C21', 'C22', 'C05'], [['C22', 'C21'], ['C05']]), 'a tie group matches as a set').toBeUndefined();
    expect(orderProblem(['C07', 'C08', 'C01', 'C99'], [['C07'], ['C08'], ['C01']])).toMatch(/extra/);
});
