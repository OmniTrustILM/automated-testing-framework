/**
 * seedMinimal — pure checks of the minimal inventory seed (inventory/seedMinimal.ts).
 */
import { expect, test } from '@playwright/test';
import {
    manifestProblems,
    manifestValue,
    nullRows,
    planSeedSubset,
    SeedSubsetManifest,
    seedFilter,
} from '../../utils/regression/inventory/seedMinimal';

const RUN = 'qa-reg-20261014-080000-ab12';

const name = (s: string) => `${RUN}-${s}`;

const U = (n: number) => `00000000-0000-4000-8000-${String(n).padStart(12, '0')}`;

function manifest(over: Partial<SeedSubsetManifest> = {}): SeedSubsetManifest {
    const plan = planSeedSubset(name, 'k1');
    return { ...plan, runId: RUN, attributeUuid: U(1), certificates: plan.certificates.map((c, i) => ({ ...c, uuid: U(10 + i) })), ...over };
}

test('planSeedSubset: three certificates under one run-prefixed prefix; one without a rank, distinct ranks', () => {
    const p = planSeedSubset(name, 'k1');
    expect(p.prefix).toBe(`${RUN}-seed-k1-`);
    expect(p.certificates.map((c) => c.commonName)).toEqual([`${RUN}-seed-k1-a`, `${RUN}-seed-k1-b`, `${RUN}-seed-k1-c`]);
    expect(p.certificates.map((c) => [c.key, c.rank])).toEqual([['a', 2], ['b', null], ['c', 1]]);
    expect(p.attribute).toEqual({ name: `${RUN}-seed-k1-rank`, label: 'Seed rank k1', contentType: 'integer' });
    expect(planSeedSubset(name, 'k2').prefix).not.toBe(p.prefix);
    expect(seedFilter(p)).toEqual([{ fieldSource: 'property', fieldIdentifier: 'COMMON_NAME', condition: 'STARTS_WITH', value: `${RUN}-seed-k1-` }]);
});

test('the manifest names the null rows and the values the sort oracle compares', () => {
    const m = manifest();
    expect(manifestProblems(m, RUN)).toEqual([]);
    expect(nullRows(m)).toEqual([U(11)]);
    expect(manifestValue(m, U(10))).toBe(2);
    expect(manifestValue(m, U(11))).toBeNull();
    expect(manifestValue(m, U(99))).toBeUndefined();
});

test('manifestProblems refuses another run, a foreign prefix, duplicates and a subset without exactly one null rank', () => {
    expect(manifestProblems(manifest(), 'qa-reg-20261014-080000-zz99')).toContain('the manifest belongs to another run');
    expect(manifestProblems(manifest({ prefix: 'prod-' }), RUN)).toEqual(expect.arrayContaining(['the prefix does not carry the run prefix', 'a certificate outside the prefix']));
    const m = manifest();
    expect(manifestProblems({ ...m, certificates: m.certificates.map((c) => ({ ...c, uuid: U(10) })) }, RUN)).toContain('duplicate certificate uuids');
    expect(manifestProblems({ ...m, certificates: m.certificates.map((c) => ({ ...c, rank: c.rank ?? 7 })) }, RUN)).toContain('0 certificates without a rank (1 expected)');
    expect(manifestProblems({ ...m, certificates: m.certificates.map((c) => ({ ...c, rank: c.rank === null ? null : 5 })) }, RUN)).toContain('equal ranks (the value order would be a tie)');
    expect(manifestProblems({ ...m, certificates: m.certificates.slice(0, 2) }, RUN)).toContain('2 certificates (3 expected)');
});
