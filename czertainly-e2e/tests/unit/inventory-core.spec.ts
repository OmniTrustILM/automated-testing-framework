/**
 * Inventory area, shared layer (the lead's modules): inventoryApi (condition sets, filter builders, catalogue checks),
 * inventoryPki (certificates with chosen validity / key size / hash / issuer), inventorySeedFull (the SEED-A plan, the
 * build through the GUARDED api on a loopback fake core) and inventoryTables (the plan's expected row sets against the
 * seed predicates: double entry). No ILM environment: the fake core is 127.0.0.1 only.
 */
import { APIRequestContext, expect, request, test } from '@playwright/test';
import * as crypto from 'crypto';
import {
    ALL_CONDITIONS, CONDITION_KINDS, CONDITION_SETS, fieldProblems, fieldsOf, findField, isolation, prop, rowsOf, sameSet, uuidSet,
} from '../../utils/regression/inventoryApi';
import { buildCertificate, describeCertificate, generateKeys, verifiesUnder } from '../../utils/regression/inventoryPki';
import {
    certById, dayValues, ensureSeedA, ensureSeedB, ensureSeedC, idsOfUuids, PICK_OPTIONS, planSeedA, SEED_A_DEFAULT_ORDER, SEED_A_ROWS, SEED_A_UPLOAD_ORDER,
    seedAProblems, SeedAManifest, uuidsOfIds,
} from '../../utils/regression/inventorySeedFull';
import {
    ALL_ROW_TABLES, ATTRIBUTE_EDGES, COLLECTION_ROWS, DATE_ROWS, expectedOrderGroups, LIST_ROWS, notAfterOf, orderProblem, sortKey, TEXT_ROWS,
} from '../../utils/regression/inventoryTables';
import { guardApi, GuardedApi } from '../../utils/regression/guardedApi';
import { OwnObjectViolation } from '../../utils/regression/ownObjects';
import { readLedger, readState, RUN_ID } from '../../utils/regression/regressionRun';
import { Answer, Arrived, loopbackServer, LoopbackServer } from './helpers/loopbackServer';

type Json = Record<string, any>;

const CLOCK = new Date('2026-10-14T10:00:00.000Z');
const planName = (suffix: string) => `qa-reg-20261014-100000-abcd-${suffix}`;

// ------------------------------------------------------------------ pure: inventoryApi

test('the absolute condition sets: string 10, number 8, date / datetime 10, list 4, boolean 4 (core SearchFieldTypeEnum), the special kinds', () => {
    expect(CONDITION_SETS.string).toHaveLength(10);
    expect(CONDITION_SETS.number).toHaveLength(8);
    expect(CONDITION_SETS.date).toHaveLength(10);
    expect(CONDITION_SETS.datetime).toHaveLength(10);
    expect(CONDITION_SETS.list).toHaveLength(4);
    expect(CONDITION_SETS.boolean).toHaveLength(4);
    expect(CONDITION_KINDS.collection).toHaveLength(8);
    expect(CONDITION_KINDS.expectedBoolean).toEqual(['EQUALS', 'NOT_EQUALS']);
    for (const set of [...Object.values(CONDITION_SETS), ...Object.values(CONDITION_KINDS)]) {
        for (const c of set) expect(ALL_CONDITIONS).toContain(c);
        expect(new Set(set).size).toBe(set.length);
    }
});

test('fieldProblems flags a wrong condition set, a duplicate, an unknown operator, an empty label and sortable-without-displayable', () => {
    const ok = { fieldIdentifier: 'COMMON_NAME', fieldLabel: 'Common Name', type: 'string' as const, conditions: [...CONDITION_SETS.string] };
    expect(fieldProblems(ok)).toEqual([]);
    expect(fieldProblems({ ...ok, conditions: ['EQUALS', 'EQUALS'] }).join('|')).toMatch(/duplicate conditions/);
    expect(fieldProblems({ ...ok, conditions: ['EQUALS', 'LIKE'] }).join('|')).toMatch(/outside FilterConditionOperator: LIKE/);
    expect(fieldProblems({ ...ok, fieldLabel: ' ' }).join('|')).toMatch(/empty fieldLabel/);
    expect(fieldProblems({ ...ok, conditions: ['EQUALS'] }).join('|')).toMatch(/differ from the absolute set/);
    expect(fieldProblems({ ...ok, sortable: true, displayable: false }).join('|')).toMatch(/core#2180/);
    expect(fieldProblems({ ...ok, conditions: ['EMPTY', 'NOT_EMPTY'] }), 'a presence-only field is recognised').toEqual([]);
    expect(fieldProblems({ fieldIdentifier: 'PRIVATE_KEY', fieldLabel: 'Private Key', type: 'boolean', conditions: ['EQUALS', 'NOT_EQUALS'] }), 'expected-value boolean').toEqual([]);
    expect(fieldProblems({ fieldIdentifier: 'GROUP_NAME', fieldLabel: 'Group', type: 'list', conditions: [...CONDITION_KINDS.collection] }, 'collection')).toEqual([]);
    expect(sameSet(['A', 'B'], ['B', 'A'])).toBe(true);
});

test('catalogue and row helpers: fieldsOf / findField / rowsOf / uuidSet / filter builders', () => {
    const catalogue = [
        { filterFieldSource: 'property' as const, searchFieldData: [{ fieldIdentifier: 'COMMON_NAME', fieldLabel: 'Common Name', type: 'string' as const, conditions: [] }] },
        { filterFieldSource: 'custom' as const, searchFieldData: [{ fieldIdentifier: 'x|STRING', fieldLabel: 'X', type: 'string' as const, conditions: [] }] },
    ];
    expect(fieldsOf(catalogue, 'custom').map((f) => f.fieldIdentifier)).toEqual(['x|STRING']);
    expect(findField(catalogue, 'COMMON_NAME')?.fieldLabel).toBe('Common Name');
    expect(findField(catalogue, 'COMMON_NAME', 'custom')).toBeUndefined();
    expect(rowsOf({ certificates: [{ uuid: 'b' }, { uuid: 'a' }], totalItems: 2 })).toEqual([{ uuid: 'b' }, { uuid: 'a' }]);
    expect(rowsOf([{ uuid: 'a' }])).toEqual([{ uuid: 'a' }]);
    expect(uuidSet([{ uuid: 'b' }, { uuid: 'a' }])).toEqual(['a', 'b']);
    expect(prop('COMMON_NAME', 'EMPTY')).toEqual({ fieldSource: 'property', fieldIdentifier: 'COMMON_NAME', condition: 'EMPTY' });
    expect(isolation('p-')).toEqual({ fieldSource: 'property', fieldIdentifier: 'COMMON_NAME', condition: 'STARTS_WITH', value: 'p-' });
});

// ------------------------------------------------------------------ pure: inventoryPki

test('buildCertificate: validity at second precision, key size, hash, self-signed vs issued, the CA flag', async () => {
    test.setTimeout(60_000);
    const ca = await buildCertificate({ commonName: 'ca-root-test', notBefore: new Date('2026-09-01T00:00:00.789Z'), notAfter: new Date('2027-09-01T00:00:00Z'), ca: true });
    const leaf = await buildCertificate({
        commonName: 'leaf-test', notBefore: new Date('2026-09-02T00:00:00Z'), notAfter: new Date('2027-01-01T00:00:00Z'), keyBits: 3072, issuer: ca.handle,
    });
    const self = await buildCertificate({ commonName: 'self-test', notBefore: new Date('2026-09-02T00:00:00Z'), notAfter: new Date('2027-01-01T00:00:00Z'), hash: 'SHA-512' });
    const dCa = describeCertificate(ca.pem);
    expect(dCa).toMatchObject({ subject: 'CN=ca-root-test', issuer: 'CN=ca-root-test', keyBits: 2048, isCa: true });
    expect(dCa.notBefore.toISOString(), 'seconds precision').toBe('2026-09-01T00:00:00.000Z');
    expect(describeCertificate(leaf.pem)).toMatchObject({ subject: 'CN=leaf-test', issuer: 'CN=ca-root-test', keyBits: 3072, isCa: false, hash: 'SHA-256' });
    expect(describeCertificate(self.pem)).toMatchObject({ subject: 'CN=self-test', issuer: 'CN=self-test', isCa: false, hash: 'SHA-512' });
    expect(await verifiesUnder(leaf.pem, ca.pem), 'the leaf is signed by the CA').toBe(true);
    expect(await verifiesUnder(self.pem, ca.pem), 'a self-signed certificate does not verify under another key').toBe(false);
    expect(await verifiesUnder(self.pem, self.pem), 'and verifies under its own').toBe(true);
    expect(ca.fingerprintSha256).toMatch(/^[0-9a-f]{64}$/);
    expect(ca.fingerprintSha256).toBe(crypto.createHash('sha256').update(ca.der).digest('hex'));
    await expect(buildCertificate({ commonName: 'wrong-hash', notBefore: new Date('2026-09-02T00:00:00Z'), notAfter: new Date('2027-01-01T00:00:00Z'), hash: 'SHA-384', issuer: ca.handle }))
        .rejects.toThrow(/asks for SHA-384 but its issuer's key signs with SHA-256/);
    await expect(buildCertificate({ commonName: 'bad', notBefore: new Date('2026-09-02T00:00:00Z'), notAfter: new Date('2026-09-01T00:00:00Z') })).rejects.toThrow(/notAfter must be after notBefore/);
    expect(await generateKeys(2048, 'SHA-256')).toBeTruthy();
});

// ------------------------------------------------------------------ pure: the SEED-A plan and the tables

test('SEED-A plan: 24 certificates, the derived counts of the plan §2.1, upload order and default order', () => {
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

function tableRows(): Array<{ table: string; row: (typeof TEXT_ROWS)[number] }> {
    return Object.entries(ALL_ROW_TABLES).flatMap(([table, rows]) => rows.map((row) => ({ table, row })));
}

test('double entry: the plan\'s expected set of every row equals the seed predicate (a mistake in the plan or the predicate shows here)', () => {
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
    expect(TEXT_ROWS.filter((r) => r.bug).map((r) => `${r.row}:${r.bug}`)).toEqual(['T-13:core#2505', 'T-14:core#2505']);
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
        process.env.REG_RUN_ID = RUN_ID;
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
        const m = await ensureSeedA(api, 'T');
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
        // Attribute values travel in the upload request, per the plan table; none for a seed without a value.
        const c01 = core.uploads.find((u) => String(u.subject).endsWith('alpha-web'))!;
        const vals = (c01.customAttributes as Json[]).map((a) => [a.name.replace(m.prefix, ''), a.content.map((x: Json) => x.data)]);
        expect(vals).toEqual([['txt', ['red']], ['num', [10]], ['day', [m.certificates[0].day]], ['flag', [true]], ['pick', ['a']]]);
        const c14 = core.uploads.find((u) => String(u.subject).endsWith('kappa-14'))!;
        expect(c14.customAttributes).toEqual([]);
        // Ledger: every object (24 certificates + 24 derived keys, 5 attributes, 2 groups, 1 user), recorded.
        const ledger = readLedger().filter((l) => l.runId === RUN_ID);
        expect(ledger.filter((l) => l.type === 'certificates' && !l.derived)).toHaveLength(24);
        expect(ledger.filter((l) => l.type === 'keys' && l.derived)).toHaveLength(24);
        expect(ledger.filter((l) => l.type === 'customAttributes')).toHaveLength(5);
        expect(ledger.filter((l) => l.type === 'groups')).toHaveLength(2);
        expect(ledger.filter((l) => l.type === 'users')).toHaveLength(1);
        expect(readState().inventorySeed?.seedA).toBeTruthy();
        // The manifest carries the API read-back and the fingerprint of each certificate.
        expect(certById(m, 'C03').fingerprint).toMatch(/^[0-9a-f]{64}$/);
        expect(certById(m, 'C03').notAfter).toBe(notAfterOf(m, 'C03'));
        expect(uuidsOfIds(m, ['C01', 'C02'])).toHaveLength(2);
        // Second call: nothing is sent.
        server.reset();
        const again = await ensureSeedA(api, 'T');
        expect(again.prefix).toBe(m.prefix);
        expect(server.mutations()).toEqual([]);
    });

    test('ensureSeedA: a required custom attribute on certificates / groups is filled; the guard refuses a foreign group in a patch', async () => {
        test.setTimeout(180_000);
        core.requiredGroupAttr = true;
        const m = await ensureSeedA(api, 'T');
        const group = [...core.store.values()].find((o) => o.name === m.groups.a.name)!;
        expect(group.customAttributes).toEqual([{ version: 'v3', uuid: U(1), name: 'site', contentType: 'string', content: [{ data: m.groups.a.name, contentType: 'string' }] }]);
        // A PATCH naming a group the run did not create is refused by the guard before it leaves.
        const { patchOwnCertificate } = await import('../../utils/regression/inventoryOwn');
        server.reset();
        await expect(patchOwnCertificate(api, { uuid: certById(m, 'C01').uuid, name: certById(m, 'C01').commonName, kind: 'own' }, { groupUuids: [U(9999)] })).rejects.toBeInstanceOf(OwnObjectViolation);
        expect(server.mutations()).toEqual([]);
    });

    test('ensureSeedB and ensureSeedC: small seeds, own groups, group assignment only in SEED-B', async () => {
        test.setTimeout(120_000);
        const b = await ensureSeedB(api, 'T');
        expect(b.certificates.map((c) => c.key)).toEqual(['b1', 'b2', 'b3']);
        expect(b.groups.map((g) => g.key)).toEqual(['grp']);
        const patchesB = core.patches.length;
        expect(patchesB).toBe(3);
        server.reset();
        const c = await ensureSeedC(api, 'T');
        expect(c.certificates.map((x) => x.key)).toEqual(['c1', 'c2']);
        expect(c.groups.map((g) => g.key)).toEqual(['g1', 'g2', 'g3']);
        expect(core.patches.length, 'SEED-C assigns no group yet').toBe(patchesB);
        expect(wire().filter((x) => x === 'POST /api/v1/groups')).toHaveLength(3);
        expect((await ensureSeedB(api, 'T')).prefix, 'idempotent').toBe(b.prefix);
    });
});
