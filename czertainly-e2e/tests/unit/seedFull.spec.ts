/**
 * Unit tests of utils/regression/inventory/seedFull.ts without a server: the plan of the full certificate seed, its upload
 * and default order, and the manifest checks.
 */
import { expect, test } from '@playwright/test';
import { certById, dayValues, PICK_OPTIONS, planCertificateSeed, SEED_A_DEFAULT_ORDER, CERTIFICATE_SEED_ROWS, CERTIFICATE_SEED_UPLOAD_ORDER, certificateSeedProblems, SeedAManifest } from '../../utils/regression/inventory/seedFull';

const CLOCK = new Date('2026-10-14T10:00:00.000Z');
const planName = (suffix: string) => `qa-reg-20261014-100000-abcd-${suffix}`;

// ------------------------------------------------------------------ pure: the certificate seed definition and the tables

test('certificate seed plan: 24 certificates, the derived counts of the seed plan, upload order and default order', () => {
    const m = planCertificateSeed(CLOCK, planName, 'x1');
    expect(m.certificates).toHaveLength(24);
    expect(CERTIFICATE_SEED_ROWS.map((r) => r.id)).toEqual(Array.from({ length: 24 }, (_, i) => `C${String(i + 1).padStart(2, '0')}`));
    const count = (pred: (c: (typeof m.certificates)[number]) => boolean) => m.certificates.filter(pred).length;
    expect(count((c) => c.groups.includes('a'))).toBe(6);
    expect(count((c) => c.groups.includes('b'))).toBe(4);
    expect(count((c) => c.groups.length > 0)).toBe(8);
    expect(count((c) => c.groups.length === 0)).toBe(16);
    expect(count((c) => c.txt !== null)).toBe(7);
    expect(count((c) => c.num !== null)).toBe(10);
    expect(count((c) => c.day !== null) + count((c) => c.flag !== null) + count((c) => c.pick !== null)).toBe(15);
    expect(count((c) => c.owner)).toBe(2);
    expect(m.certificates.filter((c) => c.keyBits === 3072).map((c) => c.id)).toEqual(['C05', 'C06']);
    expect(m.certificates.filter((c) => c.keyBits === 4096).map((c) => c.id)).toEqual(['C08']);
    expect(count((c) => c.keyBits === 2048)).toBe(21);
    expect(count((c) => c.hash === 'SHA-384')).toBe(1);
    expect(count((c) => c.hash === 'SHA-512')).toBe(1);
    expect(count((c) => !c.ca && !c.issuedBy)).toBe(20);
    expect(CERTIFICATE_SEED_UPLOAD_ORDER[0]).toBe('C24');
    expect(CERTIFICATE_SEED_UPLOAD_ORDER.slice(1)).toEqual(CERTIFICATE_SEED_ROWS.slice(0, 23).map((r) => r.id));
    expect(SEED_A_DEFAULT_ORDER.slice(0, 2)).toEqual(['C23', 'C22']);
    expect(SEED_A_DEFAULT_ORDER.slice(-2)).toEqual(['C01', 'C24']);
    // notAfter: C21 and C22 tie to the second, all other pairs differ; notBefore: only C21 / C22 tie.
    const na = m.certificates.map((c) => c.notAfter);
    expect(na.filter((x, i) => na.indexOf(x) !== i)).toEqual([certById({ ...m, certificates: m.certificates.map((c) => ({ ...c, uuid: c.id, fingerprint: '', serialHex: '' })) } as SeedAManifest, 'C22').notAfter]);
    const nb = m.certificates.map((c) => c.notBefore);
    expect(nb.filter((x, i) => nb.indexOf(x) !== i)).toHaveLength(1);
    // The clock is read once: relative instants.
    expect(new Date(certById0(m, 'C07').notAfter).getTime()).toBe(CLOCK.getTime() - 24 * 3600 * 1000);
    expect(new Date(certById0(m, 'C20').notBefore).getTime()).toBe(CLOCK.getTime() + 10 * 24 * 3600 * 1000);
    expect(dayValues(CLOCK)).toEqual(['2030-01-10', '2030-02-20', '2030-03-30', '2030-03-30', '2031-01-01']);
    expect(PICK_OPTIONS).toEqual(['a', 'b', 'c']);
    // Attribute identifiers as the catalogue publishes them.
    expect(m.attributes.txt.identifier).toBe(`${m.prefix}txt|STRING`);
    expect(m.attributes.pick.identifier).toBe(`${m.prefix}pick|STRING`);
    expect(m.attributes.flag.identifier).toBe(`${m.prefix}flag|BOOLEAN`);
    expect(m.prefix.startsWith('qa-reg-')).toBe(true);
});

const certById0 = (m: ReturnType<typeof planCertificateSeed>, id: string) => m.certificates.find((c) => c.id === id)!;

test('certificateSeedProblems: a good manifest is clean; a foreign run id, 23 certificates, a duplicate uuid, a prefix mismatch and a wrong kind are each named', () => {
    const runId = 'qa-reg-20261014-100000-abcd';
    const plan = planCertificateSeed(CLOCK, planName, 'stamp1');
    const good = (): SeedAManifest => ({
        ...plan,
        kind: 'certificate-seed',
        runId,
        groupUuids: { a: 'ga', b: 'gb' } as SeedAManifest['groupUuids'],
        attributeUuids: {} as SeedAManifest['attributeUuids'],
        ownerUuid: 'owner',
        certificates: plan.certificates.map((c, i) => ({ ...c, uuid: `00000000-0000-4000-8000-${String(i).padStart(12, '0')}`, fingerprint: `fp${i}`, serialHex: `0${i}` })),
    } as SeedAManifest);
    expect(good().certificates).toHaveLength(24);
    expect(certificateSeedProblems(good(), runId), 'the good manifest').toEqual([]);

    // a manifest of another run (the state file survived a different run id)
    expect(certificateSeedProblems(good(), 'qa-reg-20261014-100000-zzzz')).toEqual(['the manifest belongs to another run', 'the prefix does not carry the run prefix']);
    const foreign = { ...good(), runId: 'qa-reg-20200101-000000-aaaa' };
    expect(certificateSeedProblems(foreign, runId)).toEqual(['the manifest belongs to another run']);

    // 23 certificates (one upload missing)
    const short = good();
    short.certificates = short.certificates.slice(0, 23);
    expect(certificateSeedProblems(short, runId)).toEqual(['23 certificates (24 expected)']);

    // a duplicate certificate uuid
    const dup = good();
    dup.certificates[5] = { ...dup.certificates[5], uuid: dup.certificates[4].uuid };
    expect(certificateSeedProblems(dup, runId)).toEqual(['duplicate certificate uuids']);

    // a prefix that does not carry the run prefix, and a certificate outside the manifest prefix
    const prefix = { ...good(), prefix: 'qa-reg-other-flt-stamp1-' };
    expect(certificateSeedProblems(prefix, runId)).toEqual(['the prefix does not carry the run prefix', 'a certificate outside the prefix']);
    const outside = good();
    outside.certificates[3] = { ...outside.certificates[3], commonName: 'someone-elses-certificate' };
    expect(certificateSeedProblems(outside, runId)).toEqual(['a certificate outside the prefix']);

    // a manifest of another kind
    expect(certificateSeedProblems({ ...good(), kind: 'archive-seed' } as unknown as SeedAManifest, runId)).toEqual(['kind archive-seed']);
});
