/**
 * Unit tests of utils/regression/inventory/seedFull.ts: the plan of the full certificate seed, the manifest
 * checks, and the seed builds through the guarded api on a loopback fake core (127.0.0.1 only).
 */
import { APIRequestContext, expect, request, test } from '@playwright/test';
import * as crypto from 'crypto';
import { describeCertificate } from '../../utils/regression/inventory/seedCertificates';
import { buildFreshSeedB, certById, dayValues, ensureCertificateSeed, idsOfUuids, PICK_OPTIONS, planSeedA, SEED_A_DEFAULT_ORDER, SEED_A_ROWS, SEED_A_UPLOAD_ORDER, seedAProblems, SeedAManifest, uuidsOfIds } from '../../utils/regression/inventory/seedFull';
import { notAfterOf } from '../../utils/regression/inventory/searchTables';
import { guardApi } from '../../utils/regression/guard/createGuard';
import { GuardedApi } from '../../utils/regression/guard/types';
import { OwnObjectViolation } from '../../utils/regression/ledger/ownership';
import { readLedger } from '../../utils/regression/ledger/ledger';
import { readRunState, runId } from '../../utils/regression/ledger/runState';
import { Answer, Arrived, loopbackServer, LoopbackServer } from './helpers/loopbackServer';

type Json = Record<string, any>;

const CLOCK = new Date('2026-10-14T10:00:00.000Z');
const planName = (suffix: string) => `qa-reg-20261014-100000-abcd-${suffix}`;

// ------------------------------------------------------------------ pure: the SEED-A definition and the tables

test('SEED-A plan: 24 certificates, the derived counts of the seed plan, upload order and default order', () => {
    const m = planSeedA(CLOCK, planName, 'x1');
    expect(m.certificates).toHaveLength(24);
    expect(SEED_A_ROWS.map((r) => r.id)).toEqual(Array.from({ length: 24 }, (_, i) => `C${String(i + 1).padStart(2, '0')}`));
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
    expect(SEED_A_UPLOAD_ORDER[0]).toBe('C24');
    expect(SEED_A_UPLOAD_ORDER.slice(1)).toEqual(SEED_A_ROWS.slice(0, 23).map((r) => r.id));
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

const certById0 = (m: ReturnType<typeof planSeedA>, id: string) => m.certificates.find((c) => c.id === id)!;

test('seedAProblems: a good manifest is clean; a foreign run id, 23 certificates, a duplicate uuid, a prefix mismatch and a wrong kind are each named', () => {
    const runId = 'qa-reg-20261014-100000-abcd';
    const plan = planSeedA(CLOCK, planName, 'stamp1');
    const good = (): SeedAManifest => ({
        ...plan,
        kind: 'seed-a',
        runId,
        groupUuids: { a: 'ga', b: 'gb' } as SeedAManifest['groupUuids'],
        attributeUuids: {} as SeedAManifest['attributeUuids'],
        ownerUuid: 'owner',
        certificates: plan.certificates.map((c, i) => ({ ...c, uuid: `00000000-0000-4000-8000-${String(i).padStart(12, '0')}`, fingerprint: `fp${i}`, serialHex: `0${i}` })),
    } as SeedAManifest);
    expect(good().certificates).toHaveLength(24);
    expect(seedAProblems(good(), runId), 'the good manifest').toEqual([]);

    // a manifest of another run (the state file survived a different run id)
    expect(seedAProblems(good(), 'qa-reg-20261014-100000-zzzz')).toEqual(['the manifest belongs to another run', 'the prefix does not carry the run prefix']);
    const foreign = { ...good(), runId: 'qa-reg-20200101-000000-aaaa' };
    expect(seedAProblems(foreign, runId)).toEqual(['the manifest belongs to another run']);

    // 23 certificates (one upload missing)
    const short = good();
    short.certificates = short.certificates.slice(0, 23);
    expect(seedAProblems(short, runId)).toEqual(['23 certificates (24 expected)']);

    // a duplicate certificate uuid
    const dup = good();
    dup.certificates[5] = { ...dup.certificates[5], uuid: dup.certificates[4].uuid };
    expect(seedAProblems(dup, runId)).toEqual(['duplicate certificate uuids']);

    // a prefix that does not carry the run prefix, and a certificate outside the manifest prefix
    const prefix = { ...good(), prefix: 'qa-reg-other-flt-stamp1-' };
    expect(seedAProblems(prefix, runId)).toEqual(['the prefix does not carry the run prefix', 'a certificate outside the prefix']);
    const outside = good();
    outside.certificates[3] = { ...outside.certificates[3], commonName: 'someone-elses-certificate' };
    expect(seedAProblems(outside, runId)).toEqual(['a certificate outside the prefix']);

    // a manifest of another kind
    expect(seedAProblems({ ...good(), kind: 'seed-b' } as unknown as SeedAManifest, runId)).toEqual(['kind seed-b']);
});

// ------------------------------------------------------------------ wire: ensureSeedA / B / C through the guard

const U = (n: number) => `bbbbbbbb-0000-4000-8000-${String(n).padStart(12, '0')}`;

/** A stateful fake core for the seed builds: what the run creates is stored and answered. */
class FakeCore {
    private seq = 5000;
    readonly store = new Map<string, Json>();
    readonly uploads: Json[] = [];
    readonly patches: Array<{ uuid: string; body: Json }> = [];
    requiredGroupAttr = false;

    private next(): string {
        this.seq += 1;
        return U(this.seq);
    }

    answer = (a: Arrived): Answer | undefined => {
        const path = a.url.split('?')[0];
        const body = a.body ? (JSON.parse(a.body) as Json) : undefined;
        if (a.method === 'GET') return this.get(path);
        if (a.method === 'POST') return this.post(path, body);
        if (a.method === 'PATCH') return this.patch(path, body);
        return { status: 204 };
    };

    private get(path: string): Answer {
        if (/^\/api\/v1\/attributes\/custom\/resources\/(certificates|users|groups)$/.test(path)) {
            return { status: 200, body: path.endsWith('/groups') && this.requiredGroupAttr ? [{ uuid: U(1), name: 'site', contentType: 'string', properties: { required: true } }] : [] };
        }
        const stored = this.store.get(path);
        return stored ? { status: 200, body: stored } : { status: 404, body: { message: 'not found' } };
    }

    private post(path: string, body: Json | undefined): Answer {
        const uuid = this.next();
        if (path === '/api/v1/attributes/custom') {
            this.store.set(`/api/v1/attributes/custom/${uuid}`, { uuid, name: body?.name });
            return { status: 200, body: { uuid, name: body?.name } };
        }
        if (path === '/api/v1/users') {
            this.store.set(`/api/v1/users/${uuid}`, { uuid, username: body?.username });
            return { status: 200, body: { uuid } };
        }
        if (path === '/api/v1/groups') {
            this.store.set(`/api/v1/groups/${uuid}`, { uuid, name: body?.name, customAttributes: body?.customAttributes });
            return { status: 200, body: { uuid } };
        }
        if (path === '/api/v1/certificates/upload') {
            const pem = Buffer.from(String(body?.certificate), 'base64').toString('utf8');
            const d = describeCertificate(pem);
            const der = Buffer.from(pem.replace(/-----[^-]+-----/g, '').replace(/\s+/g, ''), 'base64');
            this.uploads.push({ uuid, subject: d.subject, customAttributes: body?.customAttributes });
            this.store.set(`/api/v1/certificates/${uuid}`, {
                uuid,
                commonName: d.subject.replace(/^CN=/, ''),
                fingerprint: crypto.createHash('sha256').update(der).digest('hex'),
                notBefore: d.notBefore.toISOString(),
                notAfter: d.notAfter.toISOString(),
                key: { uuid: this.next() },
            });
            return { status: 200, body: { uuid } };
        }
        return { status: 404, body: { message: `no fake route POST ${path}` } };
    }

    private patch(path: string, body: Json | undefined): Answer {
        const m = /^\/api\/v1\/certificates\/([0-9a-f-]{36})$/.exec(path);
        if (m) this.patches.push({ uuid: m[1], body: body ?? {} });
        return { status: 204 };
    }
}

let server: LoopbackServer;
let core: FakeCore;
let raw: APIRequestContext;
let api: GuardedApi;

const ENV_KEYS = ['REG_STATE_DIR', 'BASE_URL', 'TIER_KIND', 'REG_RUN_ID', 'REG_RA_PROFILE_NAME', 'API_TEARDOWN_DRY_RUN'];
let saved: Record<string, string | undefined> = {};

test.describe('SEED-A / B / C build on the loopback fake core (every request goes through the guard)', () => {
    test.beforeAll(async () => {
        server = await loopbackServer((a) => core.answer(a));
    });
    test.afterAll(async () => {
        await server.close();
    });
    test.beforeEach(async ({}, testInfo) => {
        saved = Object.fromEntries(ENV_KEYS.map((k) => [k, process.env[k]]));
        for (const k of ENV_KEYS) delete process.env[k];
        process.env.REG_STATE_DIR = testInfo.outputPath('state');
        process.env.BASE_URL = `${server.origin}/administrator/`;
        process.env.TIER_KIND = 'shared';
        process.env.REG_RUN_ID = runId();
        core = new FakeCore();
        server.reset();
        raw = await request.newContext({ baseURL: process.env.BASE_URL, extraHTTPHeaders: { Authorization: 'Bearer SECRET-TOKEN' } });
        api = guardApi(raw);
    });
    test.afterEach(async () => {
        await api.dispose();
        for (const [k, v] of Object.entries(saved)) {
            if (v === undefined) delete process.env[k];
            else process.env[k] = v;
        }
    });

    const wire = () => server.mutations().map((a) => `${a.method} ${a.url.replace(/[0-9a-f]{8}-[0-9a-f-]{27}/g, '<uuid>')}`);

    test('ensureSeedA: 5 attributes, the owner, 2 groups, 24 uploads (CA first, then C01…C23), the PATCH updates; ledger before assertion; idempotent', async () => {
        test.setTimeout(180_000);
        const m = await ensureCertificateSeed(api, 'T');
        expect(seedAProblems(m)).toEqual([]);
        const w = wire();
        const uploads = w.filter((x) => x === 'POST /api/v1/certificates/upload');
        expect(uploads).toHaveLength(24);
        expect(w.filter((x) => x === 'POST /api/v1/attributes/custom')).toHaveLength(5);
        expect(w.filter((x) => x === 'POST /api/v1/groups')).toHaveLength(2);
        expect(w.filter((x) => x === 'POST /api/v1/users')).toHaveLength(1);
        // Upload order: ca-root first, then C01 … C23 by common name; created order = upload order.
        expect(core.uploads.map((u) => String(u.subject).replace(`CN=${m.prefix}`, ''))).toEqual(['ca-root', ...SEED_A_ROWS.slice(0, 23).map((r) => r.token)]);
        // Updates: groups on C01–C08, the owner on C01 / C02, trustedCa on the CA; nothing else is patched.
        const byId = (uuid: string) => idsOfUuids(m, [uuid])[0];
        const patched = Object.fromEntries(core.patches.map((p) => [byId(p.uuid), p.body]));
        expect(Object.keys(patched).sort()).toEqual(['C01', 'C02', 'C03', 'C04', 'C05', 'C06', 'C07', 'C08', 'C24']);
        expect(patched.C01).toEqual({ groupUuids: [m.groupUuids.a], ownerUuid: m.ownerUuid });
        expect(patched.C03).toEqual({ groupUuids: [m.groupUuids.a, m.groupUuids.b] });
        expect(patched.C07).toEqual({ groupUuids: [m.groupUuids.b] });
        expect(patched.C24).toEqual({ trustedCa: true });
        // Attribute values travel in the upload request, per the expected table; none for a seed without a value.
        const c01 = core.uploads.find((u) => String(u.subject).endsWith('alpha-web'))!;
        const vals = (c01.customAttributes as Json[]).map((a) => [a.name.replace(m.prefix, ''), a.content.map((x: Json) => x.data)]);
        expect(vals).toEqual([['txt', ['red']], ['num', [10]], ['day', [m.certificates[0].day]], ['flag', [true]], ['pick', ['a']]]);
        const c14 = core.uploads.find((u) => String(u.subject).endsWith('kappa-14'))!;
        expect(c14.customAttributes).toEqual([]);
        // Ledger: every object (24 certificates + 24 derived keys, 5 attributes, 2 groups, 1 user), recorded.
        const ledger = readLedger().filter((l) => l.runId === runId());
        expect(ledger.filter((l) => l.type === 'certificates' && !l.derived)).toHaveLength(24);
        expect(ledger.filter((l) => l.type === 'keys' && l.derived)).toHaveLength(24);
        expect(ledger.filter((l) => l.type === 'customAttributes')).toHaveLength(5);
        expect(ledger.filter((l) => l.type === 'groups')).toHaveLength(2);
        expect(ledger.filter((l) => l.type === 'users')).toHaveLength(1);
        expect(readRunState().inventorySeed?.seedA).toBeTruthy();
        // The manifest carries the API read-back and the fingerprint of each certificate.
        expect(certById(m, 'C03').fingerprint).toMatch(/^[0-9a-f]{64}$/);
        expect(certById(m, 'C03').notAfter).toBe(notAfterOf(m, 'C03'));
        expect(uuidsOfIds(m, ['C01', 'C02'])).toHaveLength(2);
        // Second call: nothing is sent.
        server.reset();
        const again = await ensureCertificateSeed(api, 'T');
        expect(again.prefix).toBe(m.prefix);
        expect(server.mutations()).toEqual([]);
    });

    test('ensureSeedA: a required custom attribute on certificates / groups is filled; the guard refuses a foreign group in a patch', async () => {
        test.setTimeout(180_000);
        core.requiredGroupAttr = true;
        const m = await ensureCertificateSeed(api, 'T');
        const group = [...core.store.values()].find((o) => o.name === m.groups.a.name)!;
        expect(group.customAttributes).toEqual([{ version: 'v3', uuid: U(1), name: 'site', contentType: 'string', content: [{ data: m.groups.a.name, contentType: 'string' }] }]);
        // A PATCH naming a group the run did not create is refused by the guard before it leaves.
        const { patchOwnCertificate } = await import('../../utils/regression/inventory/seedOwnedObjects');
        server.reset();
        await expect(patchOwnCertificate(api, { uuid: certById(m, 'C01').uuid, name: certById(m, 'C01').commonName, kind: 'own' }, { groupUuids: [U(9999)] })).rejects.toBeInstanceOf(OwnObjectViolation);
        expect(server.mutations()).toEqual([]);
    });

    test('buildFreshSeedB: own groups only, every create recorded in the ledger before the first assertion, the guard refuses a foreign group', async () => {
        test.setTimeout(60_000);
        const b = await buildFreshSeedB(api, 'T');
        // Read the ledger before any assertion: what the build created must already be recorded.
        const ledger = readLedger().filter((l) => l.runId === runId());
        const created = [...core.store.values()].map((o) => String(o.uuid));
        expect(created).toHaveLength(4);
        for (const uuid of created) expect(ledger.map((l) => l.uuid), `created ${uuid} is in the ledger`).toContain(uuid);
        expect(ledger.filter((l) => l.type === 'groups').map((l) => l.uuid)).toEqual(b.groups.map((g) => g.uuid));
        expect(ledger.filter((l) => l.type === 'certificates' && !l.derived).map((l) => l.uuid)).toEqual(b.certificates.map((c) => c.uuid));
        // The manifest: one own group and three own certificates under the run's prefix.
        expect(b.kind).toBe('seed-b');
        expect(b.runId).toBe(runId());
        expect(b.prefix.startsWith(`${runId()}-`)).toBe(true);
        expect(b.groups.map((g) => g.name)).toEqual([`${b.prefix}grp`]);
        expect(b.certificates.map((c) => c.commonName)).toEqual(['b1', 'b2', 'b3'].map((k) => `${b.prefix}${k}`));
        // Every certificate is patched into the own group only.
        expect(core.patches.map((p) => p.uuid)).toEqual(b.certificates.map((c) => c.uuid));
        for (const p of core.patches) expect(p.body).toEqual({ groupUuids: [b.groups[0].uuid] });
        // A PATCH naming a group the run did not create is refused by the guard before it leaves.
        const { patchOwnCertificate } = await import('../../utils/regression/inventory/seedOwnedObjects');
        server.reset();
        const c = b.certificates[0];
        await expect(patchOwnCertificate(api, { uuid: c.uuid, name: c.commonName, kind: 'own' }, { groupUuids: [U(9999)] })).rejects.toBeInstanceOf(OwnObjectViolation);
        expect(server.mutations()).toEqual([]);
    });
});
