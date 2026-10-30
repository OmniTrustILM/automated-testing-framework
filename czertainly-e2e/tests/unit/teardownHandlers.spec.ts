/**
 * teardownHandlers — every teardown handler of utils/regression/teardown/teardownHandlers.ts, as runTeardown loads it.
 *
 * Each handler runs behind the guard against a fake core: live read first, foreign objects refused, a delete counts only
 * when a read afterwards answers 404, derived objects kept when adopted. Also the certificate-key safety net, the
 * compliance-profile removal, and the role / user detail-500 workaround (core#2511, decided by the full list). Without a
 * server time, discovery-onboarded objects and an own certificate's certKey_ key are kept with the keeping bound; with one they
 * are deleted. A foreign object is never recorded, kept or deleted. The teardown is the only code that deletes.
 */
import { randomUUID } from 'node:crypto';
import { APIRequestContext, test, expect } from '@playwright/test';
import { DryRunRefusal } from '../../utils/regression/run/flags';
import { LiveObjectMissing, OwnObjectViolation } from '../../utils/regression/ledger/ownership';
import { KEEPING_BOUND_AHEAD_MS, LedgerLine, readLedger, recordCreated } from '../../utils/regression/ledger/ledger';
import { runName, runId } from '../../utils/regression/ledger/runState';
import { executeTeardown, handlerOf, readKeptReport, TeardownContext, TeardownHandler, writeKeptReport } from '../../utils/regression/teardown/runTeardown';
import { adoptionOf, hasLiveOwn, keyAssociationsOf, recordCertKeySafetyNet, removeComplianceProfile, teardownHandlers, ungateOwnRaProfiles } from '../../utils/regression/teardown/teardownHandlers';
import { fakeResponse, FakeReply } from './helpers/fakeResponse';
import { partialOf, useEnv } from './helpers/guardRig';

const RUN = 'qa-reg-20261013-120000-ab12';
type Json = Record<string, any>;

/** An in-memory core: detail URLs in `store`, extra routes per method + path pattern, every call recorded. */
class FakeCore {
    store = new Map<string, Json>();
    calls: string[] = [];
    private routes: Array<{ method: string; match: RegExp; reply: (path: string, data: unknown, m: RegExpExecArray) => FakeReply }> = [];

    set(path: string, body: Json): this {
        this.store.set(path, body);
        return this;
    }

    route(method: string, match: RegExp, reply: (path: string, data: unknown, m: RegExpExecArray) => FakeReply): this {
        this.routes.push({ method, match, reply });
        return this;
    }

    private handle(method: string, url: string, data: unknown): FakeReply {
        const path = url.split('?')[0];
        this.calls.push(`${method} ${path}`);
        for (const r of this.routes) {
            const m = r.match.exec(path);
            if (r.method === method && m) return r.reply(path, data, m);
        }
        if (method === 'GET') return this.store.has(path) ? { status: 200, body: this.store.get(path) } : { status: 404 };
        if (method === 'DELETE') {
            if (!this.store.has(path)) return { status: 404 };
            this.store.delete(path);
            return { status: 204 };
        }
        return { status: 404 };
    }

    api(): APIRequestContext {
        const call = (method: string) => async (url: string, opts?: { data?: unknown }) => fakeResponse(this.handle(method, url, opts?.data));
        return partialOf<APIRequestContext>({
            get: call('GET'),
            post: call('POST'),
            patch: call('PATCH'),
            put: call('PUT'),
            delete: call('DELETE'),
            fetch: async (url: string, opts?: { method?: string; data?: unknown }) => fakeResponse(this.handle((opts?.method ?? 'GET').toUpperCase(), url, opts?.data)),
            dispose: async () => undefined,
        });
    }

    /** Calls other than GET: what the handler changed. */
    mutations(): string[] {
        return this.calls.filter((c) => !c.startsWith('GET '));
    }
}

let seq = 0;
const line = (type: string, over: Partial<LedgerLine> = {}): LedgerLine => {
    seq++;
    return { at: '2026-10-13T12:00:00.000Z', runId: RUN, type, name: `${RUN}-${type}-${seq}`, uuid: `${type}-${seq}`, spec: 'T', event: 'created', ...over };
};

useEnv(['REG_STATE_DIR', 'REG_RUN_ID', 'API_TEARDOWN_DRY_RUN'], (testInfo) => ({ REG_STATE_DIR: testInfo.outputPath('state') }));

/** Runs a handler the way executeTeardown does for one object; returns the result, the warnings and the error. */
async function run(core: FakeCore, l: LedgerLine, ledger: LedgerLine[] = [l]): Promise<{ result?: string | void; warnings: string[]; error?: unknown }> {
    const h = handlerOf(l.type) as TeardownHandler;
    expect(h, `handler for ${l.type}`).toBeTruthy();
    const warnings: string[] = [];
    const ctx: TeardownContext = { api: core.api(), runId: RUN, ledger, seen: new Set(), tier: null, warn: (m) => void warnings.push(m), pollMs: 1 };
    try {
        return { result: await h.remove(ctx, l), warnings };
    } catch (error) {
        return { warnings, error };
    }
}

// ------------------------------------------------------------------ delete proof and live-object basics (a byUrl type)

test('a role is read live, deleted, and its absence proven by GET', async () => {
    const role = line('roles');
    const core = new FakeCore().set(`/api/v1/roles/${role.uuid}`, { uuid: role.uuid, name: role.name });
    const { error } = await run(core, role);
    expect(error).toBeUndefined();
    expect(core.calls).toEqual([`GET /api/v1/roles/${role.uuid}`, `DELETE /api/v1/roles/${role.uuid}`, `GET /api/v1/roles/${role.uuid}`]);
});

test('404 without a prior 200 in the step is "route or object missing", never "deleted"', async () => {
    const role = line('roles');
    const core = new FakeCore(); // a wrong route or a vanished object: GET answers 404
    const { error } = await run(core, role);
    expect(error).toBeInstanceOf(LiveObjectMissing);
    expect(String(error)).toMatch(/route or object missing/);
    expect(core.mutations(), 'no DELETE was sent').toEqual([]);
});

// a DELETE answering 404 after a 200 read counts (the object went away in between); the GET still proves it
test('a DELETE answering 404 after a 200 read counts as gone in between; the GET still proves it', async () => {
    const role = line('roles');
    const core = new FakeCore()
        .set(`/api/v1/roles/${role.uuid}`, { name: role.name })
        .route('DELETE', /^\/api\/v1\/roles\//, (p) => {
            core.store.delete(p);
            return { status: 404 };
        });
    expect((await run(core, role)).error).toBeUndefined();
});

test('a 2xx DELETE that leaves the object in place is a failure ("not deleted")', async () => {
    const role = line('roles');
    const core = new FakeCore().set(`/api/v1/roles/${role.uuid}`, { name: role.name }).route('DELETE', /^\/api\/v1\/roles\//, () => ({ status: 204 }));
    const { error } = await run(core, role);
    expect(String(error)).toMatch(/GET still finds it \(status 200\): not deleted/);
});

// the second attempt of attemptCleanup sees the object gone after the first deleted it: done, not "missing"
test('the second attemptCleanup attempt sees the object gone after the first deleted it: done, not missing', async () => {
    const role = line('roles');
    const core = new FakeCore().set(`/api/v1/roles/${role.uuid}`, { name: role.name });
    const h = handlerOf('roles')!;
    const ctx: TeardownContext = { api: core.api(), runId: RUN, ledger: [role], seen: new Set(), tier: null, warn: () => undefined, pollMs: 1 };
    await h.remove(ctx, role);
    await expect(h.remove(ctx, role), 'same step (same seen set): gone after a 200').resolves.toBeUndefined();
});

test('a ledger line whose live object is foreign (renamed) is refused, nothing deleted', async () => {
    const role = line('roles');
    const core = new FakeCore().set(`/api/v1/roles/${role.uuid}`, { name: 'Administrator' });
    const { error } = await run(core, role);
    expect(error).toBeInstanceOf(OwnObjectViolation);
    expect(String(error)).not.toContain('Administrator');
    expect(core.mutations()).toEqual([]);
});

test('every simple type: authorities, credentials, connectors, tokens, custom attributes, groups', async () => {
    const urls: Record<string, (u: string) => string> = {
        authorities: (u) => `/api/v1/authorities/${u}`,
        credentials: (u) => `/api/v1/credentials/${u}`,
        connectors: (u) => `/api/v1/connectors/${u}`,
        tokens: (u) => `/api/v1/tokens/${u}`,
        customAttributes: (u) => `/api/v1/attributes/custom/${u}`,
        groups: (u) => `/api/v1/groups/${u}`,
    };
    for (const [type, url] of Object.entries(urls)) {
        const l = line(type);
        const core = new FakeCore().set(url(l.uuid), { uuid: l.uuid, name: l.name });
        const { error } = await run(core, l);
        expect(error, type).toBeUndefined();
        expect(core.mutations(), type).toEqual([`DELETE ${url(l.uuid)}`]);
        expect(core.store.size, `${type} is gone`).toBe(0);
    }
});

test('the dry run stops a handler at its entry, before any request', async () => {
    process.env.API_TEARDOWN_DRY_RUN = 'on';
    const role = line('roles');
    const core = new FakeCore().set(`/api/v1/roles/${role.uuid}`, { name: role.name });
    const { error } = await run(core, role);
    expect(error).toBeInstanceOf(DryRunRefusal);
    expect(core.calls).toEqual([]);
});

// ------------------------------------------------------------------ certificates (revoke fallback, discovered certificates)

test('an issued certificate without parents is revoked through its own RA profile, then deleted', async () => {
    const cert = line('certificates', { name: `${RUN}-api.example.test` });
    const detail = `/api/v1/certificates/${cert.uuid}`;
    const core = new FakeCore()
        .set(detail, { uuid: cert.uuid, commonName: cert.name, state: 'issued', raProfile: { uuid: 'ra-x', authorityInstanceUuid: 'auth-x' } })
        .route('POST', /\/revoke$/, () => {
            core.store.get(detail)!.state = 'revoked';
            return { status: 200 };
        });
    const { error } = await run(core, cert);
    expect(error).toBeUndefined();
    expect(core.mutations()).toEqual([
        'POST /api/v1/keys', // the safety net's read (key list by name, CKI_NAME); this fake answers 404, which only warns; it records, never deletes
        `POST /api/v2/operations/authorities/auth-x/raProfiles/ra-x/certificates/${cert.uuid}/revoke`,
        `DELETE ${detail}`,
    ]);
});

test('a refused revoke names the authority that blocks the certificate', async () => {
    const cert = line('certificates', { name: `${RUN}-ui.example.test`, parents: { raProfile: 'ra-1', authority: 'auth-1' } });
    const core = new FakeCore()
        .set(`/api/v1/certificates/${cert.uuid}`, { commonName: cert.name, state: 'issued' })
        .route('POST', /\/revoke$/, () => ({ status: 503, body: 'connector unavailable' }));
    const { error } = await run(core, cert);
    expect(String(error)).toMatch(/revoke refused/);
    expect((error as { blockedBy?: string }).blockedBy).toBe('authority auth-1');
});

const derivedCert = (over: Partial<LedgerLine> = {}) =>
    line('certificates', { name: 'onboarded', derived: true, createdAfter: '2026-10-13T12:00:00.000Z', parents: { discovery: 'disc-1' }, ...over });

function certCore(l: LedgerLine, detail: Json, firstEvent: string): FakeCore {
    return new FakeCore()
        .set(`/api/v1/certificates/${l.uuid}`, { uuid: l.uuid, commonName: 'www.example.org', state: 'issued', ...detail })
        .set(`/api/v1/certificates/${l.uuid}/history`, [{ created: '2026-10-13T12:30:00.000Z' }, { created: firstEvent }]);
}

test('a discovered certificate someone adopted is kept and reported', async () => {
    for (const adoption of [{ raProfile: { uuid: 'ra-1' } }, { owner: 'alice' }, { groups: [{ uuid: 'g' }] }, { locations: [{ uuid: 'l' }] }, { certificateRequest: { uuid: 'r' } }]) {
        const l = derivedCert();
        const core = certCore(l, adoption, '2026-10-13T12:05:00.000Z');
        const { result, warnings } = await run(core, l);
        expect(result, JSON.stringify(adoption)).toBe('kept');
        expect(warnings[0]).toMatch(/kept derived certificate .*: adopted/);
        expect(core.mutations()).toEqual([]);
    }
});

test('a discovered certificate created before createdAfter is kept; one created after it is deleted', async () => {
    const before = derivedCert();
    const coreBefore = certCore(before, {}, '2026-10-13T11:59:59.000Z');
    expect((await run(coreBefore, before)).result).toBe('kept');
    expect(coreBefore.mutations()).toEqual([]);

    const after = derivedCert();
    const coreAfter = certCore(after, { state: 'revoked' }, '2026-10-13T12:00:01.000Z');
    const r = await run(coreAfter, after);
    expect(r.error).toBeUndefined();
    expect(r.result).toBeUndefined();
    expect(coreAfter.mutations()).toEqual([`DELETE /api/v1/certificates/${after.uuid}`]);

    // An unknown creation time is not "kept" quietly: the handler fails (red), nothing is deleted.
    const noHistory = derivedCert();
    const coreNone = new FakeCore().set(`/api/v1/certificates/${noHistory.uuid}`, { commonName: 'x', state: 'revoked' });
    const none = await run(coreNone, noHistory);
    expect(String(none.error), 'no creation time: cannot prove it, red').toMatch(/creation time unknown/);
    expect(coreNone.mutations()).toEqual([]);
});

test('a derived key without a creation time fails instead of being kept', async () => {
    const l = line('keys', { name: 'certKey_x', derived: true, createdAfter: '2026-10-13T12:00:00.000Z' });
    const core = new FakeCore().set(`/api/v1/keys/${l.uuid}`, { uuid: l.uuid, name: 'certKey_x', associations: [] });
    const r = await run(core, l);
    expect(String(r.error)).toMatch(/creation time unknown/);
    expect(core.mutations()).toEqual([]);
});

// ------------------------------------------------------------------ keys

// a derived key in a token, made before createdAfter or still used is kept; an orphan made after it is deleted
test('a derived key in a token, made before createdAfter or still used is kept; an orphan is deleted', async () => {
    const mk = (body: Json) => {
        const l = line('keys', { name: 'certKey_x', derived: true, createdAfter: '2026-10-13T12:00:00.000Z' });
        const core = new FakeCore().set(`/api/v1/keys/${l.uuid}`, { uuid: l.uuid, name: 'certKey_x', creationTime: '2026-10-13T12:10:00.000Z', associations: [], ...body });
        return { l, core };
    };
    for (const body of [{ tokenInstanceUuid: 't-1' }, { creationTime: '2026-10-13T11:00:00.000Z' }, { associations: [{ uuid: 'c' }] }, { associations: ['bare-uuid-of-a-user'] }, { associations: 'bare-uuid-of-a-user' }, { associations: { uuid: 'c' } }, { associations: 1 }, { associations: '' }]) {
        const { l, core } = mk(body);
        const r = await run(core, l);
        expect(r.result, JSON.stringify(body)).toBe('kept');
        expect(r.warnings[0]).toMatch(/kept derived key/);
        expect(core.mutations()).toEqual([]);
    }
    const { l, core } = mk({});
    core.route('DELETE', /^\/api\/v1\/keys$/, (_p, data) => {
        for (const u of data as string[]) core.store.delete(`/api/v1/keys/${u}`);
        return { status: 204 };
    });
    const r = await run(core, l);
    expect(r.error).toBeUndefined();
    expect(core.mutations()).toEqual(['DELETE /api/v1/keys']);
});

// the shape of `associations`: a list is read element by element; an absent or null value is none; any other value cannot be read,
// so it counts as use (fail closed)
test('keyAssociationsOf: a list as it is, nothing for absent or null, one unreadable element for any other value', () => {
    expect(keyAssociationsOf({ associations: [{ uuid: 'a' }, 'b'] })).toEqual([{ uuid: 'a' }, 'b']);
    expect(keyAssociationsOf({ associations: [] })).toEqual([]);
    expect(keyAssociationsOf({})).toEqual([]);
    expect(keyAssociationsOf({ associations: null })).toEqual([]);
    for (const value of ['a-uuid', { uuid: 'a' }, 7, '', 0, false]) expect(keyAssociationsOf({ associations: value }), JSON.stringify(value)).toHaveLength(1);
});

test('a derived key whose associations are not a list is kept as used; an absent or null value is unused and deleted', async () => {
    for (const associations of ['unexpected', { uuid: 'c' }, 3]) {
        const l = line('keys', { name: 'certKey_x', derived: true, createdAfter: '2026-10-13T12:00:00.000Z' });
        const core = new FakeCore().set(`/api/v1/keys/${l.uuid}`, { uuid: l.uuid, name: 'certKey_x', creationTime: '2026-10-13T12:10:00.000Z', associations });
        const r = await run(core, l);
        expect(r.result, JSON.stringify(associations)).toBe('kept');
        expect(core.mutations()).toEqual([]);
    }
    for (const body of [{ associations: null }, {}]) {
        const l = line('keys', { name: 'certKey_x', derived: true, createdAfter: '2026-10-13T12:00:00.000Z' });
        const core = new FakeCore().set(`/api/v1/keys/${l.uuid}`, { uuid: l.uuid, name: 'certKey_x', creationTime: '2026-10-13T12:10:00.000Z', ...body })
            .route('DELETE', /^\/api\/v1\/keys$/, (_p, data) => {
                for (const u of data as string[]) core.store.delete(`/api/v1/keys/${u}`);
                return { status: 204 };
            });
        const r = await run(core, l);
        expect(r.error, JSON.stringify(body)).toBeUndefined();
        expect(core.mutations()).toEqual(['DELETE /api/v1/keys']);
    }
});

// ------------------------------------------------------------------ own token keys (created by the protocol specs)

/** A core holding one token key with items; `DELETE /v1/keys [uuid]` removes it (after `refuseFirst` refusals). */
function keyCore(l: LedgerLine, opts: { refuseFirst?: number; name?: string } = {}): FakeCore {
    const detail = `/api/v1/keys/${l.uuid}`;
    let refusals = opts.refuseFirst ?? 0;
    const core = new FakeCore()
        .set(detail, { uuid: l.uuid, name: opts.name ?? l.name, tokenInstanceUuid: 't-1', items: [{ uuid: 'i-1', state: 'active', enabled: true }, { uuid: 'i-2', state: 'active', enabled: true }] })
        .route('DELETE', /^\/api\/v1\/keys$/, (_p, data) => {
            if (refusals > 0) {
                refusals--;
                return { status: 422, body: ['Key item i-1 is active'] };
            }
            for (const u of data as string[]) core.store.delete(`/api/v1/keys/${u}`);
            return { status: 204 };
        })
        .route('PATCH', /^\/api\/v1\/keys\/(disable|destroy)$/, (p) => {
            const items = core.store.get(detail)?.items as Array<{ state: string; enabled: boolean }> | undefined;
            items?.forEach((i) => (p.endsWith('disable') ? ((i.enabled = false), (i.state = 'deactivated')) : (i.state = 'destroyed')));
            return { status: 200 };
        });
    return core;
}

// an own token key with active items is deleted by the one keys handler (bulk DELETE /v1/keys), absence proven by GET; the
// derived rule is untouched
test('an own token key with active items is deleted by the one keys handler, absence proven by GET', async () => {
    const l = line('keys');
    const core = keyCore(l);
    const r = await run(core, l);
    expect(r.error).toBeUndefined();
    expect(r.result).toBeUndefined();
    expect(core.calls).toEqual([`GET /api/v1/keys/${l.uuid}`, 'DELETE /api/v1/keys', `GET /api/v1/keys/${l.uuid}`]);
    expect(core.store.has(`/api/v1/keys/${l.uuid}`)).toBe(false);
});

// a refused key delete deactivates and destroys the items first, then deletes again; a second refusal is red
test('a refused key delete deactivates and destroys the items first, then retries; a second refusal is red', async () => {
    const l = line('keys');
    const core = keyCore(l, { refuseFirst: 1 });
    const r = await run(core, l);
    expect(r.error).toBeUndefined();
    expect(core.mutations()).toEqual(['DELETE /api/v1/keys', 'PATCH /api/v1/keys/disable', 'PATCH /api/v1/keys/destroy', 'DELETE /api/v1/keys']);
    expect(r.warnings[0]).toMatch(/deactivating and destroying its items/);
    const stuck = line('keys');
    const coreStuck = keyCore(stuck, { refuseFirst: 2 });
    const s = await run(coreStuck, stuck);
    expect(String(s.error)).toMatch(/Failed to delete key .*after deactivate \/ destroy/);
    expect(coreStuck.store.has(`/api/v1/keys/${stuck.uuid}`)).toBe(true);
});

// a foreign key behind a keys line is refused by the live check: nothing is sent; a stuck 204 is "not deleted"
test('a foreign key behind a keys line is refused by the live check, nothing sent; a stuck 204 is not done', async () => {
    const foreign = line('keys');
    const core = keyCore(foreign, { name: 'hsm-production-key' });
    const r = await run(core, foreign);
    expect(r.error).toBeInstanceOf(OwnObjectViolation);
    expect(core.mutations()).toEqual([]);
    const stuck = line('keys');
    const coreStuck = new FakeCore().set(`/api/v1/keys/${stuck.uuid}`, { name: stuck.name }).route('DELETE', /^\/api\/v1\/keys$/, () => ({ status: 204 }));
    expect(String((await run(coreStuck, stuck)).error)).toMatch(/not deleted \(absence not proven\)/);
});

// ------------------------------------------------------------------ key items (typed keyItems): gone with their key

// a key item whose key has a `deleted` line of this run is done when its live read answers 404; a remaining item is reported,
// blocked by its key
test('a key item whose key has a deleted line of this run is done on a 404; a remaining item is blocked', async () => {
    const key = line('keys');
    const item = line('keyItems', { name: key.name, parents: { key: key.uuid } });
    const keyDeleted: LedgerLine = { ...key, event: 'deleted', at: '2026-10-13T12:30:00.000Z' };
    const core = new FakeCore();
    const gone = await run(core, item, [key, item, keyDeleted]);
    expect(gone.error).toBeUndefined();
    expect(core.calls).toEqual([`GET /api/v1/keys/${key.uuid}/items/${item.uuid}`]);
    // No `deleted` line for the key: the 404 is "route or object missing", never silently done.
    const missing = await run(new FakeCore(), item, [key, item]);
    expect(missing.error).toBeInstanceOf(LiveObjectMissing);
    // Still present (its key was not removed): reported, blocked by the key; nothing is sent.
    const present = new FakeCore().set(`/api/v1/keys/${key.uuid}/items/${item.uuid}`, { name: key.name });
    const r = await run(present, item, [key, item]);
    expect(String(r.error)).toMatch(/still present: its key was not removed/);
    expect((r.error as { blockedBy?: string }).blockedBy).toBe(`keys ${key.uuid}`);
    expect(present.mutations()).toEqual([]);
    // Without a parent key the item cannot be read: missing.
    const orphan = line('keyItems', { name: key.name });
    expect((await run(new FakeCore(), orphan, [orphan])).error).toBeInstanceOf(LiveObjectMissing);
});

// ------------------------------------------------------------------ own-trigger adoption of discovered certificates

// a derived certificate attached only to OWN groups / owner / RA profile is deleted; any foreign attachment, a location or a
// request keeps it
test('a derived certificate attached only to own groups, owner and RA profile is deleted, else kept', async () => {
    const group = line('groups');
    const user = line('users');
    const ra = line('raProfiles');
    const own = [group, user, ra];
    const after = '2026-10-13T12:05:00.000Z';
    const deleted = async (detail: Json, ledger: LedgerLine[] = own) => {
        const l = derivedCert();
        const core = certCore(l, { state: 'revoked', ...detail }, after);
        const r = await run(core, l, [...ledger, l]);
        return { r, core, l };
    };
    for (const detail of [{ groups: [{ uuid: group.uuid }] }, { ownerUuid: user.uuid, owner: user.name }, { raProfile: { uuid: ra.uuid } }, { groups: [{ uuid: group.uuid }], ownerUuid: user.uuid }]) {
        const { r, core, l } = await deleted(detail);
        expect(r.error, JSON.stringify(detail)).toBeUndefined();
        expect(core.mutations()).toEqual([`DELETE /api/v1/certificates/${l.uuid}`]);
    }
    const kept: Array<[Json, string]> = [
        [{ groups: [{ uuid: group.uuid }, { uuid: 'g-foreign' }] }, 'groups'],
        [{ ownerUuid: 'u-foreign', owner: 'alice' }, 'owner'],
        [{ owner: 'alice' }, 'owner'],
        [{ raProfile: { uuid: 'ra-foreign' } }, 'RA profile'],
        [{ locations: [{ uuid: 'l' }], groups: [{ uuid: group.uuid }] }, 'locations'],
        [{ certificateRequest: { uuid: 'r' } }, 'certificate request'],
    ];
    for (const [detail, why] of kept) {
        const { r, core } = await deleted(detail);
        expect(r.result, JSON.stringify(detail)).toBe('kept');
        expect(r.warnings[0]).toContain(why);
        expect(core.mutations()).toEqual([]);
    }
    // An own group whose line is deleted already, or of another run, is not own: kept.
    const { r } = await deleted({ groups: [{ uuid: group.uuid }] }, [group, { ...group, event: 'deleted', at: '2026-10-13T12:01:00.000Z' }]);
    expect(r.result).toBe('kept');
    // The creation-time rule is unchanged: own attachments do not rescue a certificate made before createdAfter.
    const early = derivedCert();
    const coreEarly = certCore(early, { state: 'revoked', groups: [{ uuid: group.uuid }] }, '2026-10-13T11:00:00.000Z');
    expect((await run(coreEarly, early, [...own, early])).result).toBe('kept');
    // adoptionOf without sets keeps the old answer.
    expect(adoptionOf({ groups: [{ uuid: group.uuid }] })).toEqual(['groups']);
    expect(adoptionOf({ groups: [{ uuid: group.uuid }] }, { groups: new Set([group.uuid]), users: new Set(), raProfiles: new Set() })).toEqual([]);
});

// -------------------------------------------------------------- certificate lifecycle: ungate own RA profiles before the certificate step

// ungateOwnRaProfiles dissociates every own approval profile from every own RA profile (both read live), proven by re-reading;
// foreign RA profiles are left and reported
test('ungateOwnRaProfiles dissociates own approval profiles from own RA profiles; foreign ones reported', async () => {
    const ap = line('approvalProfiles');
    const ra = line('raProfiles');
    const assoc = `/api/v1/approvalProfiles/${ap.uuid}/associations`;
    const rows: Json[] = [{ resource: 'raProfiles', objectUuid: ra.uuid, name: ra.name }, { resource: 'raProfiles', objectUuid: 'ra-foreign', name: 'Pre RA' }, { resource: 'certificates', objectUuid: 'c-1' }];
    const core = new FakeCore()
        .set(`/api/v1/approvalProfiles/${ap.uuid}`, { name: ap.name })
        .set(`/api/v1/raProfiles/${ra.uuid}`, { name: ra.name })
        .route('GET', new RegExp(`^${assoc}$`), () => ({ status: 200, body: rows }))
        .route('DELETE', new RegExp(`^${assoc}/raProfiles/([^/]+)$`), (_p, _d, m) => {
            const i = rows.findIndex((r) => r.objectUuid === m[1]);
            if (i < 0) return { status: 404 };
            rows.splice(i, 1);
            return { status: 204 };
        });
    const warnings: string[] = [];
    const ctx: TeardownContext = { api: core.api(), runId: RUN, ledger: [ap, ra], seen: new Set(), tier: null, warn: (m) => void warnings.push(m), pollMs: 1 };
    await ungateOwnRaProfiles(ctx);
    expect(core.mutations()).toEqual([`DELETE ${assoc}/raProfiles/${ra.uuid}`]);
    expect(warnings).toEqual([expect.stringMatching(/associated with an RA profile that is not this run's .*ra-foreign.*left as it is/)]);
    expect(rows.map((r) => r.objectUuid)).toEqual(['ra-foreign', 'c-1']);
    // A dissociation that does not take is red.
    const stuck = new FakeCore()
        .set(`/api/v1/approvalProfiles/${ap.uuid}`, { name: ap.name }).set(`/api/v1/raProfiles/${ra.uuid}`, { name: ra.name })
        .route('GET', new RegExp(`^${assoc}$`), () => ({ status: 200, body: [{ resource: 'raProfiles', objectUuid: ra.uuid }] }))
        .route('DELETE', /associations/, () => ({ status: 204 }));
    await expect(ungateOwnRaProfiles({ ...ctx, api: stuck.api() })).rejects.toThrow(/still associated/);
    // The hook has nothing to do without own approval profiles AND own RA profiles.
    expect(hasLiveOwn([ap, ra], RUN, 'approvalProfiles') && hasLiveOwn([ap, ra], RUN, 'raProfiles')).toBe(true);
    expect(hasLiveOwn([ap], RUN, 'raProfiles')).toBe(false);
    expect(hasLiveOwn([ap, { ...ap, event: 'deleted' }], RUN, 'approvalProfiles')).toBe(false);
});

// ------------------------------------------------------------------ discoveries

// a discovery records its newly onboarded certificates as derived (server-clock createdAfter), then is deleted
test('a discovery records its newly onboarded certificates as derived, then is deleted', async () => {
    process.env.REG_RUN_ID = RUN;
    // recordDerived refuses an id / parent that is not a canonical uuid, so the fake core answers real ones.
    const d = line('discoveries', { uuid: '00000000-0000-4000-8000-0000000000d1' });
    const INV = '00000000-0000-4000-8000-0000000000d2';
    const KNOWN = '00000000-0000-4000-8000-0000000000d3';
    const core = new FakeCore()
        .set(`/api/v1/discoveries/${d.uuid}`, { uuid: d.uuid, name: d.name, status: 'completed', startTime: '2026-10-13T12:01:00.000Z' })
        .route('GET', /\/certificates$/, () => ({ status: 200, body: { certificates: [{ inventoryUuid: INV }, { inventoryUuid: KNOWN }], totalPages: 1 } }));
    const known = line('certificates', { uuid: KNOWN });
    const { error } = await run(core, d, [d, known]);
    expect(error).toBeUndefined();
    const derived = readLedger().filter((l) => l.derived);
    expect(derived).toEqual([expect.objectContaining({ uuid: INV, runId: RUN, type: 'certificates', createdAfter: '2026-10-13T12:00:58.000Z', parents: { discovery: d.uuid } })]);
    expect(core.mutations()).toEqual([`DELETE /api/v1/discoveries/${d.uuid}`]);
});

// without a server timestamp (no startTime, no Date header on the create answer) the onboarded certificates are still recorded,
// with the keeping bound, so they are kept and reported instead of becoming untracked
test('a discovery without a server timestamp records its certificates with the keeping bound and warns, then is deleted', async () => {
    process.env.REG_RUN_ID = RUN;
    const d = line('discoveries', { uuid: '00000000-0000-4000-8000-0000000000e1' });
    const INV = '00000000-0000-4000-8000-0000000000e2';
    const core = new FakeCore()
        .set(`/api/v1/discoveries/${d.uuid}`, { uuid: d.uuid, name: d.name, status: 'completed' })
        .route('GET', /\/certificates$/, () => ({ status: 200, body: { certificates: [{ inventoryUuid: INV }], totalPages: 1 } }));
    const before = Date.now();
    const { error, warnings } = await run(core, d, [d]);
    expect(error).toBeUndefined();
    const derived = readLedger().filter((l) => l.derived && l.parents?.discovery === d.uuid);
    expect(derived).toEqual([expect.objectContaining({ uuid: INV, type: 'certificates', parents: { discovery: d.uuid } })]);
    expect(Date.parse(derived[0].createdAfter!), 'a bound no certificate can reach').toBeGreaterThan(before + KEEPING_BOUND_AHEAD_MS - 60_000);
    expect(warnings.join('\n')).toMatch(/no server timestamp.*kept/);
    expect(core.mutations()).toEqual([`DELETE /api/v1/discoveries/${d.uuid}`]);
});

/** One discovery that onboarded one new certificate and sits beside a certificate nobody in this run made. */
function discoveryRig(withServerTime: boolean) {
    const discovery = line('discoveries', { uuid: randomUUID() });
    const onboarded = randomUUID();
    const foreign = randomUUID();
    const created = new Date().toISOString();
    const core = new FakeCore()
        .set(`/api/v1/discoveries/${discovery.uuid}`, { uuid: discovery.uuid, name: discovery.name, status: 'completed', ...(withServerTime ? { startTime: new Date(Date.now() - 60_000).toISOString() } : {}) })
        .route('GET', /\/certificates$/, () => ({ status: 200, body: { certificates: [{ inventoryUuid: onboarded }], totalPages: 1 } }))
        .set(`/api/v1/certificates/${onboarded}`, { uuid: onboarded, commonName: 'www.example.org', state: 'revoked' })
        .set(`/api/v1/certificates/${onboarded}/history`, [{ created }])
        .set(`/api/v1/certificates/${foreign}`, { uuid: foreign, commonName: 'somebody-elses.example.org', state: 'issued' })
        .set(`/api/v1/certificates/${foreign}/history`, [{ created: '2020-01-01T00:00:00.000Z' }]);
    return { discovery, onboarded, foreign, core };
}

/** The whole teardown over the ledger file the handlers write to, as the run does. */
const teardownOver = (core: FakeCore, first: LedgerLine[]) =>
    executeTeardown({ tier: null, retryDelayMs: 1, pollMs: 1, runId: RUN, newApi: async () => core.api(), readLines: () => [...first, ...readLedger().filter((l) => l.runId === RUN)], preSteps: [] });

test('no server time: the onboarded certificate of an own discovery lands in the kept report and is not deleted; a foreign one is never touched', async () => {
    process.env.REG_RUN_ID = RUN;
    const { discovery, onboarded, foreign, core } = discoveryRig(false);
    const result = await teardownOver(core, [discovery]);
    expect(result.failed).toEqual([]);
    expect(result.deleted.map((x) => x.type)).toEqual(['discoveries']);
    expect(result.kept.map((x) => `${x.type} ${x.uuid}`)).toEqual([`certificates ${onboarded}`]);
    expect(core.mutations(), 'only the discovery was deleted').toEqual([`DELETE /api/v1/discoveries/${discovery.uuid}`]);
    expect(core.calls.some((c) => c.includes(foreign)), 'a certificate this run did not onboard is not even read').toBe(false);
    writeKeptReport(RUN, result);
    expect(readKeptReport(RUN)?.kept).toEqual([{ type: 'certificates', uuid: onboarded, reasons: [expect.stringMatching(/kept derived certificate/)] }]);
});

test('with the discovery start time the same onboarded certificate is deleted, not kept', async () => {
    process.env.REG_RUN_ID = RUN;
    const { discovery, onboarded, core } = discoveryRig(true);
    const result = await teardownOver(core, [discovery]);
    expect(result.failed).toEqual([]);
    expect(result.kept).toEqual([]);
    expect(result.deleted.map((x) => `${x.type} ${x.uuid}`)).toEqual([`discoveries ${discovery.uuid}`, `certificates ${onboarded}`]);
});

/** One own certificate with its linked `certKey_` key (and, optionally, a second key of the same name that another object uses). */
function keyRig(opts: { history: boolean; foreignKey?: boolean }) {
    const cert = line('certificates', { uuid: randomUUID(), name: `${RUN}-keynet.example.test` });
    const key = randomUUID();
    const foreignKey = randomUUID();
    const wanted = `certKey_${cert.name}`;
    const keyDetail = `/api/v1/keys/${key}`;
    const core = new FakeCore()
        .set(`/api/v1/certificates/${cert.uuid}`, { uuid: cert.uuid, commonName: cert.name, state: 'revoked' })
        .set(keyDetail, { uuid: key, name: wanted, creationTime: new Date().toISOString(), associations: [{ uuid: cert.uuid }] })
        .set(`/api/v1/keys/${foreignKey}`, { uuid: foreignKey, name: wanted, creationTime: new Date().toISOString(), associations: [{ uuid: cert.uuid }, { uuid: randomUUID() }] })
        .route('POST', /^\/api\/v1\/keys$/, () => ({ status: 200, body: { cryptographicKeys: [{ keyWrapperUuid: key, name: wanted }, ...(opts.foreignKey ? [{ keyWrapperUuid: foreignKey, name: wanted }] : [])] } }))
        .route('DELETE', /^\/api\/v1\/certificates\//, (p) => {
            core.store.delete(p);
            const detail = core.store.get(keyDetail);
            if (detail) detail.associations = []; // core unlinks the key when the certificate goes
            return { status: 204 };
        })
        .route('DELETE', /^\/api\/v1\/keys$/, (_p, data) => {
            for (const u of data as string[]) core.store.delete(`/api/v1/keys/${u}`);
            return { status: 204 };
        });
    if (opts.history) core.set(`/api/v1/certificates/${cert.uuid}/history`, [{ created: new Date(Date.now() - 1_000).toISOString() }]);
    return { cert, key, foreignKey, core };
}

test('no server time for the certificate: its certKey_ key lands in the kept report and is not deleted', async () => {
    process.env.REG_RUN_ID = RUN;
    const { cert, key, core } = keyRig({ history: false });
    const result = await teardownOver(core, [cert]);
    expect(result.failed).toEqual([]);
    expect(result.deleted.map((x) => `${x.type} ${x.uuid}`)).toEqual([`certificates ${cert.uuid}`]);
    expect(result.kept.map((x) => `${x.type} ${x.uuid}`)).toEqual([`keys ${key}`]);
    expect(core.calls.filter((c) => c === 'DELETE /api/v1/keys'), 'no key delete was sent').toEqual([]);
    writeKeptReport(RUN, result);
    expect(readKeptReport(RUN)?.kept).toEqual([{ type: 'keys', uuid: key, reasons: [expect.stringMatching(/kept derived key/)] }]);
});

test('with a server time for the certificate the same key is deleted, not kept', async () => {
    process.env.REG_RUN_ID = RUN;
    const { cert, key, core } = keyRig({ history: true });
    const result = await teardownOver(core, [cert]);
    expect(result.failed).toEqual([]);
    expect(result.kept).toEqual([]);
    expect(result.deleted.map((x) => `${x.type} ${x.uuid}`)).toEqual([`certificates ${cert.uuid}`, `keys ${key}`]);
});

test('a key of the same name that another object uses is neither recorded, kept nor deleted, with or without a server time', async ({}, testInfo) => {
    process.env.REG_RUN_ID = RUN;
    for (const history of [false, true]) {
        process.env.REG_STATE_DIR = testInfo.outputPath(`state-${history}`); // a ledger of its own per round
        const { cert, foreignKey, core } = keyRig({ history, foreignKey: true });
        const result = await teardownOver(core, [cert]);
        expect(result.failed).toEqual([]);
        expect(result.kept.some((x) => x.uuid === foreignKey), `history ${history}: not kept`).toBe(false);
        expect(result.deleted.some((x) => x.uuid === foreignKey), `history ${history}: not deleted`).toBe(false);
        expect(readLedger().some((l) => l.uuid === foreignKey), `history ${history}: not in the ledger`).toBe(false);
        expect(core.store.has(`/api/v1/keys/${foreignKey}`), `history ${history}: still on the tier`).toBe(true);
    }
});

// ------------------------------------------------------------------ ACME profiles and accounts

// ACME deactivation loop: deactivated on every own RA profile it is active on, then disabled and deleted
test('ACME deactivation loop: deactivated on each own RA profile, then disabled and deleted', async () => {
    const ra1 = line('raProfiles', { parents: { authority: 'auth-1' } });
    const ra2 = line('raProfiles', { parents: { authority: 'auth-1' } });
    const acme = line('acmeProfiles', { parents: { raProfiles: [ra1.uuid] } });
    const core = new FakeCore()
        .set(`/api/v1/acmeProfiles/${acme.uuid}`, { uuid: acme.uuid, name: acme.name, enabled: true })
        .set(`/api/v1/raProfiles/${ra1.uuid}`, { uuid: ra1.uuid, name: ra1.name, authorityInstanceUuid: 'auth-1' })
        .set(`/api/v1/raProfiles/${ra2.uuid}`, { uuid: ra2.uuid, name: ra2.name, authorityInstanceUuid: 'auth-1' })
        .set(`/api/v1/authorities/auth-1/raProfiles/${ra1.uuid}/protocols/acme`, { acmeAvailable: true, uuid: acme.uuid })
        .set(`/api/v1/authorities/auth-1/raProfiles/${ra2.uuid}/protocols/acme`, { acmeAvailable: true, uuid: acme.uuid })
        .route('PATCH', /\/protocols\/acme\/deactivate$/, () => ({ status: 204 }))
        .route('PATCH', /\/disable$/, () => ({ status: 204 }));
    const { error } = await run(core, acme, [ra1, ra2, acme]);
    expect(error).toBeUndefined();
    expect(core.mutations()).toEqual([
        `PATCH /api/v1/authorities/auth-1/raProfiles/${ra1.uuid}/protocols/acme/deactivate`,
        `PATCH /api/v1/authorities/auth-1/raProfiles/${ra2.uuid}/protocols/acme/deactivate`,
        `PATCH /api/v1/acmeProfiles/${acme.uuid}/disable`,
        `DELETE /api/v1/acmeProfiles/${acme.uuid}`,
    ]);
});

test('a disabled own ACME profile is deleted without a disable call (core refuses to disable it again)', async () => {
    const acme = line('acmeProfiles');
    const core = new FakeCore()
        .set(`/api/v1/acmeProfiles/${acme.uuid}`, { uuid: acme.uuid, name: acme.name, enabled: false })
        .route('PATCH', /\/disable$/, () => ({ status: 422, body: ['ACME profile is already disabled'] }));
    const { error } = await run(core, acme, [acme]);
    expect(error).toBeUndefined();
    expect(core.mutations()).toEqual([`DELETE /api/v1/acmeProfiles/${acme.uuid}`]);
});

test('ACME is never deactivated on a foreign RA profile, even when the line names it as a parent', async () => {
    const acme = line('acmeProfiles', { parents: { raProfiles: ['foreign-ra'] } });
    const core = new FakeCore()
        .set(`/api/v1/acmeProfiles/${acme.uuid}`, { uuid: acme.uuid, name: acme.name })
        .set('/api/v1/raProfiles/foreign-ra', { uuid: 'foreign-ra', name: 'Production RA', authorityInstanceUuid: 'auth-9' })
        .set('/api/v1/authorities/auth-9/raProfiles/foreign-ra/protocols/acme', { acmeAvailable: true, uuid: acme.uuid })
        .route('PATCH', /./, () => ({ status: 204 }));
    const { error } = await run(core, acme);
    expect(error).toBeInstanceOf(OwnObjectViolation);
    expect(core.mutations(), 'no deactivate, no disable, no delete').toEqual([]);
});

// an ACME account goes with its profile: absent from the list and 404 on its detail; still listed → reported
test('an ACME account goes with its profile: absent from list, 404 on detail; still listed is reported', async () => {
    const acc = line('acmeAccounts', { name: `${RUN}-acme-account-xyz`, parents: { acmeProfile: 'acme-1' } });
    const gone = new FakeCore().set('/api/v1/acmeAccounts', []);
    expect((await run(gone, acc)).error).toBeUndefined();
    expect(gone.calls).toEqual(['GET /api/v1/acmeAccounts', `GET /api/v1/acmeProfiles/acme-1/acmeAccounts/${acc.uuid}`]);

    const listed = new FakeCore().set('/api/v1/acmeAccounts', [{ uuid: acc.uuid, status: 'valid' }]);
    expect(String((await run(listed, acc)).error)).toMatch(/still listed \(status valid\)/);

    const noRoute = new FakeCore();
    expect(String((await run(noRoute, acc)).error)).toMatch(/route or object missing/);
});

// ------------------------------------------------------------------ RA profiles, token profiles, users

test('an RA profile is deleted under its authority; absence proven through /raProfiles/{uuid}', async () => {
    const ra = line('raProfiles');
    const core = new FakeCore()
        .set(`/api/v1/raProfiles/${ra.uuid}`, { uuid: ra.uuid, name: ra.name, authorityInstanceUuid: 'auth-2' })
        .route('DELETE', /^\/api\/v1\/authorities\/auth-2\/raProfiles\//, () => {
            core.store.delete(`/api/v1/raProfiles/${ra.uuid}`);
            return { status: 204 };
        });
    expect((await run(core, ra)).error).toBeUndefined();
    expect(core.mutations()).toEqual([`DELETE /api/v1/authorities/auth-2/raProfiles/${ra.uuid}`]);
});

test('a foreign RA profile behind a ledger line is refused', async () => {
    const ra = line('raProfiles');
    const core = new FakeCore().set(`/api/v1/raProfiles/${ra.uuid}`, { uuid: ra.uuid, name: 'EJBCA RA', authorityInstanceUuid: 'auth-2' });
    expect((await run(core, ra)).error).toBeInstanceOf(OwnObjectViolation);
    expect(core.mutations()).toEqual([]);
});

test('a token profile without parents finds its token through the list, then is deleted', async () => {
    const tp = line('tokenProfiles');
    const detail = `/api/v1/tokens/tok-1/tokenProfiles/${tp.uuid}`;
    const core = new FakeCore().set('/api/v1/tokenProfiles', [{ uuid: tp.uuid, tokenInstanceUuid: 'tok-1' }]).set(detail, { uuid: tp.uuid, name: tp.name, tokenInstanceUuid: 'tok-1' });
    expect((await run(core, tp)).error).toBeUndefined();
    expect(core.mutations()).toEqual([`DELETE ${detail}`]);
});

test('a user is removed from its roles first, then deleted', async () => {
    const user = line('users');
    const rolesUrl = `/api/v1/users/${user.uuid}/roles`;
    const core = new FakeCore()
        .set(`/api/v1/users/${user.uuid}`, { uuid: user.uuid, username: user.name })
        .set(rolesUrl, [{ uuid: 'role-a' }])
        .route('PATCH', /\/roles$/, (_p, data) => {
            core.store.set(rolesUrl, (data as string[]).map((uuid) => ({ uuid })));
            return { status: 200 };
        });
    expect((await run(core, user)).error).toBeUndefined();
    expect(core.mutations()).toEqual([`PATCH ${rolesUrl}`, `DELETE /api/v1/users/${user.uuid}`]);
});

// ------------------------------------------------------------------ known bug core#2511 (first live guard proof)

/**
 * A core with the core#2511 behaviour for one type: the detail of a deleted (or unknown) uuid answers 500 instead of
 * 404; the full list (`GET /api/v1/<type>`) answers what is left. `stuck`: the DELETE answers 204 but nothing goes.
 */
function bug2511Core(type: 'roles' | 'users', l: LedgerLine, opts: { stuck?: boolean; alwaysFiveHundred?: boolean; rows?: Json[]; listStatus?: number } = {}): FakeCore {
    const detail = `/api/v1/${type}/${l.uuid}`;
    const nameKey = type === 'users' ? 'username' : 'name';
    const core = new FakeCore().set(detail, { uuid: l.uuid, [nameKey]: l.name });
    if (type === 'users') core.set(`${detail}/roles`, []);
    let deleted = false;
    return core
        .route('GET', new RegExp(`^/api/v1/${type}/[^/]+$`), (p) =>
            (deleted || opts.alwaysFiveHundred || !core.store.has(p) ? { status: 500, body: { message: 'Internal Server Error' } } : { status: 200, body: core.store.get(p) }))
        .route('GET', new RegExp(`^/api/v1/${type}$`), () => ({
            status: opts.listStatus ?? 200,
            // A real list always holds pre-existing rows (an empty list proves nothing).
            body: [...(opts.rows ?? [{ uuid: 'pre-existing-1', [nameKey]: 'pre-existing' }]), ...(core.store.has(detail) ? [core.store.get(detail)!] : [])],
        }))
        .route('DELETE', new RegExp(`^/api/v1/${type}/[^/]+$`), (p) => {
            deleted = true;
            if (!opts.stuck) core.store.delete(p);
            return { status: 204 };
        });
}

// known core defect with role / user detail answering 500: DELETE 204, detail 500, the full list no longer names the role ⇒
// gone; the known bug is reported
test('role / user detail-500 workaround: DELETE 204, detail 500, role absent from the full list means gone', async () => {
    const role = line('roles');
    const core = bug2511Core('roles', role);
    const { error, warnings } = await run(core, role);
    expect(error).toBeUndefined();
    expect(core.calls).toEqual([`GET /api/v1/roles/${role.uuid}`, `DELETE /api/v1/roles/${role.uuid}`, `GET /api/v1/roles/${role.uuid}`, 'GET /api/v1/roles']);
    expect(warnings.join('\n')).toMatch(/known bug core#2511: roles .*detail answered 500 after the delete; absence confirmed through \/api\/v1\/roles/);
});

// core#2511: the full list still names the role ⇒ not deleted (a 5xx is never "gone" by itself)
test('role / user detail-500 workaround: the full list still names the role, so it is not deleted', async () => {
    const role = line('roles');
    const core = bug2511Core('roles', role, { stuck: true });
    const { error } = await run(core, role);
    expect(String(error)).toMatch(/GET answered 500 and \/api\/v1\/roles still lists it: not deleted/);
});

// core#2511: a list at its 1000-row cap, or an unreadable list, proves nothing
test('role / user detail-500 workaround: a list at its 1000-row cap or an unreadable list proves nothing', async () => {
    const role = line('roles');
    const rows = Array.from({ length: 1000 }, (_, i) => ({ uuid: `other-${i}`, name: `role ${i}` }));
    const capped = await run(bug2511Core('roles', role, { rows }), role);
    expect(String(capped.error)).toMatch(/may be truncated and proves nothing/);
    const other = line('roles');
    const unreadable = await run(bug2511Core('roles', other, { listStatus: 503 }), other);
    expect(String(unreadable.error)).toMatch(/the authoritative list \/api\/v1\/roles answered 503/);
});

// the role / user detail-500 workaround is a roles / users exception only: a group whose detail answers 500 after the delete is
// NOT gone, no list is read
test('the detail-500 workaround is for roles and users only: a group with detail 500 is not gone', async () => {
    const group = line('groups');
    const detail = `/api/v1/groups/${group.uuid}`;
    let deleted = false;
    const core: FakeCore = new FakeCore().set(detail, { uuid: group.uuid, name: group.name });
    core
        .route('GET', /^\/api\/v1\/groups\/[^/]+$/, (p): FakeReply => (deleted ? { status: 500 } : { status: 200, body: core.store.get(p) }))
        .route('DELETE', /^\/api\/v1\/groups\//, () => {
            deleted = true;
            return { status: 204 };
        });
    const { error } = await run(core, group);
    expect(String(error)).toMatch(/GET answered 500 \(a 5xx is never proof of absence\): not deleted/);
    expect(core.calls.filter((c) => c === 'GET /api/v1/groups'), 'no list read for a type without an authoritative list').toEqual([]);
});

// core#2511 for users: removed from the roles, deleted, detail 500, absent from GET /api/v1/users ⇒ gone
test('detail-500 workaround for users: removed from roles, deleted, detail 500, absent from list is gone', async () => {
    const user = line('users');
    const core = bug2511Core('users', user);
    const { error, warnings } = await run(core, user);
    expect(error).toBeUndefined();
    expect(core.mutations()).toEqual([`DELETE /api/v1/users/${user.uuid}`]);
    expect(warnings.join('\n')).toMatch(/known bug core#2511: users/);
});

// the role / user detail-500 workaround in the live check: a retry after the first attempt deleted the role is "done"; a detail
// 500 for a listed own role reads the list row
test('detail-500 workaround in the live check: a retry after delete is done; a listed role reads the row', async () => {
    const role = line('roles');
    const core = bug2511Core('roles', role);
    const h = handlerOf('roles')!;
    const notes: string[] = [];
    const ctx: TeardownContext = { api: core.api(), runId: RUN, ledger: [role], seen: new Set(), tier: null, warn: () => undefined, pollMs: 1, knownBug: (n) => void notes.push(`${n.bug} ${n.note}`) };
    await h.remove(ctx, role);
    await expect(h.remove(ctx, role), 'same step: the detail answers 500, the list does not name it ⇒ gone after a 200').resolves.toBeUndefined();
    expect(notes).toEqual([
        expect.stringMatching(/^core#2511 detail answered 500 after the delete; absence confirmed/),
        expect.stringMatching(/^core#2511 detail answered 500; absent from \/api\/v1\/roles/),
    ]);

    // The detail answers 500 for a role that still exists: the list row is the live object (its name is checked), the delete proceeds.
    const listed = line('roles');
    const always = bug2511Core('roles', listed, { alwaysFiveHundred: true });
    expect((await run(always, listed)).error).toBeUndefined();
    expect(always.mutations()).toEqual([`DELETE /api/v1/roles/${listed.uuid}`]);
    // ... and a listed role with a foreign name is refused (the live check holds on the list row too).
    const renamed = line('roles');
    const foreign = bug2511Core('roles', renamed, { alwaysFiveHundred: true });
    foreign.store.set(`/api/v1/roles/${renamed.uuid}`, { uuid: renamed.uuid, name: 'Administrator' });
    const r = await run(foreign, { ...renamed });
    expect(r.error).toBeDefined();
    expect(foreign.mutations()).toEqual([]);
});

test('the own-key handler refuses a blind delete — without a 200 read in this step nothing is sent', async () => {
    const l = line('keys');
    const core = keyCore(l);
    const ctx: TeardownContext = { api: core.api(), runId: RUN, ledger: [l], seen: new Set(), tier: null, warn: () => undefined, pollMs: 1 };
    await expect(teardownHandlers.keys.remove(ctx, l)).rejects.toThrow(/route or object missing/);
    expect(core.calls).toEqual([]);
});

// a key item is "gone with its key" only through a `deleted` keys line of THIS run; another run's line does not explain the 404
test('a key item is gone with its key only through a deleted keys line of this run', async () => {
    const key = line('keys');
    const item = line('keyItems', { name: key.name, parents: { key: key.uuid } });
    const otherRun: LedgerLine = { ...key, runId: 'qa-reg-20261013-120000-zz99', event: 'deleted', at: '2026-10-13T12:30:00.000Z' };
    const r = await run(new FakeCore(), item, [key, item, otherRun]);
    expect(r.error).toBeInstanceOf(LiveObjectMissing);
    const thisRun: LedgerLine = { ...key, event: 'deleted', at: '2026-10-13T12:30:00.000Z' };
    expect((await run(new FakeCore(), item, [key, item, thisRun])).error).toBeUndefined();
});

// ------------------------------------- the certificate-key safety net and the compliance-profile removal (own fake API, so a block scope)

{
    // The fake API of these rows (calls recorded; get / post / delete only).
    interface Call { method: string; url: string; data?: unknown }
    function fakeApi(handler: (c: Call) => { status: number; body?: unknown }) {
        const calls: Call[] = [];
        const reply = (c: Call) => {
            calls.push(c);
            const r = handler(c);
            return fakeResponse(r);
        };
        const api = {
            get: async (url: string) => reply({ method: 'GET', url }),
            post: async (url: string, o?: { data?: unknown }) => reply({ method: 'POST', url, data: o?.data }),
            delete: async (url: string, o?: { data?: unknown }) => reply({ method: 'DELETE', url, data: o?.data }),
        };
        return { api, calls };
    }
    const ctxOf = (api: unknown, ledger: LedgerLine[], warns: string[] = []): TeardownContext =>
        ({ api: partialOf<APIRequestContext>(api as Partial<APIRequestContext>), runId: runId(), ledger, seen: new Set(), tier: null, warn: (m) => warns.push(m), pollMs: 1 });

    const CERT = 'cccccccc-0000-4000-8000-000000000001';
    // Fresh per execution: the unit ledger file persists between runs, and a uuid already in it would count as own.
    const WRAPPER = randomUUID();
    const ITEM = 'eeeeeeee-0000-4000-8000-000000000001';
    const WRAPPER_2 = randomUUID();

    const PROFILE = 'bbbbbbbb-0000-4000-8000-000000000001';
    const FOREIGN_RA = '12121212-0000-4000-8000-000000000001';

    // safety net: the certKey_ key of an own certificate is recorded as a derived line by its WRAPPER uuid (search rows carry item
    // uuids: keyWrapperUuid); an item uuid is never recorded
    test('safety net: the certKey_ key of an own certificate is recorded as derived by its wrapper uuid', async () => {
        const cn = runName('net-1');
        const wanted = `certKey_${cn}`;
        const created = new Date().toISOString();
        const { api, calls } = fakeApi((c) => {
            if (c.url === '/api/v1/keys' && c.method === 'POST') return { status: 200, body: { cryptographicKeys: [{ uuid: ITEM, keyWrapperUuid: WRAPPER, name: wanted }] } };
            if (c.url === `/api/v1/certificates/${CERT}/history`) return { status: 200, body: [{ created }] };
            if (c.url === `/api/v1/keys/${WRAPPER}`) return { status: 200, body: { name: wanted, creationTime: created, associations: [{ uuid: CERT }] } };
            if (c.url === `/api/v1/keys/${ITEM}`) return { status: 404, body: {} };
            return { status: 404, body: {} };
        });
        const line = { type: 'certificates', uuid: CERT, name: cn } as LedgerLine;
        const found = await recordCertKeySafetyNet(ctxOf(api, readLedger()), line, { commonName: cn, key: { uuid: ITEM } });
        expect(found, 'the wrapper, not the item').toEqual([WRAPPER]);
        const recorded = readLedger().filter((l) => l.type === 'keys' && l.event === 'created' && l.uuid === WRAPPER);
        expect(recorded).toHaveLength(1);
        expect(recorded[0]).toMatchObject({ derived: true, name: wanted, parents: { certificate: CERT } });
        expect(recorded[0].createdAfter).toBeTruthy();
        expect(readLedger().some((l) => l.uuid === ITEM), 'the item uuid is not in the ledger').toBe(false);
        expect(calls.some((c) => c.method === 'DELETE'), 'the net only records; the keys step deletes').toBe(false);
    });

    // safety net: a key in a token, a key used by another object, a foreign name and a certificate without a run-prefixed CN record nothing
    test('safety net: keys in a token, used elsewhere, foreign names or non-run CN certificates record nothing', async () => {
        const cn = runName('net-2');
        const created = new Date().toISOString();
        const line = { type: 'certificates', uuid: CERT, name: cn } as LedgerLine;
        const run = async (key: Json, cert: Json = { commonName: cn }): Promise<string[]> => {
            const { api } = fakeApi((c) => {
                if (c.url === '/api/v1/keys') return { status: 200, body: { cryptographicKeys: [] } };
                if (c.url.endsWith('/history')) return { status: 200, body: [{ created }] };
                if (c.url === `/api/v1/keys/${WRAPPER_2}`) return { status: 200, body: key };
                return { status: 404, body: {} };
            });
            return recordCertKeySafetyNet(ctxOf(api, readLedger()), line, { ...cert, key: { uuid: WRAPPER_2 } });
        };
        const base = { name: `certKey_${cn}`, creationTime: created, associations: [{ uuid: CERT }] };
        expect(await run({ ...base, tokenInstanceUuid: 'ffffffff-0000-4000-8000-000000000001' })).toEqual([]);
        expect(await run({ ...base, associations: [{ uuid: CERT }, { uuid: 'abababab-0000-4000-8000-000000000001' }] }), 'used by another object').toEqual([]);
        expect(await run({ ...base, associations: [{ uuid: CERT }, 'abababab-0000-4000-8000-000000000002'] }), 'used by another object, a bare uuid string').toEqual([]);
        expect(await run({ ...base, associations: ['abababab-0000-4000-8000-000000000002'] }), 'only a bare uuid string of another object').toEqual([]);
        expect(await run({ ...base, associations: CERT }), 'associations that are not a list, even the certificate\'s own uuid').toEqual([]);
        expect(await run({ ...base, associations: { uuid: CERT } }), 'associations that are an object').toEqual([]);
        expect(await run({ ...base, name: 'certKey_somebody-elses-cn' })).toEqual([]);
        expect(await run({ ...base, creationTime: new Date(Date.now() - 3_600_000).toISOString() }), 'created long before the certificate').toEqual([]);
        expect(await run(base, { commonName: 'plain.example.test' }), 'no run prefix').toEqual([]);
        expect(readLedger().filter((l) => l.uuid === WRAPPER_2 && l.type === 'keys')).toEqual([]);
    });

    // safety net: an association may be a bare uuid string; the certificate's own bare uuid is its own association, any other counts as use
    test('safety net: a bare-string association of the certificate itself does not count as use, one of another object does', async () => {
        const cn = runName('net-3');
        const wrapper = randomUUID();
        const created = new Date().toISOString();
        const line = { type: 'certificates', uuid: CERT, name: cn } as LedgerLine;
        const { api } = fakeApi((c) => {
            if (c.url === '/api/v1/keys') return { status: 200, body: { cryptographicKeys: [] } };
            if (c.url.endsWith('/history')) return { status: 200, body: [{ created }] };
            if (c.url === `/api/v1/keys/${wrapper}`) return { status: 200, body: { name: `certKey_${cn}`, creationTime: created, associations: [CERT] } };
            return { status: 404, body: {} };
        });
        expect(await recordCertKeySafetyNet(ctxOf(api, readLedger()), line, { commonName: cn, key: { uuid: wrapper } })).toEqual([wrapper]);
    });

    // removeComplianceProfile: own RA associations are removed (a foreign one is not touched), then DELETE /v1; absence by GET
    test('removeComplianceProfile removes own RA associations, then DELETE /v1; absence proven by GET', async () => {
        const ra = recordCreated('raProfiles', { uuid: 'abcabcab-0000-4000-8000-000000000001', name: runName('ra-comp') }, { spec: 'T' });
        let gone = false;
        const { api, calls } = fakeApi((c) => {
            if (c.method === 'GET' && c.url === `/api/v2/complianceProfiles/${PROFILE}/associations`) return { status: 200, body: [{ resource: 'raProfiles', objectUuid: ra.uuid }, { resource: 'raProfiles', objectUuid: FOREIGN_RA }] };
            if (c.method === 'DELETE' && c.url.includes('/associations/')) return { status: 204 };
            if (c.method === 'DELETE' && c.url === `/api/v1/complianceProfiles/${PROFILE}`) { gone = true; return { status: 204 }; }
            if (c.method === 'GET' && c.url === `/api/v1/complianceProfiles/${PROFILE}`) return gone ? { status: 404, body: {} } : { status: 200, body: {} };
            return { status: 404, body: {} };
        });
        const ctx = ctxOf(api, readLedger());
        ctx.seen.add(PROFILE);
        await removeComplianceProfile(ctx, PROFILE);
        const deletes = calls.filter((c) => c.method === 'DELETE').map((c) => c.url);
        expect(deletes).toEqual([`/api/v2/complianceProfiles/${PROFILE}/associations/raProfiles/${ra.uuid}`, `/api/v1/complianceProfiles/${PROFILE}`]);
    });

    // removeComplianceProfile: a refused v1 delete falls back to DELETE /v2/complianceProfiles/force [uuid]; a non-empty
    // BulkActionMessageDto list is a failure with its messages
    test('removeComplianceProfile: a refused v1 delete falls back to the v2 force delete; bulk messages fail', async () => {
        const run = async (forceBody: unknown) => {
            let gone = false;
            const { api, calls } = fakeApi((c) => {
                if (c.url.endsWith('/associations')) return { status: 200, body: [] };
                if (c.method === 'DELETE' && c.url === `/api/v1/complianceProfiles/${PROFILE}`) return { status: 422, body: { message: 'v1 refused' } };
                if (c.method === 'DELETE' && c.url === '/api/v2/complianceProfiles/force') { if (Array.isArray(forceBody) && !forceBody.length) gone = true; return { status: 200, body: forceBody }; }
                if (c.method === 'GET') return gone ? { status: 404, body: {} } : { status: 200, body: {} };
                return { status: 404, body: {} };
            });
            const ctx = ctxOf(api, readLedger());
            ctx.seen.add(PROFILE);
            return { calls, promise: removeComplianceProfile(ctx, PROFILE) };
        };
        const ok = await run([]);
        await ok.promise;
        expect(ok.calls.find((c) => c.url === '/api/v2/complianceProfiles/force')?.data).toEqual([PROFILE]);
        const refused = await run([{ uuid: PROFILE, name: 'own-profile', message: 'Object is associated with other items' }]);
        await expect(refused.promise).rejects.toThrow(/v1 refused.*Object is associated with other items/);
    });

    // the v2 force delete is NOT sent while a foreign association remains (force removes every association); the failure is
    // blocked, names it, and nothing foreign is touched
    test('the v2 force delete is not sent while a foreign association remains; the failure is blocked', async () => {
        const ra = recordCreated('raProfiles', { uuid: randomUUID(), name: runName('ra-comp-f1') }, { spec: 'T' });
        const foreign = '34343434-0000-4000-8000-000000000001';
        const { api, calls } = fakeApi((c) => {
            if (c.method === 'GET' && c.url.endsWith('/associations')) return { status: 200, body: [{ resource: 'raProfiles', objectUuid: ra.uuid }, { resource: 'raProfiles', objectUuid: foreign }] };
            if (c.method === 'DELETE' && c.url.includes('/associations/')) return { status: 204 };
            if (c.method === 'DELETE' && c.url === `/api/v1/complianceProfiles/${PROFILE}`) return { status: 422, body: { message: 'has associations' } };
            if (c.method === 'GET') return { status: 200, body: {} };
            return { status: 404, body: {} };
        });
        const ctx = ctxOf(api, readLedger());
        ctx.seen.add(PROFILE);
        await expect(removeComplianceProfile(ctx, PROFILE)).rejects.toMatchObject({ message: expect.stringMatching(/foreign association left as is/), blockedBy: expect.stringContaining(PROFILE) });
        expect(calls.some((c) => c.url === '/api/v2/complianceProfiles/force'), 'no force while a foreign association remains').toBe(false);
        expect(calls.filter((c) => c.method === 'DELETE' && c.url.includes('/associations/')).map((c) => c.url)).toEqual([`/api/v2/complianceProfiles/${PROFILE}/associations/raProfiles/${ra.uuid}`]);
    });

    test('an unreadable association list also blocks the force delete', async () => {
        const { api, calls } = fakeApi((c) => {
            if (c.method === 'GET' && c.url.endsWith('/associations')) return { status: 500, body: {} };
            if (c.method === 'DELETE' && c.url === `/api/v1/complianceProfiles/${PROFILE}`) return { status: 422, body: {} };
            return { status: 200, body: {} };
        });
        const ctx = ctxOf(api, readLedger());
        ctx.seen.add(PROFILE);
        await expect(removeComplianceProfile(ctx, PROFILE)).rejects.toThrow(/associations cannot be read/);
        expect(calls.some((c) => c.url === '/api/v2/complianceProfiles/force')).toBe(false);
    });

    test('the safety net searches the key list with CKI_NAME and warns (not silently skips) on a non-ok answer', async () => {
        const cn = runName('net-f2');
        const bodies: Json[] = [];
        const { api } = fakeApi((c) => {
            if (c.url === '/api/v1/keys' && c.method === 'POST') { bodies.push(c.data as Json); return { status: 400, body: { message: 'unknown field' } }; }
            if (c.url.endsWith('/history')) return { status: 200, body: [{ created: new Date().toISOString() }] };
            return { status: 404, body: {} };
        });
        const warns: string[] = [];
        await recordCertKeySafetyNet(ctxOf(api, readLedger(), warns), { type: 'certificates', uuid: CERT, name: cn } as LedgerLine, { commonName: cn });
        expect(bodies[0].filters[0]).toMatchObject({ fieldIdentifier: 'CKI_NAME', condition: 'EQUALS', value: `certKey_${cn}` });
        expect(warns.some((w) => /key search by name answered 400/.test(w))).toBe(true);
    });

    // the CN must carry THIS run's prefix (a key named certKey_<unprefixed CN> is never recorded; another run family is not this run)
    test('the CN must carry this run prefix: an unprefixed certKey_ key is never recorded', async () => {
        const created = new Date().toISOString();
        const keyFor = (cn: string): Json => ({ name: `certKey_${cn}`, creationTime: created, associations: [{ uuid: CERT }] });
        const w = randomUUID();
        const attempt = async (cn: string): Promise<string[]> => {
            const { api } = fakeApi((c) => (c.url === `/api/v1/keys/${w}` ? { status: 200, body: keyFor(cn) } : c.url.endsWith('/history') ? { status: 200, body: [{ created }] } : { status: 404, body: {} }));
            return recordCertKeySafetyNet(ctxOf(api, readLedger()), { type: 'certificates', uuid: CERT, name: cn } as LedgerLine, { commonName: cn, key: { uuid: w } });
        };
        expect(await attempt('plain.example.test')).toEqual([]);
        expect(await attempt('qa-reg-20200101-000000-zzzz-other-run.example.test'), 'another run id').toEqual([]);
        expect(await attempt(runName('net-f3'))).toEqual([w]);
    });

    test('an empty history falls back to the server date of the ledger line for the time bound, not to now', async () => {
        const cn = runName('net-f4');
        const w = randomUUID();
        const lineServerDate = new Date(Date.now() - 2 * 3_600_000).toISOString();
        const keyCreated = new Date(Date.now() - 2 * 3_600_000 + 5_000).toISOString(); // made right after the line's server date, hours before "now"
        const { api } = fakeApi((c) => (c.url === `/api/v1/keys/${w}` ? { status: 200, body: { name: `certKey_${cn}`, creationTime: keyCreated, associations: [{ uuid: CERT }] } } : c.url.endsWith('/history') ? { status: 200, body: [] } : { status: 404, body: {} }));
        const found = await recordCertKeySafetyNet(ctxOf(api, readLedger()), { type: 'certificates', uuid: CERT, name: cn, serverAt: lineServerDate } as LedgerLine, { commonName: cn, key: { uuid: w } });
        expect(found).toEqual([w]);
        expect(readLedger().find((l) => l.uuid === w && l.type === 'keys')?.createdAfter).toBe(new Date(Date.parse(lineServerDate) - 60_000).toISOString());
    });

    // the clock rule: without a server time (no history, no server date on the line) the age cannot be judged; the key is recorded
    // with the keeping bound, so it is kept and reported; the runner's clock (the line's own `at`) is never the basis
    test('safety net: with no server time for the certificate the key is recorded with the keeping bound, whatever the runner clock says', async () => {
        const cn = runName('net-f5');
        const w = randomUUID();
        const { api } = fakeApi((c) => (c.url === `/api/v1/keys/${w}` ? { status: 200, body: { name: `certKey_${cn}`, creationTime: new Date().toISOString(), associations: [{ uuid: CERT }] } } : c.url.endsWith('/history') ? { status: 200, body: [] } : c.url === '/api/v1/keys' ? { status: 200, body: { cryptographicKeys: [] } } : { status: 404, body: {} }));
        const warns: string[] = [];
        const ctx = ctxOf(api, readLedger(), warns);
        const before = Date.now();
        const found = await recordCertKeySafetyNet(ctx, { type: 'certificates', uuid: CERT, name: cn, at: new Date().toISOString() } as LedgerLine, { commonName: cn, key: { uuid: w } });
        expect(found).toEqual([w]);
        expect(warns.join('\n')).toMatch(/no server time.*kept/);
        const recorded = readLedger().filter((l) => l.uuid === w);
        expect(recorded).toEqual([expect.objectContaining({ type: 'keys', derived: true, parents: { certificate: CERT } })]);
        expect(Date.parse(recorded[0].createdAfter!), 'a bound no key can reach').toBeGreaterThan(before + KEEPING_BOUND_AHEAD_MS - 60_000);
    });

    // no server time does not loosen the other conditions: a key in a token, used by another object or named otherwise is still not
    // recorded
    test('safety net: with no server time a key that fails the other conditions is still not recorded', async () => {
        const cn = runName('net-f6');
        const run = async (key: Json): Promise<string[]> => {
            const w = randomUUID();
            const { api } = fakeApi((c) => (c.url === `/api/v1/keys/${w}` ? { status: 200, body: key } : c.url.endsWith('/history') ? { status: 200, body: [] } : { status: 404, body: {} }));
            return recordCertKeySafetyNet(ctxOf(api, readLedger()), { type: 'certificates', uuid: CERT, name: cn } as LedgerLine, { commonName: cn, key: { uuid: w } });
        };
        const base = { name: `certKey_${cn}`, creationTime: new Date().toISOString(), associations: [{ uuid: CERT }] };
        expect(await run({ ...base, tokenInstanceUuid: 'ffffffff-0000-4000-8000-000000000001' })).toEqual([]);
        expect(await run({ ...base, associations: [{ uuid: CERT }, { uuid: 'abababab-0000-4000-8000-000000000001' }] })).toEqual([]);
        expect(await run({ ...base, name: 'certKey_somebody-elses-cn' })).toEqual([]);
        expect(await run(base), 'the control: all conditions met').toHaveLength(1);
    });

    // dangling association: a 404 on the compliance profile DELETE is NOT "gone" when the profile is still found: blocked, named,
    // and no force is sent; a 404 confirmed by the re-read is done
    test('dangling association: a 404 on the profile DELETE is not gone while the profile is still found', async () => {
        const run = async (stillThere: boolean) => {
            const { api, calls } = fakeApi((c) => {
                if (c.method === 'GET' && c.url.endsWith('/associations')) return { status: 200, body: [] };
                if (c.method === 'DELETE' && c.url === `/api/v1/complianceProfiles/${PROFILE}`) return { status: 404, body: { message: 'RA profile not found' } };
                if (c.method === 'GET' && c.url === `/api/v1/complianceProfiles/${PROFILE}`) return stillThere ? { status: 200, body: { uuid: PROFILE } } : { status: 404, body: {} };
                return { status: 404, body: {} };
            });
            const ctx = ctxOf(api, readLedger());
            ctx.seen.add(PROFILE);
            return { calls, promise: removeComplianceProfile(ctx, PROFILE) };
        };
        const dangling = await run(true);
        await expect(dangling.promise).rejects.toMatchObject({ message: expect.stringMatching(/dangling association.*suspected product defect.*left as is/), blockedBy: expect.stringContaining(PROFILE) });
        expect(dangling.calls.some((c) => c.url === '/api/v2/complianceProfiles/force'), 'never a force path').toBe(false);
        const gone = await run(false);
        await gone.promise;
        expect(gone.calls.some((c) => c.url === '/api/v2/complianceProfiles/force')).toBe(false);
    });
}
