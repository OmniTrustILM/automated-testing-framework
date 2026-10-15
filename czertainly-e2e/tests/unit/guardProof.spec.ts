/**
 * Unit tests for the live guard proof's safety net (review Q1) and the runtime half of the deny-by-default rule (Q2),
 * against a fake raw context that records every request it receives:
 * - the blocking spy forwards GET / HEAD only (fix pass 3) and REFUSES everything else (post / put / patch / delete,
 *   fetch with any other method — also from a Request object — and unknown methods): it never reaches the raw context;
 * - the proof's composition: a guarded helper handed a pre-existing RA profile disguised as an OwnRef (guard layer
 *   removed on purpose) and the guarded PATCH / DELETE fail with an OwnObjectViolation of kind `ownership` — also under
 *   the dry run — and nothing is sent; a regressed guard shows up as SpyBlockedRequest, a refusal for the runtime brand
 *   as kind `not-guarded`: `ownershipRefusal` accepts neither;
 * - `apiJson` sends a mutating method only through a guarded context (requireGuarded), a raw one may GET and POST to
 *   the allow-list only.
 */
import { APIRequestContext, test, expect } from '@playwright/test';
import { guardApi, GuardedApi } from '../../utils/regression/guardedApi';
import { blockingSpy, ownershipRefusal, SpyBlockedRequest } from '../../utils/regression/guardProof';
import { OwnObjectViolation } from '../../utils/regression/ownObjects';
import { apiJson, enableOwnRaProfile } from '../../utils/regression/regressionApi';
import { OwnRef, regName } from '../../utils/regression/regressionRun';

const FOREIGN_RA = '00000000-0000-4000-8000-000000000002';
const AUTH = '00000000-0000-4000-8000-000000000009';

/** A raw context that answers every request 200 and records what reached it. */
function raw(): { api: APIRequestContext; reached: string[] } {
    const reached: string[] = [];
    const reply = (body: unknown = {}) => ({ status: () => 200, ok: () => true, json: async () => body, text: async () => JSON.stringify(body), headers: () => ({}) });
    const record = (method: string) => async (url: string) => {
        reached.push(`${method} ${url}`);
        return reply({ name: 'Production RA', uuid: FOREIGN_RA });
    };
    const api = {
        get: record('GET'), head: record('HEAD'), post: record('POST'), put: record('PUT'), patch: record('PATCH'), delete: record('DELETE'),
        options: record('OPTIONS'),
        fetch: async (url: string | { url(): string; method(): string }, opts: { method?: string } = {}) => {
            const u = typeof url === 'string' ? url : url.url();
            reached.push(`${(opts.method ?? (typeof url === 'string' ? 'GET' : url.method())).toUpperCase()} ${u}`);
            return reply();
        },
        dispose: async () => undefined,
    } as unknown as APIRequestContext;
    return { api, reached };
}

const ENV_KEYS = ['API_TEARDOWN_DRY_RUN', 'REG_STATE_DIR', 'TIER_KIND', 'BASE_URL'];
let saved: Record<string, string | undefined> = {};
test.beforeEach(({}, testInfo) => {
    saved = Object.fromEntries(ENV_KEYS.map((k) => [k, process.env[k]]));
    for (const k of ENV_KEYS) delete process.env[k];
    process.env.REG_STATE_DIR = testInfo.outputPath('state'); // an empty ledger: nothing is own
    process.env.TIER_KIND = 'shared';
});
test.afterEach(() => {
    for (const [k, v] of Object.entries(saved)) {
        if (v === undefined) delete process.env[k];
        else process.env[k] = v;
    }
});

test('the spy forwards reads and refuses every mutating request without sending it (Q1)', async () => {
    const r = raw();
    const spy = blockingSpy(r.api);
    await spy.api.get(`/api/v1/raProfiles/${FOREIGN_RA}`);
    await spy.api.fetch(`/api/v1/raProfiles/${FOREIGN_RA}`);
    await spy.api.fetch(`/api/v1/raProfiles/${FOREIGN_RA}`, { method: 'HEAD' });
    await expect(spy.api.patch(`/api/v1/authorities/${AUTH}/raProfiles/${FOREIGN_RA}/disable`)).rejects.toThrow(SpyBlockedRequest);
    await expect(spy.api.delete(`/api/v1/authorities/${AUTH}/raProfiles/${FOREIGN_RA}`)).rejects.toThrow(SpyBlockedRequest);
    await expect(spy.api.post('/api/v1/roles')).rejects.toThrow(SpyBlockedRequest);
    await expect(spy.api.put('/api/v1/roles/x')).rejects.toThrow(SpyBlockedRequest);
    await expect(spy.api.fetch('/api/v1/roles/x', { method: 'delete' })).rejects.toThrow(SpyBlockedRequest);
    const request = { url: () => '/api/v1/roles/y', method: () => 'PATCH' };
    await expect(spy.api.fetch(request as unknown as string)).rejects.toThrow(SpyBlockedRequest);
    // Fix pass 3: GET / HEAD only — any other verb, and any method the spy does not know, is refused too.
    await expect(spy.api.fetch('/api/v1/roles', { method: 'OPTIONS' })).rejects.toThrow(SpyBlockedRequest);
    await expect((spy.api as unknown as { options(u: string): Promise<unknown> }).options('/api/v1/roles')).rejects.toThrow(SpyBlockedRequest);
    await spy.api.dispose();
    expect(r.reached, 'only the reads reached the raw context').toEqual([
        `GET /api/v1/raProfiles/${FOREIGN_RA}`, `GET /api/v1/raProfiles/${FOREIGN_RA}`, `HEAD /api/v1/raProfiles/${FOREIGN_RA}`,
    ]);
    expect(spy.mutations).toEqual([
        `PATCH /api/v1/authorities/${AUTH}/raProfiles/${FOREIGN_RA}/disable`, `DELETE /api/v1/authorities/${AUTH}/raProfiles/${FOREIGN_RA}`,
        'POST /api/v1/roles', 'PUT /api/v1/roles/x', 'DELETE /api/v1/roles/x', 'PATCH (request object)', 'OPTIONS /api/v1/roles', 'OPTIONS /api/v1/roles',
    ]);
});

test('the proof: helper and guarded PATCH / DELETE refuse a pre-existing RA profile with OwnObjectViolation, also under the dry run (Q1, Q15)', async () => {
    for (const dryRun of [false, true]) {
        if (dryRun) process.env.API_TEARDOWN_DRY_RUN = '1';
        const r = raw();
        const watched = blockingSpy(r.api);
        const forged = { uuid: FOREIGN_RA, name: regName('forged'), kind: 'own' } as OwnRef;
        expect((await ownershipRefusal(enableOwnRaProfile(watched.api as unknown as GuardedApi, AUTH, forged))).uuid).toBe(FOREIGN_RA);
        const guarded = guardApi(watched.api);
        expect((await ownershipRefusal(guarded.patch(`/api/v1/authorities/${AUTH}/raProfiles/${FOREIGN_RA}/disable`))).reason).toMatch(/no ledger "created" line/);
        expect((await ownershipRefusal(guarded.delete(`/api/v1/authorities/${AUTH}/raProfiles/${FOREIGN_RA}`))).kind).toBe('ownership');
        expect(watched.mutations, `dry run ${dryRun}: nothing reached the spy`).toEqual([]);
        expect(r.reached.filter((x) => !x.startsWith('GET ')), `dry run ${dryRun}: nothing mutating reached the raw context`).toEqual([]);
    }
});

test('a regressed guard is caught: the spy refuses with SpyBlockedRequest, which is not the OwnObjectViolation the proof requires (Q1)', async () => {
    const r = raw();
    const watched = blockingSpy(r.api);
    // A "guard" that forwards everything (the regression the proof must survive).
    const broken = watched.api;
    const attempt = broken.patch(`/api/v1/authorities/${AUTH}/raProfiles/${FOREIGN_RA}/disable`);
    await expect(attempt).rejects.toThrow(SpyBlockedRequest);
    await expect(broken.delete(`/api/v1/authorities/${AUTH}/raProfiles/${FOREIGN_RA}`)).rejects.not.toBeInstanceOf(OwnObjectViolation);
    expect(watched.mutations).toHaveLength(2);
    expect(r.reached, 'and still nothing was sent').toEqual([]);
});

test('ownershipRefusal accepts only an ownership refusal: not a pass, not the spy, not the runtime brand (fix pass 3)', async () => {
    const r = raw();
    const watched = blockingSpy(r.api);
    await expect(ownershipRefusal(Promise.resolve('sent')), 'not refused').rejects.toThrow(/was not refused/);
    await expect(ownershipRefusal(watched.api.patch('/api/v1/roles/x')), 'a regressed guard').rejects.toThrow(/expected an ownership refusal, got SpyBlockedRequest/);
    // A helper whose ownership check was skipped would still hit requireGuarded (the brand): that is NOT the proof.
    await expect(ownershipRefusal(apiJson(watched.api, 'PATCH', `/api/v1/authorities/${AUTH}/raProfiles/${FOREIGN_RA}/disable`)), 'the brand')
        .rejects.toThrow(/refused for not-guarded/);
    await expect(ownershipRefusal(guardApi(watched.api).put('/api/v1/settings/platform', { data: {} })), 'a platform rule').rejects.toThrow(/refused for request/);
    expect(r.reached.filter((x) => !x.startsWith('GET '))).toEqual([]);
});

test('apiJson: a raw context may GET and POST to the allow-list; any other method needs the guarded context (Q2)', async () => {
    const r = raw();
    await apiJson(r.api, 'GET', '/api/v1/roles');
    await apiJson(r.api, 'POST', '/api/v1/certificates', { filters: [] });
    await expect(apiJson(r.api, 'PATCH', `/api/v1/authorities/${AUTH}/raProfiles/${FOREIGN_RA}/disable`)).rejects.toThrow(/needs the guarded API context/);
    await expect(apiJson(r.api, 'DELETE', '/api/v1/roles/x')).rejects.toThrow(OwnObjectViolation);
    await expect(apiJson(r.api, 'POST', `/api/v1/certificates/${FOREIGN_RA}/renew`)).rejects.toThrow(OwnObjectViolation);
    // Fix pass 3: a create needs the guard too (its body is checked there).
    await expect(apiJson(r.api, 'POST', '/api/v1/roles', { name: 'x', userUuids: [FOREIGN_RA] })).rejects.toThrow(/needs the guarded API context/);
    expect(r.reached).toEqual(['GET /api/v1/roles', 'POST /api/v1/certificates']);
    // Through the guard the same PATCH is judged on ownership (a foreign RA profile: refused, not sent).
    await expect(apiJson(guardApi(r.api), 'PATCH', `/api/v1/authorities/${AUTH}/raProfiles/${FOREIGN_RA}/disable`)).rejects.toThrow(/no ledger "created" line/);
    expect(r.reached).toHaveLength(2);
});
