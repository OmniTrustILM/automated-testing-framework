/**
 * Two deliberate allowances of the guard, on the wire: `content-type: text/plain` bodies for 415 negatives (sent as
 * written, judged as raw text, every uuid own or a probe) and the connector health GET as a plain read, so the
 * post-install check can read pre-existing connectors. A foreign certificate's `validate` stays refused.
 */
import { APIRequestContext, expect, test } from '@playwright/test';
import { guardApiWithSeams } from '../../utils/regression/guard/createGuard';
import { OwnObjectViolation, RefusalKind } from '../../utils/regression/ledger/ownership';
import { apiJson } from '../../utils/regression/apiReads';
import { LedgerLine } from '../../utils/regression/ledger/ledger';
import { Arrived, LoopbackServer } from './helpers/loopbackServer';
import { registerGuardRig, withProcessEnv, looseApi } from './helpers/guardRig';

const RUN = 'qa-reg-20261014-130000-cd34';
const U = (n: number) => `00000000-0000-4000-8000-${String(n).padStart(12, '0')}`;
const OWN_ROLE = U(3);
const OWN_USER = U(6);
const OWN_RA = U(1);
const FOREIGN_ROLE = U(20);
const FOREIGN_USER = U(10);
const FOREIGN_CERT = U(11);
const PRE_CONNECTOR = U(30);

const lines: LedgerLine[] = [
    { at: 'a', runId: RUN, type: 'roles', name: `${RUN}-role`, uuid: OWN_ROLE, spec: 'T', event: 'created' },
    { at: 'a', runId: RUN, type: 'users', name: `${RUN}-user`, uuid: OWN_USER, spec: 'T', event: 'created' },
    { at: 'a', runId: RUN, type: 'raProfiles', name: `${RUN}-ra`, uuid: OWN_RA, spec: 'T', event: 'created' },
];

/** The fake core's live objects (GET); every other GET answers 404, every other method 200 `{}`. */
const live: Record<string, unknown> = {
    [`/api/v1/roles/${OWN_ROLE}`]: { name: `${RUN}-role` },
    [`/api/v1/users/${OWN_USER}`]: { username: `${RUN}-user` },
    [`/api/v1/raProfiles/${OWN_RA}`]: { name: `${RUN}-ra` },
    [`/api/v1/connectors/${PRE_CONNECTOR}/health`]: { status: 'ok', parts: {} },
    [`/api/v2/connectors/${PRE_CONNECTOR}/health`]: { status: 'ok', parts: {} },
};

let A: LoopbackServer;
let B: LoopbackServer;
let raw: APIRequestContext;
let BASE_URL: string;

const coreAnswer = (a: Arrived) => {
    if (a.method === 'GET' || a.method === 'HEAD') return live[a.url] ? { status: 200, body: live[a.url] } : { status: 404, body: {} };
    return undefined;
};

registerGuardRig(
    {
        answer: coreAnswer,
        headers: { Authorization: 'Bearer SECRET-TOKEN', 'ssl-client-cert': 'CERT' },
    },
    (rig) => {
        A = rig.A;
        B = rig.B;
        raw = rig.raw;
        BASE_URL = rig.BASE_URL;
    },
);

const guard = () => guardApiWithSeams(raw, { lines, runId: RUN, tier: null, env: { BASE_URL } });
const own = (suffix = '') => `/api/v1/roles/${OWN_ROLE}${suffix}`;
const TP = { 'Content-Type': 'text/plain' };

/** The refusal kind of a guarded call, or 'sent' when it went through. */
async function outcome(call: Promise<unknown>): Promise<RefusalKind | 'sent' | string> {
    return (await refusal(call)).kind;
}

/** The refusal kind and reason of a guarded call (every refusal row asserts its reason too). */
async function refusal(call: Promise<unknown>): Promise<{ kind: RefusalKind | 'sent' | string; reason: string }> {
    try {
        await call;
        return { kind: 'sent', reason: '' };
    } catch (e) {
        return e instanceof OwnObjectViolation ? { kind: e.kind, reason: e.reason } : { kind: `error: ${String(e).slice(0, 160)}`, reason: '' };
    }
}

const NOT_OWN = /no ledger "created" line of run/;
const NON_CANONICAL = /a non-canonical uuid form in the body or query/;
const CONTENT_TYPE = /a content type other than application\/json or text\/plain/;

/** A canonical uuid as Jackson's base64 forms (24 characters with `==`, 22 unpadded URL-safe). */
const b64 = (u: string) => Buffer.from(u.replace(/-/g, ''), 'hex').toString('base64');
const b64url22 = (u: string) => b64(u).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');

// first decision: a text/plain body on an own target is sent exactly as written (no JSON re-quoting), with the run's identity
test('a text/plain body on an own target is sent exactly as written, without JSON re-quoting', async () => {
    const g = looseApi(guard());
    const probe = g.probeUuid();
    const garbage = 'this is { not JSON "at all" \\ and never re-quoted';
    const junk = `{"name":"${RUN}-x"} trailing junk`;
    // Playwright itself: a string goes as written under text/plain, re-quoted under application/json (client/fetch.js).
    await raw.fetch(own(), { method: 'PUT', data: junk, headers: { 'content-type': 'text/plain' } });
    await raw.fetch(own(), { method: 'PUT', data: junk, headers: { 'content-type': 'application/json' } });
    expect(A.mutations().map((a) => a.body), 'Playwright re-quotes only under application/json').toEqual([junk, JSON.stringify(junk)]);
    A.reset();
    // Through the guard.
    await g.put(own(), { data: garbage, headers: TP });
    await g.post('/api/v1/roles', { data: junk, headers: { 'content-type': 'TEXT/PLAIN; Charset=UTF-8' } });
    await g.patch(own('/users'), { data: JSON.stringify([OWN_USER]), headers: { 'content-type': 'text/plain;charset=utf-8' } });
    await g.put(own(), { data: Buffer.from('﻿a BOM, then text'), headers: TP });
    await g.delete(`/api/v1/roles/${probe}`, { data: `probe ${probe}`, headers: TP });
    await g.put(own(), { data: '', headers: TP });
    // A read POST keeps its rules (allow-listed, body not judged); text/plain on it goes as written too.
    await g.post('/api/v1/certificates', { data: 'not a search request', headers: TP });
    expect(A.mutations().map((a) => [a.method, a.url, a.body, a.headers['content-type']])).toEqual([
        ['PUT', own(), garbage, 'text/plain'],
        ['POST', '/api/v1/roles', junk, 'text/plain; charset=utf-8'],
        ['PATCH', own('/users'), JSON.stringify([OWN_USER]), 'text/plain; charset=utf-8'],
        ['PUT', own(), '﻿a BOM, then text', 'text/plain'],
        ['DELETE', `/api/v1/roles/${probe}`, `probe ${probe}`, 'text/plain'],
        ['PUT', own(), '', 'text/plain'],
        ['POST', '/api/v1/certificates', 'not a search request', 'text/plain'],
    ]);
    expect(A.mutations().every((a) => a.headers.authorization === 'Bearer SECRET-TOKEN'), 'the run\'s own identity').toBe(true);
    expect(B.arrived).toEqual([]);
});

// first decision: text/plain is judged as raw text — foreign uuids (ownership), non-canonical uuid-like tokens (request), other
// types and misuse (request)
test('text/plain is judged as raw text: foreign uuids and odd uuid-like tokens are refused', async () => {
    const g = looseApi(guard());
    // The first dash escaped: the raw text holds no uuid-shaped run, only its JSON-decoded form names the foreign user.
    const escaped = FOREIGN_USER.replace('-', '\\u002d');
    const rows: Array<[string, () => Promise<unknown>, RefusalKind, RegExp]> = [
        // every canonical uuid anywhere in the raw text must be own or a probe
        ['a foreign canonical uuid in the text', () => g.put(own(), { data: `garbage ${FOREIGN_USER} more garbage`, headers: TP }), 'ownership', NOT_OWN],
        ['a foreign uuid in JSON-looking text', () => g.patch(own('/users'), { data: JSON.stringify([OWN_USER, FOREIGN_USER]), headers: TP }), 'ownership', NOT_OWN],
        ['a foreign uuid glued to letters, upper case', () => g.put(own(), { data: `x${FOREIGN_USER.toUpperCase()}y`, headers: TP }), 'ownership', NOT_OWN],
        ['a \\u-escaped foreign uuid', () => g.put(own(), { data: `{"userUuids":["${escaped}"]}`, headers: TP }), 'ownership', NOT_OWN],
        ['a foreign uuid in a Buffer', () => g.put(own(), { data: Buffer.from(`raw ${FOREIGN_USER}`), headers: TP }), 'ownership', NOT_OWN],
        ['a foreign target in the path', () => g.put(`/api/v1/roles/${FOREIGN_ROLE}`, { data: 'garbage', headers: TP }), 'ownership', NOT_OWN],
        // any non-canonical uuid-like token is refused (the guard's over-approximation for strings)
        ['a padded uuid (whole body)', () => g.put(own(), { data: `\t${OWN_USER}\n`, headers: TP }), 'request', NON_CANONICAL],
        ['a base64 uuid token', () => g.put(own(), { data: `garbage ${b64(OWN_USER)} garbage`, headers: TP }), 'request', NON_CANONICAL],
        ['a 22-char base64url uuid token', () => g.put(own(), { data: `garbage ${b64url22(FOREIGN_USER)} garbage`, headers: TP }), 'request', NON_CANONICAL],
        ['a lenient uuid token', () => g.put(own(), { data: 'x +0-0-4000-8000-6 y', headers: TP }), 'request', NON_CANONICAL],
        ['a urn:uuid token', () => g.put(own(), { data: `urn:uuid:${OWN_USER}`, headers: TP }), 'request', NON_CANONICAL],
        // only text/plain, optionally charset=utf-8
        ['text/plain; charset=iso-8859-1', () => g.put(own(), { data: 'garbage', headers: { 'content-type': 'text/plain; charset=iso-8859-1' } }), 'request', CONTENT_TYPE],
        ['text/html', () => g.put(own(), { data: 'garbage', headers: { 'content-type': 'text/html' } }), 'request', CONTENT_TYPE],
        ['text/plain with another parameter', () => g.put(own(), { data: 'garbage', headers: { 'content-type': 'text/plain; format=flowed' } }), 'request', CONTENT_TYPE],
        ['a quoted charset', () => g.put(own(), { data: 'garbage', headers: { 'content-type': 'text/plain; charset="utf-8"' } }), 'request', CONTENT_TYPE],
        ['charset twice', () => g.put(own(), { data: 'garbage', headers: { 'content-type': 'text/plain; charset=utf-8; charset=utf-16' } }), 'request', CONTENT_TYPE],
        // no identity headers, even with identityOverride
        ['an identity header with identityOverride', () => g.put(own(), { data: 'garbage', headers: { ...TP, Authorization: 'Bearer OTHER' }, identityOverride: true }), 'request', /an identity header on a text\/plain request/],
        ['a client certificate with identityOverride', () => g.put(own(), { data: 'garbage', headers: { ...TP, 'ssl-client-cert': 'OTHER' }, identityOverride: true }), 'request', /an identity header on a text\/plain request/],
        // a string or Buffer body on a non-GET request only
        ['text/plain on a GET', () => g.get('/api/v1/roles', { headers: TP }), 'request', /text\/plain on a GET \/ TRACE/],
        ['text/plain with an object body', () => g.put(own(), { data: { name: `${RUN}-o` }, headers: TP }), 'request', /text\/plain with a body that is not a string or Buffer/],
        ['text/plain without a body', () => g.delete(own(), { headers: TP }), 'request', /text\/plain with a body that is not a string or Buffer/],
        ['a Buffer that is not UTF-8', () => g.put(own(), { data: Buffer.from([0xff, 0xfe, 0x41]), headers: TP }), 'request', /a text\/plain Buffer body that is not UTF-8/],
        ['NUL characters', () => g.put(own(), { data: 'a\u0000b', headers: TP }), 'request', /a text\/plain body with NUL characters/],
        // every other rule unchanged: bulk routes, path-less mutations, the deny-list, the path, the origin
        ['a bulk route (its DTO is JSON)', () => g.patch('/api/v1/raProfiles/disable', { data: JSON.stringify([OWN_RA]), headers: TP }), 'request', /a text\/plain body on the bulk route \/v1\/raProfiles\/disable/],
        // `/v1/inspections` is an allow-listed create, so the path-less
        // mutation off the allow-lists is `/v1/certificates/create`.
        ['a path-less mutation off the allow-lists', () => g.post('/api/v1/certificates/create', { data: 'garbage', headers: TP }), 'request', /neither an allow-listed create \(POST_CREATE\) nor an allow-listed bulk route/],
        ['a platform endpoint', () => g.put('/api/v1/settings/platform', { data: 'garbage', headers: TP }), 'request', /platform settings is platform-level/],
        ['a name-keyed path', () => g.post('/api/v1/operations/Some-RA/certificate/revoke', { data: 'garbage', headers: TP }), 'request', /the legacy name-keyed client API/],
        ['a dot segment', () => g.put(`/api/v1/roles/x/../${OWN_ROLE}`, { data: 'garbage', headers: TP }), 'request', /a dot segment in the path/],
        ['another origin', () => g.put(`${B.origin}${own()}`, { data: 'garbage', headers: TP }), 'request', /an absolute URL whose origin is not BASE_URL's/],
        ['a method override header', () => g.put(own(), { data: 'garbage', headers: { ...TP, 'X-HTTP-Method-Override': 'DELETE' } }), 'request', /a method-override header/],
    ];
    const mismatches: string[] = [];
    for (const [name, call, kind, reason] of rows) {
        const got = await refusal(call());
        if (got.kind !== kind) mismatches.push(`${name}: expected ${kind}, got ${got.kind}`);
        else if (!reason.test(got.reason)) mismatches.push(`${name}: reason ${JSON.stringify(got.reason.slice(0, 160))} does not match ${reason}`);
    }
    expect(mismatches).toEqual([]);
    expect(A.mutations(), 'nothing refused reached the core').toEqual([]);
    expect(A.arrived.every((a) => a.method === 'GET' && live[a.url] !== undefined), 'only the guard\'s live reads of own objects').toBe(true);
    expect(B.arrived, 'the other origin saw nothing').toEqual([]);
});

// second decision: a pre-existing connector's health is a plain read (sent); a foreign certificate's validate stays refused
test('a pre-existing connector health check is a plain read and sent; a foreign validate is refused', async () => {
    const g = looseApi(guard());
    for (const v of ['v1', 'v2']) {
        const res = await g.get(`/api/${v}/connectors/${PRE_CONNECTOR}/health`);
        expect([res.status(), (await res.json()).status]).toEqual([200, 'ok']);
    }
    // The helper REG-DEP-01 uses (apiJson) through the guarded and through a raw context.
    await withProcessEnv({ BASE_URL }, async () => {
        expect((await apiJson<{ status: string }>(g, 'GET', `/api/v1/connectors/${PRE_CONNECTOR}/health`)).status).toBe('ok');
        expect((await apiJson<{ status: string }>(raw, 'GET', `/api/v2/connectors/${PRE_CONNECTOR}/health`)).status).toBe('ok');
        await expect(apiJson(raw, 'GET', `/api/v1/certificates/${FOREIGN_CERT}/validate`)).rejects.toThrow(/persists something/);
    });
    expect(await outcome(g.get(`/api/v1/certificates/${FOREIGN_CERT}/validate`))).toBe('ownership');
    expect(A.arrived.map((a) => `${a.method} ${a.url}`)).toEqual([
        `GET /api/v1/connectors/${PRE_CONNECTOR}/health`,
        `GET /api/v2/connectors/${PRE_CONNECTOR}/health`,
        `GET /api/v1/connectors/${PRE_CONNECTOR}/health`,
        `GET /api/v2/connectors/${PRE_CONNECTOR}/health`,
    ]);
    expect(A.arrived.every((a) => a.headers.authorization === 'Bearer SECRET-TOKEN')).toBe(true);
    expect(B.arrived).toEqual([]);
});
