/**
 * Unit tests for the guarded API context (reviews R7a, Q1, Q3, Q5, Q7, Q13, Q15, Q16; B0 fix pass 3: body vectors,
 * reference fields, query / params, origin, platform deny-list, localStack needs the proof) against a fake raw context: GET
 * always passes; POST passes on the create / search / attribute-validation allow-list; PUT / PATCH / DELETE and any
 * other POST reach the server only when every uuid they name — in the path and in the body's association lists — is own
 * (ledger line of this run + live run-prefixed name); scope parents in the PATH may be foreign, never in a body; bulk
 * bodies must name own uuids; derived objects are refused; ownership is checked before the dry run; encoded or dotted
 * paths are refused; probe uuids are accepted; the ledger, run id and tier come from the process unless a unit test
 * injects them through `guardApiForUnitTests`. A refused request is never sent.
 */
import { APIRequestContext, test, expect } from '@playwright/test';
import * as fs from 'fs';
import { DryRunRefusal } from '../../utils/regression/flags';
import {
    allowListedPost, apiPathOf, associationUuids, bodyUuids, canonicalUuid, guardApi, guardApiForUnitTests, isAllowedPost, isGuardedApi, isRawPostAllowed,
    isUuidLike, originProblem, platformDenied, postKind, queryUuids, readBody, requireGuarded, stringFindings, targetUuids, unsafePath, uuidTokens,
} from '../../utils/regression/guardedApi';
import { OwnObjectViolation } from '../../utils/regression/ownObjects';
import { LedgerLine } from '../../utils/regression/regressionRun';
import { localProofFile, tierIdentity } from '../../utils/regression/tier';

const RUN = 'qa-reg-20261013-120000-ab12';
const U = (n: number) => `00000000-0000-4000-8000-${String(n).padStart(12, '0')}`;
const OWN_RA = U(1);
const FOREIGN_RA = U(2);
const OWN_ROLE = U(3);
const RENAMED_ROLE = U(4);
const AUTH = U(9);
const OWN_CERT = U(5);
const OWN_USER = U(6);
const FOREIGN_USER = U(10);
const DERIVED_KEY = U(11);
const ATTRIBUTE_DEF = U(12);
const OWN_GROUP = U(13);
const FOREIGN_GROUP = U(14);
const CONNECTOR = U(15);
const OWN_TRIGGER = U(16);

const lines: LedgerLine[] = [
    { at: 'a', runId: RUN, type: 'raProfiles', name: `${RUN}-ra`, uuid: OWN_RA, spec: 'T', event: 'created' },
    { at: 'a', runId: RUN, type: 'roles', name: `${RUN}-role`, uuid: OWN_ROLE, spec: 'T', event: 'created' },
    { at: 'a', runId: RUN, type: 'roles', name: `${RUN}-role-2`, uuid: RENAMED_ROLE, spec: 'T', event: 'created' },
    { at: 'a', runId: RUN, type: 'certificates', name: `${RUN}.example.test`, uuid: OWN_CERT, spec: 'T', event: 'created' },
    { at: 'a', runId: RUN, type: 'users', name: `${RUN}-user`, uuid: OWN_USER, spec: 'T', event: 'created' },
    { at: 'a', runId: RUN, type: 'keys', name: 'certKey_x', uuid: DERIVED_KEY, spec: 'T', derived: true, createdAfter: '2026-10-13T00:00:00Z', event: 'created' },
    { at: 'a', runId: RUN, type: 'groups', name: `${RUN}-group`, uuid: OWN_GROUP, spec: 'T', event: 'created' },
    { at: 'a', runId: RUN, type: 'triggers', name: `${RUN}-trigger`, uuid: OWN_TRIGGER, spec: 'T', event: 'created' },
];

const live: Record<string, Record<string, unknown>> = {
    [`/api/v1/raProfiles/${OWN_RA}`]: { name: `${RUN}-ra` },
    [`/api/v1/raProfiles/${FOREIGN_RA}`]: { name: 'Production RA' },
    [`/api/v1/roles/${OWN_ROLE}`]: { name: `${RUN}-role` },
    [`/api/v1/roles/${RENAMED_ROLE}`]: { name: 'Administrators' },
    [`/api/v1/certificates/${OWN_CERT}`]: { commonName: `${RUN}.example.test` },
    [`/api/v1/users/${OWN_USER}`]: { username: `${RUN}-user` },
    [`/api/v1/users/${FOREIGN_USER}`]: { username: 'alice' },
    [`/api/v1/keys/${DERIVED_KEY}`]: { name: 'certKey_x' },
    [`/api/v1/groups/${OWN_GROUP}`]: { name: `${RUN}-group` },
    [`/api/v1/groups/${FOREIGN_GROUP}`]: { name: 'Production servers' },
    [`/api/v1/workflows/triggers/${OWN_TRIGGER}`]: { name: `${RUN}-trigger` },
};

/** A raw context: GETs answer from `live`, every non-GET is recorded and answered 200. */
function raw(): { api: APIRequestContext; sent: string[] } {
    const sent: string[] = [];
    const reply = (status: number, body?: unknown) => ({ status: () => status, ok: () => status < 300, json: async () => body, text: async () => '' });
    const api = {
        get: async (url: string) => (live[url] ? reply(200, live[url]) : reply(404)),
        head: async () => reply(200),
        fetch: async (url: string, opts: { method?: string } = {}) => {
            sent.push(`${(opts.method ?? 'GET').toUpperCase()} ${url}`);
            return reply(200, {});
        },
        dispose: async () => undefined,
        storageState: async () => ({ cookies: [], origins: [] }),
    } as unknown as APIRequestContext;
    return { api, sent };
}

const seams = { lines, runId: RUN, tier: null, env: {} as NodeJS.ProcessEnv };

test('path helpers: the API path, the allow-list, scope parents, bulk bodies and unsafe paths', () => {
    expect(apiPathOf('/api/v1/roles?x=1')).toBe('/v1/roles');
    expect(apiPathOf('https://host.example/api/v2/operations/x/')).toBe('/v2/operations/x');
    expect(apiPathOf('/administrator/#/x')).toBeUndefined();
    expect(isAllowedPost('/v1/roles')).toBe(true);
    expect(isAllowedPost(`/v2/operations/authorities/${AUTH}/raProfiles/${FOREIGN_RA}/certificates`), 'issue under any RA profile').toBe(true);
    expect(isAllowedPost('/v1/certificates'), 'certificate search').toBe(true);
    expect(isAllowedPost(`/v2/operations/authorities/${AUTH}/raProfiles/${OWN_RA}/certificates/${OWN_CERT}/revoke`), 'revoke is a mutation').toBe(false);
    expect(targetUuids(`/v1/authorities/${AUTH}/raProfiles/${OWN_RA}`)).toEqual([OWN_RA]);
    expect(targetUuids(`/v2/operations/authorities/${AUTH}/raProfiles/${FOREIGN_RA}/certificates/${OWN_CERT}/revoke`)).toEqual([OWN_CERT]);
    expect(targetUuids(`/v1/authorities/${AUTH}/raProfiles/${OWN_RA}/protocols/acme/activate/${U(7)}`), 'an activation targets both').toEqual([OWN_RA, U(7)]);
    expect(targetUuids(`/v1/users/${U(8)}/roles/${OWN_ROLE}`), 'an association targets both').toEqual([U(8), OWN_ROLE]);
    expect(bodyUuids([OWN_ROLE])).toEqual([OWN_ROLE]);
    expect(bodyUuids({ uuids: [OWN_ROLE] })).toEqual([OWN_ROLE]);
    expect(bodyUuids({ uuids: [OWN_ROLE], filters: [] }), 'filters are never accepted').toBeUndefined();
    expect(bodyUuids([]), 'an empty list is "everything" on some endpoints').toBeUndefined();
    expect(bodyUuids({ filters: [] })).toBeUndefined();
    expect(unsafePath(`/api/v1/roles/${OWN_ROLE}`)).toBeUndefined();
    expect(unsafePath(`https://h.example/api/v1/roles/${OWN_ROLE}?q=%20`), 'a query may be encoded').toBeUndefined();
    expect(unsafePath('/api/v1/roles%2F1')).toMatch(/encoded/);
    expect(unsafePath('/api/v1/roles/x/../1')).toMatch(/dot segment/);
    expect(unsafePath('/api/v1//roles/1')).toMatch(/empty segment/);
    expect(unsafePath('/api/v1/roles;a=b/1')).toMatch(/semicolon/); // fix pass 6: the shared rule names it
});

test('/validate is allow-listed for attribute validations only; a certificate\'s own validate is a mutation (Q7)', () => {
    expect(isAllowedPost(`/v1/authorities/${AUTH}/attributes/raProfile/validate`)).toBe(true);
    expect(isAllowedPost(`/v1/tokens/${AUTH}/tokenProfile/attributes/validate`)).toBe(true);
    expect(isAllowedPost(`/v1/entities/${AUTH}/attributes/location/validate`)).toBe(true);
    expect(isAllowedPost(`/v1/connectors/${AUTH}/authorityProvider/ejbca/validate`)).toBe(true);
    expect(isAllowedPost(`/v1/certificates/${FOREIGN_RA}/validate`)).toBe(false);
    expect(isAllowedPost('/v1/certificates/validate')).toBe(false);
});

test('GET and allow-listed POSTs pass without a check', async () => {
    const r = raw();
    const g = guardApiForUnitTests(r.api, seams);
    expect((await g.get(`/api/v1/raProfiles/${FOREIGN_RA}`)).status()).toBe(200);
    await g.post('/api/v1/roles', { data: { name: `${RUN}-x` } });
    await g.post('/api/v1/certificates', { data: { itemsPerPage: 10, pageNumber: 1, filters: [] } });
    await g.fetch('/api/v1/discoveries/list', { method: 'POST', data: {} });
    expect(r.sent).toEqual(['POST /api/v1/roles', 'POST /api/v1/certificates', 'POST /api/v1/discoveries/list']);
});

test('mutations of own objects pass; a scope parent may be foreign', async () => {
    const r = raw();
    const g = guardApiForUnitTests(r.api, seams);
    await g.patch(`/api/v1/authorities/${AUTH}/raProfiles/${OWN_RA}/enable`);
    await g.delete(`/api/v1/roles/${OWN_ROLE}`);
    await g.post(`/api/v2/operations/authorities/${AUTH}/raProfiles/${FOREIGN_RA}/certificates/${OWN_CERT}/revoke`, { data: { reason: 'unspecified' } });
    expect(r.sent).toEqual([
        `PATCH /api/v1/authorities/${AUTH}/raProfiles/${OWN_RA}/enable`,
        `DELETE /api/v1/roles/${OWN_ROLE}`,
        `POST /api/v2/operations/authorities/${AUTH}/raProfiles/${FOREIGN_RA}/certificates/${OWN_CERT}/revoke`,
    ]);
});

test('a foreign target, a renamed own uuid, a foreign association partner and a filter body are refused and never sent', async () => {
    const r = raw();
    const g = guardApiForUnitTests(r.api, seams);
    await expect(g.patch(`/api/v1/authorities/${AUTH}/raProfiles/${FOREIGN_RA}/disable`)).rejects.toThrow(OwnObjectViolation);
    await expect(g.delete(`/api/v1/roles/${RENAMED_ROLE}`), 'ledger line, but the live name is foreign').rejects.toThrow(/live name does not start with/);
    await expect(g.patch(`/api/v1/authorities/${AUTH}/raProfiles/${OWN_RA}/protocols/acme/activate/${U(7)}`), 'unknown ACME profile').rejects.toThrow(OwnObjectViolation);
    await expect(g.fetch(`/api/v1/roles/${FOREIGN_RA}`, { method: 'PUT', data: {} })).rejects.toThrow(OwnObjectViolation);
    await expect(g.delete('/api/v1/keys', { data: { filters: [] } }), 'bulk delete by filter').rejects.toThrow(/a bulk body with filters/);
    await expect(g.patch('/api/v1/certificates', { data: { certificateUuids: [OWN_CERT], filters: [] } }), 'a list next to filters').rejects.toThrow(/a bulk body with filters/);
    // Fix pass 5 (F2): DELETE /v1/keys is an allow-listed bulk route whose body IS the uuid list (List<String>).
    await expect(g.delete('/api/v1/keys', { data: {} }), 'no list at all').rejects.toThrow(/takes a uuid list/);
    await expect(g.patch('/api/v1/certificates', { data: { certificateUuids: [OWN_CERT, FOREIGN_RA] } }), 'a *Uuids bulk list with a foreign uuid').rejects.toThrow(OwnObjectViolation);
    await expect(g.patch('/api/v1/acmeProfiles/disable', { data: [OWN_ROLE, FOREIGN_RA] }), 'one foreign uuid in a bulk body').rejects.toThrow(OwnObjectViolation);
    await expect(g.post(`/api/v1/certificates/${FOREIGN_RA}/renew`), 'a non-allow-listed POST is a mutation').rejects.toThrow(OwnObjectViolation);
    await expect(g.post(`/api/v1/certificates/${FOREIGN_RA}/validate`), 'a certificate\'s own validate (Q7)').rejects.toThrow(OwnObjectViolation);
    await expect(g.put('/other/endpoint'), 'outside the ILM API').rejects.toThrow(/outside the ILM API/);
    expect(r.sent).toEqual([]);
});

test('body associations must be own: PATCH /v1/roles/{own}/users [foreign] is refused, scope parents never apply to bodies (Q3)', async () => {
    const r = raw();
    const g = guardApiForUnitTests(r.api, seams);
    await expect(g.patch(`/api/v1/roles/${OWN_ROLE}/users`, { data: [FOREIGN_USER] }), 'a foreign user handed the own role').rejects.toThrow(OwnObjectViolation);
    await expect(g.patch(`/api/v1/users/${OWN_USER}/roles`, { data: [FOREIGN_RA] })).rejects.toThrow(OwnObjectViolation);
    await expect(g.put(`/api/v1/roles/${OWN_ROLE}`, { data: { name: 'x', userUuids: [OWN_USER, FOREIGN_USER] } }), 'a *Uuids field').rejects.toThrow(OwnObjectViolation);
    await expect(g.patch(`/api/v1/complianceProfiles/${OWN_ROLE}/raProfiles/associate`, { data: { uuids: [FOREIGN_RA] } }), 'a uuids field').rejects.toThrow(OwnObjectViolation);
    await expect(g.post(`/api/v1/roles/${OWN_ROLE}/x`, { data: { nested: { raProfileUuids: FOREIGN_RA } } }), 'a single uuid in a *Uuids field').rejects.toThrow(OwnObjectViolation);
    await expect(g.patch(`/api/v1/authorities/${AUTH}/raProfiles/${OWN_RA}/x`, { data: [AUTH] }), 'the path\'s scope parent named in the body').rejects.toThrow(OwnObjectViolation);
    expect(r.sent).toEqual([]);
    await g.patch(`/api/v1/roles/${OWN_ROLE}/users`, { data: [OWN_USER] });
    await g.patch(`/api/v1/users/${OWN_USER}/roles`, { data: [] });
    await g.patch('/api/v1/certificates', { data: { certificateUuids: [OWN_CERT] } });
    // Attribute payloads are not associations: definition uuids and content stay out of the check.
    await g.put(`/api/v1/roles/${OWN_ROLE}`, { data: { name: 'x', customAttributes: [{ uuid: ATTRIBUTE_DEF, name: 'a', content: [{ data: FOREIGN_RA }] }], attributes: [{ uuid: ATTRIBUTE_DEF }] } });
    const probe = g.probeUuid();
    await g.patch(`/api/v1/roles/${OWN_ROLE}/users`, { data: [probe] });
    expect(r.sent).toEqual([
        `PATCH /api/v1/roles/${OWN_ROLE}/users`, `PATCH /api/v1/users/${OWN_USER}/roles`, 'PATCH /api/v1/certificates', `PUT /api/v1/roles/${OWN_ROLE}`,
        `PATCH /api/v1/roles/${OWN_ROLE}/users`,
    ]);
    expect(associationUuids({ a: [OWN_ROLE], b: { roleUuids: [OWN_USER, 'not-a-uuid'] }, customAttributes: [{ uuid: ATTRIBUTE_DEF }], issueCertificateAttributes: [[AUTH]] }))
        .toEqual([OWN_ROLE, OWN_USER]);
});

test('a derived object is refused: only the run-end teardown removes it (Q5)', async () => {
    const r = raw();
    const g = guardApiForUnitTests(r.api, seams);
    await expect(g.delete('/api/v1/keys', { data: [DERIVED_KEY] })).rejects.toThrow(/derived object/);
    await expect(g.patch(`/api/v1/keys/${DERIVED_KEY}/disable`)).rejects.toThrow(OwnObjectViolation);
    expect(r.sent).toEqual([]);
});

test('ownership before the dry run: a foreign DELETE is an OwnObjectViolation under the dry run too, an own one a DryRunRefusal (Q1, Q15)', async () => {
    const r = raw();
    const g = guardApiForUnitTests(r.api, { ...seams, env: { API_TEARDOWN_DRY_RUN: '1' } });
    await expect(g.delete(`/api/v1/authorities/${AUTH}/raProfiles/${FOREIGN_RA}`)).rejects.toThrow(OwnObjectViolation);
    await expect(g.delete(`/api/v1/roles/${OWN_ROLE}`)).rejects.toThrow(DryRunRefusal);
    const free = guardApiForUnitTests(r.api, seams);
    const probe = free.probeUuid();
    await free.delete(`/api/v1/roles/${probe}`);
    expect(r.sent).toEqual([`DELETE /api/v1/roles/${probe}`]);
    await expect(free.check('DELETE', `/api/v1/roles/${FOREIGN_RA}`)).rejects.toThrow(OwnObjectViolation);
});

test('encoded, dotted and empty path segments are refused for every mutating method (Q16)', async () => {
    const r = raw();
    const g = guardApiForUnitTests(r.api, seams);
    await expect(g.delete(`/api/v1/roles/${OWN_ROLE}%2F..%2F${FOREIGN_RA}`)).rejects.toThrow(/encoded/);
    await expect(g.delete(`/api/v1/roles/${OWN_ROLE}/../${FOREIGN_RA}`)).rejects.toThrow(/dot segment/);
    await expect(g.post('/api/v1/roles%2Fx')).rejects.toThrow(/encoded/);
    await expect(g.patch(`/api/v1//roles/${OWN_ROLE}`)).rejects.toThrow(/empty segment/);
    expect(() => allowListedPost('/api/v1/roles%2F1')).toThrow(OwnObjectViolation);
    // Fix pass 4: a raw POST goes to BASE_URL's origin only, unless it carries no credentials (the ACME client).
    const acme = 'https://h.example/api/v1/protocols/acme/raProfile/x/new-order';
    expect(allowListedPost(acme, { env: { BASE_URL: 'https://h.example/administrator/' } })).toBe(acme);
    expect(() => allowListedPost(acme, { env: { BASE_URL: 'https://other.example/' } })).toThrow(/origin is not BASE_URL/);
    expect(() => allowListedPost(acme, { env: {} }), 'BASE_URL unset').toThrow(/BASE_URL is unset/);
    expect(allowListedPost(acme, { env: { BASE_URL: 'https://other.example/' }, unauthenticated: true })).toBe(acme);
    expect(() => allowListedPost(`/api/v1/certificates/${OWN_CERT}/renew`)).toThrow(/not a read-only or protocol POST/);
    // Fix pass 3: a raw context may not create (the guard checks a create's body); searches and protocol traffic only.
    expect(() => allowListedPost('/api/v1/roles')).toThrow(/a create goes through the guarded context/);
    expect(allowListedPost('/api/v1/certificates')).toBe('/api/v1/certificates');
    expect([postKind('/v1/roles'), postKind('/v1/certificates'), postKind('/v1/protocols/acme/x/new-order'), postKind(`/v1/certificates/${OWN_CERT}/renew`)])
        .toEqual(['create', 'read', 'protocol', undefined]);
    expect([isRawPostAllowed('/v1/roles'), isRawPostAllowed('/v1/keys'), isAllowedPost('/v1/roles')]).toEqual([false, true, true]);
    // A uuid segment in Java's lenient form would name an object the guard does not recognise.
    expect(unsafePath('/api/v1/roles/a-b-c-d-e')).toMatch(/non-canonical uuid/);
    await expect(g.delete('/api/v1/roles/3-0-4000-8000-3')).rejects.toThrow(/non-canonical uuid/);
    expect(r.sent).toEqual([]);
});

/** A local env with this run's local-backend proof written (fix pass 3: localStack needs it). */
function provenLocalEnv(dir: string, extra: NodeJS.ProcessEnv = {}): NodeJS.ProcessEnv {
    const env: NodeJS.ProcessEnv = { TIER_KIND: 'local', BASE_URL: 'http://localhost:3080', REG_STATE_DIR: dir, REG_RUN_ID: RUN, ...extra };
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(localProofFile(env), JSON.stringify({ runId: RUN, tier: tierIdentity(env), at: new Date().toISOString() }));
    return env;
}

test('localStack lifts the ownership rule and the platform deny-list on a PROVEN local stack only (B4 @local rows, fix pass 3)', async ({}, testInfo) => {
    const r = raw();
    const onShared = guardApiForUnitTests(r.api, { ...seams, localStack: true, env: { TIER_KIND: 'shared' } });
    await expect(onShared.put('/api/v1/settings/platform', { data: {} })).rejects.toThrow(OwnObjectViolation);
    const unproven = guardApiForUnitTests(r.api, { ...seams, localStack: true, env: { TIER_KIND: 'local', BASE_URL: 'http://localhost:3080', REG_STATE_DIR: testInfo.outputPath('none'), REG_RUN_ID: RUN } });
    await expect(unproven.put('/api/v1/settings/platform', { data: {} }), 'TIER_KIND=local without this run\'s proof').rejects.toThrow(/platform-level/);
    await expect(unproven.patch(`/api/v1/authorities/${AUTH}/raProfiles/${FOREIGN_RA}/disable`)).rejects.toThrow(OwnObjectViolation);
    const env = provenLocalEnv(testInfo.outputPath('state'));
    const onLocal = guardApiForUnitTests(r.api, { ...seams, localStack: true, env });
    await onLocal.put('/api/v1/settings/platform', { data: {} });
    await onLocal.patch(`/api/v1/authorities/${AUTH}/raProfiles/${FOREIGN_RA}/disable`);
    await expect(guardApiForUnitTests(r.api, { ...seams, localStack: false, env }).put('/api/v1/settings/platform', { data: {} }), 'the proof alone lifts nothing').rejects.toThrow(/platform-level/);
    await expect(guardApiForUnitTests(r.api, { ...seams, localStack: true, env: { ...env, API_TEARDOWN_DRY_RUN: '1' } }).delete(`/api/v1/roles/${FOREIGN_RA}`), 'the dry run still holds')
        .rejects.toThrow(DryRunRefusal);
    await expect(onLocal.put('/api/v1/settings/platform', { form: { a: 'b' } }), 'body rules still hold').rejects.toThrow(/form \/ multipart/);
    expect(r.sent).toEqual(['PUT /api/v1/settings/platform', `PATCH /api/v1/authorities/${AUTH}/raProfiles/${FOREIGN_RA}/disable`]);
});

test('Q3 body vectors: string / Buffer bodies are parsed; unparseable, form and multipart bodies are refused (fix pass 3)', async () => {
    const r = raw();
    const g = guardApiForUnitTests(r.api, seams);
    const foreignUsers = JSON.stringify([FOREIGN_USER]);
    await expect(g.patch(`/api/v1/roles/${OWN_ROLE}/users`, { data: foreignUsers }), 'a JSON string body').rejects.toThrow(OwnObjectViolation);
    await expect(g.patch(`/api/v1/roles/${OWN_ROLE}/users`, { data: Buffer.from(foreignUsers) }), 'a Buffer body').rejects.toThrow(OwnObjectViolation);
    await expect(g.patch(`/api/v1/roles/${OWN_ROLE}/users`, { data: `\uFEFF${foreignUsers}` }), 'a BOM in front').rejects.toThrow(OwnObjectViolation);
    // Fix pass 5 (F1): a string JSON.parse refuses is sent as Playwright sends it with a JSON content type — re-quoted as a
    // JSON string — and judged as that string (a canonical uuid anywhere in it must be own).
    await expect(g.patch(`/api/v1/roles/${OWN_ROLE}/users`, { data: `${foreignUsers} trailing` }), 'trailing junk: a JSON string naming a foreign uuid').rejects.toThrow(OwnObjectViolation);
    await expect(g.patch(`/api/v1/roles/${OWN_ROLE}/users`, { data: Buffer.from(`${foreignUsers} trailing`) }), 'a Buffer is sent as is: not JSON').rejects.toThrow(/not JSON/);
    await expect(g.put(`/api/v1/roles/${OWN_ROLE}`, { data: Buffer.from('not json at all') })).rejects.toThrow(/not JSON/);
    await expect(g.put(`/api/v1/roles/${OWN_ROLE}`, { form: { userUuids: FOREIGN_USER } })).rejects.toThrow(/form \/ multipart/);
    await expect(g.post(`/api/v1/roles/${OWN_ROLE}/x`, { multipart: { file: 'x' } })).rejects.toThrow(/form \/ multipart/);
    await expect(g.post('/api/v1/roles', { form: { name: 'x' } }), 'a create too').rejects.toThrow(/form \/ multipart/);
    expect(r.sent).toEqual([]);
    await g.patch(`/api/v1/roles/${OWN_ROLE}/users`, { data: JSON.stringify([OWN_USER]) });
    await g.patch(`/api/v1/roles/${OWN_ROLE}/users`, { data: Buffer.from(`[${JSON.stringify(OWN_USER)}]`) });
    await g.put(`/api/v1/roles/${OWN_ROLE}`, { data: Buffer.from('   ') });
    expect(r.sent).toHaveLength(3);
    expect(readBody(Buffer.from('{"a":1}'))).toEqual({ kind: 'json', value: { a: 1 }, raw: '{"a":1}' });
    expect(readBody(Buffer.from('   '))).toEqual({ kind: 'none' });
    expect(readBody(Buffer.from('{bad'))).toEqual({ kind: 'text', text: '{bad' });
    // Strings: what Playwright sends with content-type application/json (fix pass 5).
    expect(readBody('')).toEqual({ kind: 'json', value: '' });
    expect(readBody('{bad')).toEqual({ kind: 'json', value: '{bad' });
});

test('every uuid-valued field is an association (singular *Uuid, uuid, any key), recognised like the server parses it (fix pass 3)', async () => {
    const r = raw();
    const g = guardApiForUnitTests(r.api, seams);
    await expect(g.put(`/api/v1/roles/${OWN_ROLE}`, { data: { ownerUuid: FOREIGN_USER } }), 'a singular *Uuid').rejects.toThrow(OwnObjectViolation);
    await expect(g.put(`/api/v1/roles/${OWN_ROLE}`, { data: { objects: [{ uuid: FOREIGN_RA, allow: ['detail'] }] } }), 'a `uuid` key').rejects.toThrow(OwnObjectViolation);
    await expect(g.put(`/api/v1/roles/${OWN_ROLE}`, { data: { note: FOREIGN_RA } }), 'any key').rejects.toThrow(OwnObjectViolation);
    // Java's UUID.fromString pads short groups; Jackson reads 24 base64 characters as the 16 bytes of a UUID. Fix pass 4:
    // such forms are recognised as uuid-like and REFUSED (kind request), never canonicalised.
    const short = '0-0-4000-8000-2'; // = FOREIGN_RA (00000000-0000-4000-8000-000000000002)
    const b64 = Buffer.from(FOREIGN_RA.replace(/-/g, ''), 'hex').toString('base64');
    expect([canonicalUuid(short), canonicalUuid(b64), canonicalUuid(FOREIGN_RA.toUpperCase()), canonicalUuid('qa-reg-20261013-120000-ab12-role')])
        .toEqual([undefined, undefined, FOREIGN_RA, undefined]);
    expect([isUuidLike(short), isUuidLike(b64), isUuidLike('qa-reg-20261013-120000-ab12-role')]).toEqual([true, true, false]);
    await expect(g.put(`/api/v1/roles/${OWN_ROLE}`, { data: { userUuids: [short] } }), 'the lenient form').rejects.toThrow(/non-canonical uuid form/);
    await expect(g.put(`/api/v1/roles/${OWN_ROLE}`, { data: { raProfileUuids: [b64] } }), 'the base64 form').rejects.toThrow(/non-canonical uuid form/);
    expect(uuidTokens(`x=${short}&y=${b64}&n=qa-reg-20261013-120000-ab12-role&d=2026-10-14`), 'canonical tokens only').toEqual([]);
    expect(stringFindings(`x=${short}&y=${b64}&n=qa-reg-20261013-120000-ab12-role&d=2026-10-14`, { free: true }).nonCanonical).toHaveLength(2);
    expect(associationUuids({ a: [OWN_ROLE], b: { roleUuids: [OWN_USER, 'not-a-uuid'] }, ownerUuid: OWN_CERT, customAttributes: [{ uuid: ATTRIBUTE_DEF }], issueCertificateAttributes: [[AUTH]] }))
        .toEqual([OWN_ROLE, OWN_USER, OWN_CERT]);
    expect(r.sent).toEqual([]);
});

test('reference fields may name pre-existing objects on an own create / update, never on a DELETE; everything else must be own (fix pass 3)', async () => {
    const r = raw();
    const g = guardApiForUnitTests(r.api, seams);
    // Creates: the body is checked now (open point 2 of fix pass 2 closed).
    await expect(g.post('/api/v1/roles', { data: { name: `${RUN}-r`, userUuids: [FOREIGN_USER] } }), 'a new role with foreign members').rejects.toThrow(OwnObjectViolation);
    await expect(g.post(`/api/v1/tokens/${AUTH}/tokenProfiles/${AUTH}/keys/keyPair`, { data: { name: `${RUN}-k`, groupUuids: [FOREIGN_GROUP] } }), 'a new key in a foreign group')
        .rejects.toThrow(OwnObjectViolation);
    await expect(g.post(`/api/v2/operations/authorities/${AUTH}/raProfiles/${FOREIGN_RA}/certificates`, { data: { request: 'x', keyUuid: FOREIGN_USER } }), 'a foreign key').rejects.toThrow(OwnObjectViolation);
    await expect(g.post('/api/v1/roles', { data: { name: 'x', ownerUuid: FOREIGN_USER } })).rejects.toThrow(OwnObjectViolation);
    expect(r.sent).toEqual([]);
    await g.post('/api/v1/authorities', { data: { name: `${RUN}-a`, connectorUuid: CONNECTOR, interfaceUuid: U(17), attributes: [{ uuid: ATTRIBUTE_DEF }] } });
    await g.post('/api/v1/acmeProfiles', { data: { name: `${RUN}-acme`, raProfileUuid: FOREIGN_RA } });
    // Fix pass 4: token profiles are no reference fields until the B2 key handler exists (a key would stay in a foreign token).
    await expect(g.post(`/api/v2/operations/authorities/${AUTH}/raProfiles/${FOREIGN_RA}/certificates`, { data: { request: 'x', tokenProfileUuid: U(18) } }))
        .rejects.toThrow(OwnObjectViolation);
    await expect(g.post(`/api/v2/operations/authorities/${AUTH}/raProfiles/${FOREIGN_RA}/certificates`, { data: { request: 'x', altTokenProfileUuid: U(19) } }))
        .rejects.toThrow(OwnObjectViolation);
    await g.post('/api/v1/roles', { data: { name: `${RUN}-r2`, groupUuids: [OWN_GROUP] } });
    await g.patch(`/api/v1/certificates/${OWN_CERT}`, { data: { raProfileUuid: FOREIGN_RA } });
    await g.post('/api/v1/roles', { data: '{"name": "broken' }); // a malformed-JSON negative case: no uuid-like token, sent
    expect(r.sent).toHaveLength(5);
    await expect(g.post('/api/v1/roles', { data: `{"name": "x", "userUuids": ["${FOREIGN_USER}"] trailing` }), 'unparseable with a foreign token').rejects.toThrow(OwnObjectViolation);
    await expect(g.delete(`/api/v1/roles/${OWN_ROLE}`, { data: { raProfileUuid: FOREIGN_RA } }), 'no reference exception on a DELETE').rejects.toThrow(OwnObjectViolation);
    await expect(g.patch(`/api/v1/certificates/${OWN_CERT}`, { data: { groupUuids: [FOREIGN_GROUP] } }), 'groups are not a reference field').rejects.toThrow(OwnObjectViolation);
    expect(r.sent).toHaveLength(5);
});

test('the query string and the params option name uuids too: own or probe (fix pass 3)', async () => {
    const r = raw();
    const g = guardApiForUnitTests(r.api, seams);
    await expect(g.patch(`/api/v1/roles/${OWN_ROLE}?userUuid=${FOREIGN_USER}`)).rejects.toThrow(OwnObjectViolation);
    await expect(g.patch(`/api/v1/roles/${OWN_ROLE}`, { params: { userUuids: `${OWN_USER},${FOREIGN_USER}` } }), 'a comma list').rejects.toThrow(OwnObjectViolation);
    await expect(g.patch(`/api/v1/roles/${OWN_ROLE}`, { params: `x=${FOREIGN_USER}` })).rejects.toThrow(OwnObjectViolation);
    await expect(g.patch(`/api/v1/roles/${OWN_ROLE}`, { params: new URLSearchParams({ x: FOREIGN_USER }) })).rejects.toThrow(OwnObjectViolation);
    await expect(g.post('/api/v1/roles', { params: { copyFrom: FOREIGN_RA }, data: { name: 'x' } }), 'a create too').rejects.toThrow(OwnObjectViolation);
    await expect(g.delete(`/api/v1/roles/${OWN_ROLE}?_method=PUT`), 'a method override parameter').rejects.toThrow(/_method/);
    await expect(g.get('/api/v1/roles', { headers: { 'X-HTTP-Method-Override': 'DELETE' } }), 'a method override header, even on a GET').rejects.toThrow(/method-override/);
    expect(r.sent).toEqual([]);
    const probe = g.probeUuid();
    await g.patch(`/api/v1/roles/${OWN_ROLE}?userUuid=${OWN_USER}`, { params: { other: probe, force: true } });
    expect(r.sent).toHaveLength(1);
    expect(queryUuids(`/x?a=${OWN_USER}`, { b: `${OWN_ROLE},${OWN_CERT}` })).toEqual([OWN_USER, OWN_ROLE, OWN_CERT]);
});

test('a Request object is judged on its own method, headers and body (fix pass 3)', async () => {
    const r = raw();
    const g = guardApiForUnitTests(r.api, seams);
    const request = (method: string, body: unknown) => ({
        url: () => `/api/v1/roles/${OWN_ROLE}/users`, method: () => method, headers: () => ({ 'content-type': 'application/json' }),
        postDataBuffer: () => Buffer.from(JSON.stringify(body)),
    });
    await expect(g.fetch(request('PATCH', [FOREIGN_USER]) as unknown as string)).rejects.toThrow(OwnObjectViolation);
    expect(r.sent).toEqual([]);
});

test('absolute URLs: a mutation goes to BASE_URL\'s origin only (fix pass 3)', async () => {
    const r = raw();
    const env = { BASE_URL: 'https://tier.example.test/administrator/' };
    const g = guardApiForUnitTests(r.api, { ...seams, env });
    await expect(g.delete(`https://elsewhere.example.test/api/v1/roles/${OWN_ROLE}`)).rejects.toThrow(/origin is not BASE_URL/);
    await expect(g.delete(`http://tier.example.test/api/v1/roles/${OWN_ROLE}`), 'another scheme is another origin').rejects.toThrow(/origin/);
    await expect(guardApiForUnitTests(r.api, seams).delete(`https://tier.example.test/api/v1/roles/${OWN_ROLE}`), 'BASE_URL unset').rejects.toThrow(/BASE_URL is unset/);
    expect(r.sent).toEqual([]);
    await g.delete(`https://tier.example.test/api/v1/roles/${OWN_ROLE}`);
    // Fix pass 4: a GET to another origin is refused too (the context carries the run's token).
    await expect(g.get('https://elsewhere.example.test/api/v1/roles')).rejects.toThrow(/origin is not BASE_URL/);
    expect(r.sent).toEqual([`DELETE https://tier.example.test/api/v1/roles/${OWN_ROLE}`]);
    expect(originProblem('/api/v1/roles', {})).toBeUndefined();
    expect(String(originProblem('https://elsewhere.example.test/x', env))).not.toContain('example');
});

test('the platform deny-list refuses platform-level endpoints on a shared tier, own target or not (fix pass 3)', async () => {
    const r = raw();
    const g = guardApiForUnitTests(r.api, seams);
    const denied: Array<[string, string, unknown?]> = [
        ['PUT', '/api/v1/settings/platform', {}], ['PATCH', '/api/v1/settings/authentication', {}], ['POST', `/api/v1/scheduler/jobs/${OWN_ROLE}/enable`],
        ['PUT', '/api/v1/auth/profile', { firstName: 'x' }], ['POST', '/api/v1/workflows/events', { resource: 'certificates', event: 'x', triggerUuids: [OWN_TRIGGER] }],
        ['POST', '/api/v1/trustedCertificates', {}], ['DELETE', `/api/v1/proxies/${OWN_ROLE}`], ['PUT', `/api/v1/timeQualityConfigurations/${OWN_ROLE}`, {}],
        ['POST', '/api/v1/attributes/metadata/promote', {}], ['POST', '/api/v1/cboms/sync'], ['PUT', `/api/v1/connectors/${OWN_ROLE}/approve`],
        ['PUT', '/api/v1/connectors/reconnect', [OWN_ROLE]], ['POST', '/api/v2/connectors/connect', {}], ['PUT', '/api/v1/connectors/connect', {}],
        ['PATCH', `/api/v2/connectors/${OWN_ROLE}/approve`], ['POST', '/api/v1/connector/register', {}], ['POST', '/api/v2/connector/register', {}],
        ['PUT', '/api/v1/branding', {}], ['POST', '/api/v1/local/admins', {}],
    ];
    for (const [method, url, data] of denied) {
        await expect(g.fetch(url, { method, data }), `${method} ${url}`).rejects.toThrow(/platform-level/);
    }
    expect(r.sent).toEqual([]);
    expect(platformDenied('/v1/workflows/events', { objectUuid: OWN_CERT, triggerUuids: [OWN_TRIGGER] }), 'an object-level association is not platform-level').toBeUndefined();
    expect(platformDenied('/v1/workflows/events/certificateStatusChanged/history')).toBeUndefined();
    await g.post('/api/v1/workflows/events', { data: { resource: 'certificates', event: 'x', objectUuid: OWN_CERT, triggerUuids: [OWN_TRIGGER] } });
    await expect(g.post('/api/v1/workflows/events', { data: { resource: 'certificates', event: 'x', objectUuid: FOREIGN_RA, triggerUuids: [OWN_TRIGGER] } }), 'a foreign object')
        .rejects.toThrow(OwnObjectViolation);
    expect(r.sent).toEqual(['POST /api/v1/workflows/events']);
});

test('refusals say why: ownership, derived, request (fix pass 3)', async () => {
    const r = raw();
    const g = guardApiForUnitTests(r.api, seams);
    const kindOf = async (p: Promise<unknown>) => p.then(() => 'sent', (e: OwnObjectViolation) => e.kind);
    expect(await kindOf(g.delete(`/api/v1/roles/${FOREIGN_RA}`))).toBe('ownership');
    expect(await kindOf(g.delete(`/api/v1/roles/${RENAMED_ROLE}`))).toBe('ownership');
    expect(await kindOf(g.delete('/api/v1/keys', { data: [DERIVED_KEY] }))).toBe('derived');
    expect(await kindOf(g.delete(`/api/v1/roles/${OWN_ROLE}/../x`))).toBe('request');
    expect(await kindOf(g.put('/api/v1/settings/platform', { data: {} }))).toBe('request');
    expect(await kindOf(g.delete('/api/v1/keys', { data: { filters: [] } }))).toBe('request');
    expect(r.sent).toEqual([]);
});

test('the public guard reads the tier, ledger and environment from the process only: injected options are ignored (Q13)', async ({}, testInfo) => {
    const r = raw();
    const saved = { TIER_KIND: process.env.TIER_KIND, REG_STATE_DIR: process.env.REG_STATE_DIR };
    process.env.TIER_KIND = 'shared';
    process.env.REG_STATE_DIR = testInfo.outputPath('state'); // the process ledger: empty
    try {
        // A caller that passes ledger lines, a run id and TIER_KIND=local cannot lift or forge anything.
        const forged = { localStack: true, env: { TIER_KIND: 'local' }, lines, runId: RUN, tier: null } as unknown as Parameters<typeof guardApi>[1];
        const g = guardApi(r.api, forged);
        await expect(g.patch(`/api/v1/authorities/${AUTH}/raProfiles/${FOREIGN_RA}/disable`)).rejects.toThrow(OwnObjectViolation);
        await expect(g.delete(`/api/v1/roles/${OWN_ROLE}`), 'the injected ledger is not read').rejects.toThrow(/no ledger "created" line/);
        expect(r.sent).toEqual([]);
    } finally {
        for (const [k, v] of Object.entries(saved)) {
            if (v === undefined) delete process.env[k];
            else process.env[k] = v;
        }
    }
});

test('the runtime brand: requireGuarded refuses a raw context, accepts a guarded one (Q2)', () => {
    const r = raw();
    const g = guardApi(r.api);
    expect(isGuardedApi(g)).toBe(true);
    expect(isGuardedApi(r.api)).toBe(false);
    expect(requireGuarded(g, 'test')).toBe(g);
    expect(() => requireGuarded(r.api, 'test')).toThrow(/needs the guarded API context/);
    expect(() => requireGuarded({ ...g } as unknown as APIRequestContext, 'test'), 'a copy is not the guard').toThrow(OwnObjectViolation);
});
