/**
 * seedFull on the wire: ensureCertificateSeed / B / C build the certificate seeds through the guarded api on a stateful loopback fake
 * core (127.0.0.1 only); every create is in the ledger before the first assertion and a foreign group in a patch is refused.
 */
import { expect, test } from '@playwright/test';
import * as crypto from 'crypto';
import { describeCertificate } from '../../utils/regression/inventory/seedCertificates';
import { buildFreshSeedB, certById, ensureCertificateSeed, idsOfUuids, CERTIFICATE_SEED_ROWS, certificateSeedProblems, uuidsOfIds } from '../../utils/regression/inventory/seedFull';
import { notAfterOf } from '../../utils/regression/inventory/searchTables';
import { GuardedApi } from '../../utils/regression/guard/types';
import { OwnObjectViolation } from '../../utils/regression/ledger/ownership';
import { readLedger } from '../../utils/regression/ledger/ledger';
import { readRunState, runId } from '../../utils/regression/ledger/runState';
import { Answer, Arrived, LoopbackServer } from './helpers/loopbackServer';
import { FakeCore as BaseCore } from './helpers/fakeCore';
import { registerFakeCore } from './helpers/guardRig';

type Json = Record<string, any>;

// ------------------------------------------------------------------ wire: ensureCertificateSeed / B / C through the guard

const U = (n: number) => `bbbbbbbb-0000-4000-8000-${String(n).padStart(12, '0')}`;

/** A stateful fake core for the seed builds: what the run creates is stored and answered. */
class SeedCore extends BaseCore {
    protected uuidPrefix = 'bbbbbbbb-0000-4000-8000-';
    readonly uploads: Json[] = [];
    readonly patches: Array<{ uuid: string; body: Json }> = [];
    requiredGroupAttr = false;

    protected respond(a: Arrived): Answer | undefined {
        const path = a.url.split('?')[0];
        const body = a.body ? (JSON.parse(a.body) as Json) : undefined;
        if (a.method === 'GET') return this.get(path);
        if (a.method === 'POST') return this.post(path, body);
        if (a.method === 'PATCH') return this.patch(path, body);
        return { status: 204 };
    }

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
let core: SeedCore;
let api: GuardedApi;

test.describe('the certificate seeds build on the loopback fake core (every request goes through the guard)', () => {
    registerFakeCore(() => core, (rig) => ({ server, api } = rig), { clear: ['REG_RA_PROFILE_NAME'] });
    test.beforeEach(() => {
        core = new SeedCore();
    });

    const wire = () => server.mutations().map((a) => `${a.method} ${a.url.replace(/[0-9a-f]{8}-[0-9a-f-]{27}/g, '<uuid>')}`);

    test('ensureCertificateSeed: 5 attributes, the owner, 2 groups, 24 uploads (CA first, then C01…C23), the PATCH updates; ledger before assertion; idempotent', async () => {
        test.setTimeout(180_000);
        const m = await ensureCertificateSeed(api, 'T');
        expect(certificateSeedProblems(m)).toEqual([]);
        const w = wire();
        const uploads = w.filter((x) => x === 'POST /api/v1/certificates/upload');
        expect(uploads).toHaveLength(24);
        expect(w.filter((x) => x === 'POST /api/v1/attributes/custom')).toHaveLength(5);
        expect(w.filter((x) => x === 'POST /api/v1/groups')).toHaveLength(2);
        expect(w.filter((x) => x === 'POST /api/v1/users')).toHaveLength(1);
        // Upload order: ca-root first, then C01 … C23 by common name; created order = upload order.
        expect(core.uploads.map((u) => String(u.subject).replace(`CN=${m.prefix}`, ''))).toEqual(['ca-root', ...CERTIFICATE_SEED_ROWS.slice(0, 23).map((r) => r.token)]);
        // Updates: groups on the first eight certificates, the owner on the first two, trustedCa on the CA; nothing else is patched.
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
        expect(readRunState().inventorySeed?.certificateSeed).toBeTruthy();
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

    test('ensureCertificateSeed: a required custom attribute on certificates / groups is filled; the guard refuses a foreign group in a patch', async () => {
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
        expect(b.kind).toBe('archive-seed');
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
