/**
 * Unit tests that drive EVERY B0 teardown handler (utils/regression/teardownHandlers.ts, as runTeardown loads it:
 * wrapped by guardHandler) against a fake core (review R18). They pin the behaviour the reviews asked for:
 * - R6: the live object is read first; a ledger line whose live object is foreign (renamed, a foreign RA profile with
 *   the ACME profile active) is refused, nothing is deleted or deactivated;
 * - R5: a DELETE counts only when a GET afterwards answers 404; a 404 counts as done only after a 200 in the same step
 *   (a wrong route never passes as "deleted"); a 2xx DELETE that leaves the object in place is a failure;
 * - R2: a discovery-derived certificate is kept and reported when adopted (RA profile, owner, groups, locations,
 *   request) or created before createdAfter (earliest history event, server clock);
 * - m5: the revoke falls back to the certificate's own RA profile when the line has no parents;
 * - the ACME deactivation loop, the derived key kept / deleted, ACME accounts going with their profile, users removed
 *   from their roles first (R24), the discovery's derived lines with a server-clock createdAfter (R17);
 * - known bug core#2511 (B0 fix pass 3): a role / user whose detail answers 500 after the DELETE is gone only when the
 *   authoritative full list no longer names it (reported as a known bug); a 5xx alone, a capped or unreadable list,
 *   or any other type's 5xx is never "gone".
 */
import { APIRequestContext, test, expect } from '@playwright/test';
import { DryRunRefusal } from '../../utils/regression/flags';
import { LiveObjectMissing, OwnObjectViolation } from '../../utils/regression/ownObjects';
import { LedgerLine, readLedger } from '../../utils/regression/regressionRun';
import { handlerFor, TeardownContext, TeardownHandler } from '../../utils/regression/runTeardown';
import { adoptionOf, hasLiveOwn, teardownHandlers, ungateOwnRaProfiles } from '../../utils/regression/teardownHandlers';

const RUN = 'qa-reg-20261013-120000-ab12';
type Json = Record<string, any>;

interface Reply {
    status: number;
    body?: unknown;
}

/** An in-memory core: detail URLs in `store`, extra routes per method + path pattern, every call recorded. */
class FakeCore {
    store = new Map<string, Json>();
    calls: string[] = [];
    private routes: Array<{ method: string; match: RegExp; reply: (path: string, data: unknown, m: RegExpExecArray) => Reply }> = [];

    set(path: string, body: Json): this {
        this.store.set(path, body);
        return this;
    }

    route(method: string, match: RegExp, reply: (path: string, data: unknown, m: RegExpExecArray) => Reply): this {
        this.routes.push({ method, match, reply });
        return this;
    }

    private handle(method: string, url: string, data: unknown): Reply {
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
        const resp = (r: Reply) => ({
            status: () => r.status,
            ok: () => r.status >= 200 && r.status < 300,
            json: async () => r.body,
            text: async () => JSON.stringify(r.body ?? ''),
        });
        const call = (method: string) => async (url: string, opts?: { data?: unknown }) => resp(this.handle(method, url, opts?.data));
        return {
            get: call('GET'),
            post: call('POST'),
            patch: call('PATCH'),
            put: call('PUT'),
            delete: call('DELETE'),
            fetch: async (url: string, opts?: { method?: string; data?: unknown }) => resp(this.handle((opts?.method ?? 'GET').toUpperCase(), url, opts?.data)),
            dispose: async () => undefined,
        } as unknown as APIRequestContext;
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

const ENV_KEYS = ['REG_STATE_DIR', 'REG_RUN_ID', 'API_TEARDOWN_DRY_RUN'];
let saved: Record<string, string | undefined> = {};
test.beforeEach(({}, testInfo) => {
    saved = Object.fromEntries(ENV_KEYS.map((k) => [k, process.env[k]]));
    for (const k of ENV_KEYS) delete process.env[k];
    process.env.REG_STATE_DIR = testInfo.outputPath('state');
});
test.afterEach(() => {
    for (const [k, v] of Object.entries(saved)) {
        if (v === undefined) delete process.env[k];
        else process.env[k] = v;
    }
});

/** Runs a handler the way executeTeardown does for one object; returns the result, the warnings and the error. */
async function run(core: FakeCore, l: LedgerLine, ledger: LedgerLine[] = [l]): Promise<{ result?: string | void; warnings: string[]; error?: unknown }> {
    const h = handlerFor(l.type) as TeardownHandler;
    expect(h, `handler for ${l.type}`).toBeTruthy();
    const warnings: string[] = [];
    const ctx: TeardownContext = { api: core.api(), runId: RUN, ledger, seen: new Set(), tier: null, warn: (m) => void warnings.push(m), pollMs: 1 };
    try {
        return { result: await h.remove(ctx, l), warnings };
    } catch (error) {
        return { warnings, error };
    }
}

// ------------------------------------------------------------------ R5 / R6 basics (a byUrl type)

test('a role is read live, deleted, and its absence proven by GET', async () => {
    const role = line('roles');
    const core = new FakeCore().set(`/api/v1/roles/${role.uuid}`, { uuid: role.uuid, name: role.name });
    const { error } = await run(core, role);
    expect(error).toBeUndefined();
    expect(core.calls).toEqual([`GET /api/v1/roles/${role.uuid}`, `DELETE /api/v1/roles/${role.uuid}`, `GET /api/v1/roles/${role.uuid}`]);
});

test('404 without a prior 200 in the step is "route or object missing", never "deleted" (R5)', async () => {
    const role = line('roles');
    const core = new FakeCore(); // a wrong route or a vanished object: GET answers 404
    const { error } = await run(core, role);
    expect(error).toBeInstanceOf(LiveObjectMissing);
    expect(String(error)).toMatch(/route or object missing/);
    expect(core.mutations(), 'no DELETE was sent').toEqual([]);
});

test('a DELETE answering 404 after a 200 read counts (the object went away in between); the GET still proves it', async () => {
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

test('the second attempt of attemptCleanup sees the object gone after the first deleted it: done, not "missing"', async () => {
    const role = line('roles');
    const core = new FakeCore().set(`/api/v1/roles/${role.uuid}`, { name: role.name });
    const h = handlerFor('roles')!;
    const ctx: TeardownContext = { api: core.api(), runId: RUN, ledger: [role], seen: new Set(), tier: null, warn: () => undefined, pollMs: 1 };
    await h.remove(ctx, role);
    await expect(h.remove(ctx, role), 'same step (same seen set): gone after a 200').resolves.toBeUndefined();
});

test('a ledger line whose live object is foreign (renamed) is refused, nothing deleted (R6)', async () => {
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

test('the dry run stops a handler at its entry, before any request (R4)', async () => {
    process.env.API_TEARDOWN_DRY_RUN = 'on';
    const role = line('roles');
    const core = new FakeCore().set(`/api/v1/roles/${role.uuid}`, { name: role.name });
    const { error } = await run(core, role);
    expect(error).toBeInstanceOf(DryRunRefusal);
    expect(core.calls).toEqual([]);
});

// ------------------------------------------------------------------ certificates (m5 revoke fallback, R2)

test('an issued certificate without parents is revoked through its own RA profile (m5), then deleted', async () => {
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
        .set(`/api/v1/certificates/${l.uuid}/history`, [{ created: '2026-10-13T12:30:00.000Z' }, { created: firstEvent }] as unknown as Json);
}

test('a discovered certificate someone adopted is kept and reported (R2)', async () => {
    for (const adoption of [{ raProfile: { uuid: 'ra-1' } }, { owner: 'alice' }, { groups: [{ uuid: 'g' }] }, { locations: [{ uuid: 'l' }] }, { certificateRequest: { uuid: 'r' } }]) {
        const l = derivedCert();
        const core = certCore(l, adoption, '2026-10-13T12:05:00.000Z');
        const { result, warnings } = await run(core, l);
        expect(result, JSON.stringify(adoption)).toBe('kept');
        expect(warnings[0]).toMatch(/kept derived certificate .*: adopted/);
        expect(core.mutations()).toEqual([]);
    }
});

test('a discovered certificate created before createdAfter is kept; one created after it is deleted (R2)', async () => {
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

    // Q6: an unknown creation time is not "kept" quietly: the handler fails (red), nothing is deleted.
    const noHistory = derivedCert();
    const coreNone = new FakeCore().set(`/api/v1/certificates/${noHistory.uuid}`, { commonName: 'x', state: 'revoked' });
    const none = await run(coreNone, noHistory);
    expect(String(none.error), 'no creation time: cannot prove it, red').toMatch(/creation time unknown/);
    expect(coreNone.mutations()).toEqual([]);
});

test('a derived key without a creation time fails instead of being kept (Q6)', async () => {
    const l = line('keys', { name: 'certKey_x', derived: true, createdAfter: '2026-10-13T12:00:00.000Z' });
    const core = new FakeCore().set(`/api/v1/keys/${l.uuid}`, { uuid: l.uuid, name: 'certKey_x', associations: [] });
    const r = await run(core, l);
    expect(String(r.error)).toMatch(/creation time unknown/);
    expect(core.mutations()).toEqual([]);
});

// ------------------------------------------------------------------ keys

test('a derived key in a token, made before createdAfter or still used is kept; an orphan made after it is deleted', async () => {
    const mk = (body: Json) => {
        const l = line('keys', { name: 'certKey_x', derived: true, createdAfter: '2026-10-13T12:00:00.000Z' });
        const core = new FakeCore().set(`/api/v1/keys/${l.uuid}`, { uuid: l.uuid, name: 'certKey_x', creationTime: '2026-10-13T12:10:00.000Z', associations: [], ...body });
        return { l, core };
    };
    for (const body of [{ tokenInstanceUuid: 't-1' }, { creationTime: '2026-10-13T11:00:00.000Z' }, { associations: [{ uuid: 'c' }] }]) {
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

// ------------------------------------------------------------------ own token keys (guard-integration pass: protocols G-PROT-1 / review F5)

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

test('an own token key with active items is deleted by the one keys handler (bulk DELETE /v1/keys), absence proven by GET; the derived rule is untouched', async () => {
    const l = line('keys');
    const core = keyCore(l);
    const r = await run(core, l);
    expect(r.error).toBeUndefined();
    expect(r.result).toBeUndefined();
    expect(core.calls).toEqual([`GET /api/v1/keys/${l.uuid}`, 'DELETE /api/v1/keys', `GET /api/v1/keys/${l.uuid}`]);
    expect(core.store.has(`/api/v1/keys/${l.uuid}`)).toBe(false);
});

test('a refused key delete deactivates and destroys the items first, then deletes again; a second refusal is red', async () => {
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

test('a foreign key behind a keys line is refused by the live check: nothing is sent (R6); a stuck 204 is "not deleted"', async () => {
    const foreign = line('keys');
    const core = keyCore(foreign, { name: 'hsm-production-key' });
    const r = await run(core, foreign);
    expect(r.error).toBeInstanceOf(OwnObjectViolation);
    expect(core.mutations()).toEqual([]);
    const stuck = line('keys');
    const coreStuck = new FakeCore().set(`/api/v1/keys/${stuck.uuid}`, { name: stuck.name }).route('DELETE', /^\/api\/v1\/keys$/, () => ({ status: 204 }));
    expect(String((await run(coreStuck, stuck)).error)).toMatch(/not deleted \(absence not proven\)/);
});

// ------------------------------------------------------------------ key items (platform G-1): gone with their key

test('a key item whose key has a `deleted` line of this run is done when its live read answers 404; a remaining item is reported, blocked by its key', async () => {
    const key = line('keys');
    const item = line('keyItems', { name: key.name, parents: { key: key.uuid } });
    const keyDeleted: LedgerLine = { ...key, event: 'deleted', at: '2026-10-13T12:30:00.000Z' };
    const core = new FakeCore();
    const gone = await run(core, item, [key, item, keyDeleted]);
    expect(gone.error).toBeUndefined();
    expect(core.calls).toEqual([`GET /api/v1/keys/${key.uuid}/items/${item.uuid}`]);
    // No `deleted` line for the key: the 404 is "route or object missing" (R5), never silently done.
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

// ------------------------------------------------------------------ GD-05: own-trigger adoption of discovered certificates

test('GD-05: a derived certificate attached only to OWN groups / owner / RA profile is deleted; any foreign attachment, a location or a request keeps it', async () => {
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

// ------------------------------------------------------------------ cert-lifecycle G2: ungate own RA profiles before the certificate step

test('ungateOwnRaProfiles dissociates every own approval profile from every own RA profile (both read live), proven by re-reading; foreign RA profiles are left and reported', async () => {
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

// ------------------------------------------------------------------ discoveries (R17)

test('a discovery records its newly onboarded certificates as derived (server-clock createdAfter), then is deleted', async () => {
    process.env.REG_RUN_ID = RUN;
    // Fix pass 5: recordDerived refuses an id / parent that is not a canonical uuid, so the fake core answers real ones.
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

// ------------------------------------------------------------------ ACME profiles and accounts

test('ACME deactivation loop: deactivated on every own RA profile it is active on, then disabled and deleted', async () => {
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

test('a disabled own ACME profile is deleted without a disable call (core refuses to disable it again, Q9)', async () => {
    const acme = line('acmeProfiles');
    const core = new FakeCore()
        .set(`/api/v1/acmeProfiles/${acme.uuid}`, { uuid: acme.uuid, name: acme.name, enabled: false })
        .route('PATCH', /\/disable$/, () => ({ status: 422, body: ['ACME profile is already disabled'] }));
    const { error } = await run(core, acme, [acme]);
    expect(error).toBeUndefined();
    expect(core.mutations()).toEqual([`DELETE /api/v1/acmeProfiles/${acme.uuid}`]);
});

test('ACME is never deactivated on a foreign RA profile, even when the line names it as a parent (R6)', async () => {
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

test('an ACME account goes with its profile: absent from the list and 404 on its detail; still listed → reported', async () => {
    const acc = line('acmeAccounts', { name: `${RUN}-acme-account-xyz`, parents: { acmeProfile: 'acme-1' } });
    const gone = new FakeCore().set('/api/v1/acmeAccounts', [] as unknown as Json);
    expect((await run(gone, acc)).error).toBeUndefined();
    expect(gone.calls).toEqual(['GET /api/v1/acmeAccounts', `GET /api/v1/acmeProfiles/acme-1/acmeAccounts/${acc.uuid}`]);

    const listed = new FakeCore().set('/api/v1/acmeAccounts', [{ uuid: acc.uuid, status: 'valid' }] as unknown as Json);
    expect(String((await run(listed, acc)).error)).toMatch(/still listed \(status valid\)/);

    const noRoute = new FakeCore();
    expect(String((await run(noRoute, acc)).error)).toMatch(/route or object missing/);
});

// ------------------------------------------------------------------ RA profiles, token profiles, users (R24)

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

test('a foreign RA profile behind a ledger line is refused (R6)', async () => {
    const ra = line('raProfiles');
    const core = new FakeCore().set(`/api/v1/raProfiles/${ra.uuid}`, { uuid: ra.uuid, name: 'EJBCA RA', authorityInstanceUuid: 'auth-2' });
    expect((await run(core, ra)).error).toBeInstanceOf(OwnObjectViolation);
    expect(core.mutations()).toEqual([]);
});

test('a token profile without parents finds its token through the list, then is deleted', async () => {
    const tp = line('tokenProfiles');
    const detail = `/api/v1/tokens/tok-1/tokenProfiles/${tp.uuid}`;
    const core = new FakeCore().set('/api/v1/tokenProfiles', [{ uuid: tp.uuid, tokenInstanceUuid: 'tok-1' }] as unknown as Json).set(detail, { uuid: tp.uuid, name: tp.name, tokenInstanceUuid: 'tok-1' });
    expect((await run(core, tp)).error).toBeUndefined();
    expect(core.mutations()).toEqual([`DELETE ${detail}`]);
});

test('a user is removed from its roles first, then deleted (R24)', async () => {
    const user = line('users');
    const rolesUrl = `/api/v1/users/${user.uuid}/roles`;
    const core = new FakeCore()
        .set(`/api/v1/users/${user.uuid}`, { uuid: user.uuid, username: user.name })
        .set(rolesUrl, [{ uuid: 'role-a' }] as unknown as Json)
        .route('PATCH', /\/roles$/, (_p, data) => {
            core.store.set(rolesUrl, (data as string[]).map((uuid) => ({ uuid })) as unknown as Json);
            return { status: 200 };
        });
    expect((await run(core, user)).error).toBeUndefined();
    expect(core.mutations()).toEqual([`PATCH ${rolesUrl}`, `DELETE /api/v1/users/${user.uuid}`]);
});

// ------------------------------------------------------------------ known bug core#2511 (B0 fix pass 3, first live guard proof)

/**
 * A core with the core#2511 behaviour for one type: the detail of a deleted (or unknown) uuid answers 500 instead of
 * 404; the full list (`GET /api/v1/<type>`) answers what is left. `stuck`: the DELETE answers 204 but nothing goes.
 */
function bug2511Core(type: 'roles' | 'users', l: LedgerLine, opts: { stuck?: boolean; alwaysFiveHundred?: boolean; rows?: Json[]; listStatus?: number } = {}): FakeCore {
    const detail = `/api/v1/${type}/${l.uuid}`;
    const nameKey = type === 'users' ? 'username' : 'name';
    const core = new FakeCore().set(detail, { uuid: l.uuid, [nameKey]: l.name });
    if (type === 'users') core.set(`${detail}/roles`, [] as unknown as Json);
    let deleted = false;
    return core
        .route('GET', new RegExp(`^/api/v1/${type}/[^/]+$`), (p) =>
            (deleted || opts.alwaysFiveHundred || !core.store.has(p) ? { status: 500, body: { message: 'Internal Server Error' } } : { status: 200, body: core.store.get(p) }))
        .route('GET', new RegExp(`^/api/v1/${type}$`), () => ({
            status: opts.listStatus ?? 200,
            // A real list always holds pre-existing rows (fix pass 4: an empty list proves nothing).
            body: [...(opts.rows ?? [{ uuid: 'pre-existing-1', [nameKey]: 'pre-existing' }]), ...(core.store.has(detail) ? [core.store.get(detail)!] : [])],
        }))
        .route('DELETE', new RegExp(`^/api/v1/${type}/[^/]+$`), (p) => {
            deleted = true;
            if (!opts.stuck) core.store.delete(p);
            return { status: 204 };
        });
}

test('core#2511: DELETE 204, detail 500, the full list no longer names the role ⇒ gone; the known bug is reported', async () => {
    const role = line('roles');
    const core = bug2511Core('roles', role);
    const { error, warnings } = await run(core, role);
    expect(error).toBeUndefined();
    expect(core.calls).toEqual([`GET /api/v1/roles/${role.uuid}`, `DELETE /api/v1/roles/${role.uuid}`, `GET /api/v1/roles/${role.uuid}`, 'GET /api/v1/roles']);
    expect(warnings.join('\n')).toMatch(/known bug core#2511: roles .*detail answered 500 after the delete; absence confirmed through \/api\/v1\/roles/);
});

test('core#2511: the full list still names the role ⇒ not deleted (a 5xx is never "gone" by itself)', async () => {
    const role = line('roles');
    const core = bug2511Core('roles', role, { stuck: true });
    const { error } = await run(core, role);
    expect(String(error)).toMatch(/GET answered 500 and \/api\/v1\/roles still lists it: not deleted/);
});

test('core#2511: a list at its 1000-row cap, or an unreadable list, proves nothing', async () => {
    const role = line('roles');
    const rows = Array.from({ length: 1000 }, (_, i) => ({ uuid: `other-${i}`, name: `role ${i}` }));
    const capped = await run(bug2511Core('roles', role, { rows }), role);
    expect(String(capped.error)).toMatch(/may be truncated and proves nothing/);
    const other = line('roles');
    const unreadable = await run(bug2511Core('roles', other, { listStatus: 503 }), other);
    expect(String(unreadable.error)).toMatch(/the authoritative list \/api\/v1\/roles answered 503/);
});

test('core#2511 is a roles / users exception only: a group whose detail answers 500 after the delete is NOT gone, no list is read', async () => {
    const group = line('groups');
    const detail = `/api/v1/groups/${group.uuid}`;
    let deleted = false;
    const core: FakeCore = new FakeCore().set(detail, { uuid: group.uuid, name: group.name });
    core
        .route('GET', /^\/api\/v1\/groups\/[^/]+$/, (p): Reply => (deleted ? { status: 500 } : { status: 200, body: core.store.get(p) }))
        .route('DELETE', /^\/api\/v1\/groups\//, () => {
            deleted = true;
            return { status: 204 };
        });
    const { error } = await run(core, group);
    expect(String(error)).toMatch(/GET answered 500 \(a 5xx is never proof of absence\): not deleted/);
    expect(core.calls.filter((c) => c === 'GET /api/v1/groups'), 'no list read for a type without an authoritative list').toEqual([]);
});

test('core#2511 for users: removed from the roles, deleted, detail 500, absent from GET /api/v1/users ⇒ gone', async () => {
    const user = line('users');
    const core = bug2511Core('users', user);
    const { error, warnings } = await run(core, user);
    expect(error).toBeUndefined();
    expect(core.mutations()).toEqual([`DELETE /api/v1/users/${user.uuid}`]);
    expect(warnings.join('\n')).toMatch(/known bug core#2511: users/);
});

test('core#2511 in the live check: a retry after the first attempt deleted the role is "done"; a detail 500 for a listed own role reads the list row', async () => {
    const role = line('roles');
    const core = bug2511Core('roles', role);
    const h = handlerFor('roles')!;
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
    // ... and a listed role with a foreign name is refused (R6 holds on the list row too).
    const renamed = line('roles');
    const foreign = bug2511Core('roles', renamed, { alwaysFiveHundred: true });
    foreign.store.set(`/api/v1/roles/${renamed.uuid}`, { uuid: renamed.uuid, name: 'Administrator' });
    const r = await run(foreign, { ...renamed });
    expect(r.error).toBeDefined();
    expect(foreign.mutations()).toEqual([]);
});

test('review X07: the own-key handler refuses a blind delete — without a 200 read in this step nothing is sent (R5)', async () => {
    const l = line('keys');
    const core = keyCore(l);
    const ctx: TeardownContext = { api: core.api(), runId: RUN, ledger: [l], seen: new Set(), tier: null, warn: () => undefined, pollMs: 1 };
    await expect(teardownHandlers.keys.remove(ctx, l)).rejects.toThrow(/route or object missing/);
    expect(core.calls).toEqual([]);
});

test('review X12: a key item is "gone with its key" only through a `deleted` keys line of THIS run; another run\'s line does not explain the 404', async () => {
    const key = line('keys');
    const item = line('keyItems', { name: key.name, parents: { key: key.uuid } });
    const otherRun: LedgerLine = { ...key, runId: 'qa-reg-20261013-120000-zz99', event: 'deleted', at: '2026-10-13T12:30:00.000Z' };
    const r = await run(new FakeCore(), item, [key, item, otherRun]);
    expect(r.error).toBeInstanceOf(LiveObjectMissing);
    const thisRun: LedgerLine = { ...key, event: 'deleted', at: '2026-10-13T12:30:00.000Z' };
    expect((await run(new FakeCore(), item, [key, item, thisRun])).error).toBeUndefined();
});
