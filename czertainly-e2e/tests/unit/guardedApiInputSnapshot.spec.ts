/**
 * The guard reads every input of a request once and sends only that snapshot (options, params, headers, the serialised
 * body, the URL), on the wire, so a getter, toJSON or Proxy cannot change a request after it was judged. Also the
 * path-less mutations (only allow-listed creates and bulk routes with their DTO body), name-keyed routes, redirects
 * and the base64 uuid form under uuid-shaped keys only.
 */
import { APIRequestContext, expect, request, test } from '@playwright/test';
import { allowedRawPost } from '../../utils/regression/guard/rawPost';
import { guardApiWithSeams } from '../../utils/regression/guard/createGuard';
import { OwnObjectViolation, RefusalKind } from '../../utils/regression/ledger/ownership';
import { apiJson } from '../../utils/regression/apiReads';
import { LedgerLine } from '../../utils/regression/ledger/ledger';
import { Arrived, loopbackServer, LoopbackServer } from './helpers/loopbackServer';
import { registerGuardRig, withProcessEnv } from './helpers/guardRig';

const RUN = 'qa-reg-20261014-120000-ab12';
const U = (n: number) => `00000000-0000-4000-8000-${String(n).padStart(12, '0')}`;
const OWN_RA = U(1);
const FOREIGN_RA = U(2);
const OWN_ROLE = U(3);
const OWN_CERT = U(5);
const OWN_USER = U(6);
const OWN_KEY = U(7);
const AUTH = U(9);
const FOREIGN_USER = U(10);
const FOREIGN_CERT = U(11);
const FOREIGN_ROLE = U(20);
const FOREIGN_KEY = 'a1b2c3d4-1111-4222-8333-444455556666';

const lines: LedgerLine[] = [
    { at: 'a', runId: RUN, type: 'raProfiles', name: `${RUN}-ra`, uuid: OWN_RA, spec: 'T', event: 'created' },
    { at: 'a', runId: RUN, type: 'roles', name: `${RUN}-role`, uuid: OWN_ROLE, spec: 'T', event: 'created' },
    { at: 'a', runId: RUN, type: 'users', name: `${RUN}-user`, uuid: OWN_USER, spec: 'T', event: 'created' },
    { at: 'a', runId: RUN, type: 'certificates', name: `${RUN}.example.test`, uuid: OWN_CERT, spec: 'T', event: 'created' },
    { at: 'a', runId: RUN, type: 'keys', name: `${RUN}-key`, uuid: OWN_KEY, spec: 'T', event: 'created' },
];

/** The fake core's live objects (GET); everything else GET answers 404, every other method 200 `{}`. */
const live: Record<string, unknown> = {
    [`/api/v1/raProfiles/${OWN_RA}`]: { name: `${RUN}-ra` },
    [`/api/v1/roles/${OWN_ROLE}`]: { name: `${RUN}-role` },
    [`/api/v1/users/${OWN_USER}`]: { username: `${RUN}-user` },
    [`/api/v1/certificates/${OWN_CERT}`]: { commonName: `${RUN}.example.test` },
    [`/api/v1/keys/${OWN_KEY}`]: { name: `${RUN}-key` },
    [`/api/v1/roles/${FOREIGN_ROLE}`]: { name: 'Administrators' },
};

let A: LoopbackServer;
let B: LoopbackServer;
let raw: APIRequestContext;
let BASE_URL: string;
/** When set, the fake core answers every non-GET with a 307 to the other origin (the p10 redirect probe). */
let redirectMutations = false;

const coreAnswer = (a: Arrived) => {
    if (a.method === 'GET' || a.method === 'HEAD') {
        if (a.url === '/api/v1/redirect/elsewhere') return { status: 307, headers: { location: `${B.origin}/api/v1/roles/${FOREIGN_ROLE}` } };
        if (a.url === '/api/v1/redirect/same') return { status: 302, headers: { location: `/api/v1/roles/${OWN_ROLE}` } };
        if (a.url === '/api/v1/redirect/effect') return { status: 302, headers: { location: `/api/v1/certificates/${FOREIGN_CERT}/validate` } };
        if (a.url === '/api/v1/redirect/loop') return { status: 302, headers: { location: '/api/v1/redirect/loop' } };
        return live[a.url] ? { status: 200, body: live[a.url] } : { status: 404, body: {} };
    }
    if (redirectMutations) return { status: 307, headers: { location: `${B.origin}${a.url}` } };
    return undefined;
};

registerGuardRig(
    {
        answer: coreAnswer,
        headers: { Authorization: 'Bearer SECRET-TOKEN', 'ssl-client-cert': 'CERT' },
        beforeEachTest: () => {
            redirectMutations = false;
        },
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

/** The refusal kind of a guarded call, or 'sent' when it went through. */
async function outcome(call: Promise<unknown> | (() => Promise<unknown>)): Promise<RefusalKind | 'sent' | string> {
    try {
        await (typeof call === 'function' ? call() : call);
        return 'sent';
    } catch (e) {
        return e instanceof OwnObjectViolation ? e.kind : `error: ${String(e).slice(0, 160)}`;
    }
}

/** Mutations that reached the core: `METHOD path body`. */
const wire = (s: LoopbackServer = A) => s.mutations().map((a) => `${a.method} ${a.url} ${a.body}`);
/** Everything that reached a server except the guard's own live reads of the own objects. */
const sentTo = (s: LoopbackServer) => s.arrived.filter((a) => !(a.method === 'GET' && live[a.url] !== undefined)).map((a) => `${a.method} ${a.url}`);

// input snapshot: options the guard does not forward are refused; neither server sees anything (no url / request /
// encodedParams smuggling)
test('input snapshot: options the guard does not forward are refused and neither server sees anything', async () => {
    const g = guard() as any; // eslint-disable-line @typescript-eslint/no-explicit-any
    const foreignUrl = `/api/v1/roles/${FOREIGN_ROLE}`;
    const caseObject = { url: foreignUrl, method: 'DELETE', data: [OWN_ROLE] };
    const rows: Array<[string, () => Promise<unknown>]> = [
        ['post(own, { url: foreign })', () => g.post(own('/users'), { data: [OWN_USER], url: `${foreignUrl}/users` })],
        ['delete(own, { url: foreign })', () => g.delete(own(), { url: foreignUrl })],
        ['put(own, { url: settings })', () => g.put(own(), { data: [OWN_ROLE], url: '/api/v1/settings/platform' })],
        ['get(list, { url: other origin })', () => g.get('/api/v1/roles', { url: `${B.origin}/api/v1/roles` })],
        ['fetch(own, { url: foreign, method: DELETE })', () => g.fetch(own(), { method: 'DELETE', url: foreignUrl })],
        ['a request description spread into post()', () => g.post(own('/users'), { ...caseObject })],
        ['fetch(own, caseObject)', () => g.fetch(own(), caseObject)],
        ['encodedParams', () => g.post(own('/users'), { data: [OWN_USER], encodedParams: `x=${FOREIGN_USER}` })],
        ['request option carrying a body', () => g.post(own('/users'), { request: { url: () => own(), method: () => 'POST', headers: () => ({}), postDataBuffer: () => Buffer.from(JSON.stringify([FOREIGN_USER])) } })],
        ['__testHookLookup (DNS override)', () => g.post(own('/users'), { data: [OWN_USER], __testHookLookup: { hostname: 'x' } })],
        ['an unknown key', () => g.patch(own('/users'), { data: [OWN_USER], whatever: 1 })],
        ['a symbol key', () => g.patch(own('/users'), { data: [OWN_USER], [Symbol('x')]: 1 })],
        ['get(url, { method: DELETE })', () => g.get(foreignUrl, { method: 'DELETE' })],
        ['head(url, { method })', () => g.head(foreignUrl, { method: 'DELETE' })],
        ['post(url, { method: DELETE })', () => g.post(foreignUrl, { method: 'DELETE' })],
        ['get(url, { data }) — a body on a GET', () => g.get(foreignUrl, { data: [FOREIGN_USER] })],
        ['fetch method with a trailing space', () => g.fetch(foreignUrl, { method: 'DELETE ' })],
        ['fetch method empty', () => g.fetch(foreignUrl, { method: '' })],
        ['fetch method number', () => g.fetch(foreignUrl, { method: 5 })],
        ['fetch method OPTIONS', () => g.fetch(own(), { method: 'OPTIONS' })],
        ['fetch URL as a String object', () => g.fetch(new String(foreignUrl), { method: 'DELETE' })],
        ['post URL as a String object', () => g.post(new String(foreignUrl), { data: [OWN_USER] })],
        ['post URL as a URL object', () => g.post(new URL(`${A.origin}${foreignUrl}`), { data: [OWN_USER] })],
        ['post URL undefined', () => g.post(undefined, { data: [OWN_USER] })],
        ['form {}', () => g.put(own(), { form: {} })],
        ['form null', () => g.put(own(), { form: null })],
        ['multipart FormData', () => g.post(own('/x'), { multipart: new FormData() })],
        ['params with an object value (stateful toString)', () => g.patch(own('/users'), { data: [OWN_USER], params: { x: { toString: () => FOREIGN_USER } } })],
        ['params as a Map', () => g.patch(own('/users'), { data: [OWN_USER], params: new Map([['x', FOREIGN_USER]]) })],
        ['timeout as a string', () => g.patch(own('/users'), { data: [OWN_USER], timeout: '5' })],
        ['maxRedirects on a mutation', () => g.delete(own(), { maxRedirects: 3 })],
        ['identityOverride not a boolean', () => g.get('/api/v1/roles', { identityOverride: 'yes' })],
        ['options not an object', () => g.get('/api/v1/roles', 'x')],
    ];
    const mismatches: string[] = [];
    for (const [name, call] of rows) {
        const got = await outcome(call);
        if (got !== 'request') mismatches.push(`${name}: ${got}`);
    }
    expect(mismatches).toEqual([]);
    expect(A.arrived, 'refused before any request, not even a live read').toEqual([]);
    expect(B.arrived, 'the other origin saw nothing: no request, no token, no client certificate').toEqual([]);
    // Controls: the forwarded options still work (failOnStatusCode: false keeps a 404 an answer).
    const res = await g.get(`/api/v1/roles/${U(99)}`, { failOnStatusCode: false, timeout: 5_000, maxRetries: 0, ignoreHTTPSErrors: true });
    expect(res.status()).toBe(404);
    await g.patch(own('/users'), { data: [OWN_USER], params: { page: 1, all: false }, timeout: 5_000 });
    expect(wire()).toEqual([`PATCH ${own('/users')}?page=1&all=false ${JSON.stringify([OWN_USER])}`]);
});

// input snapshot: headers — content-type application/json, accept and if-* only; identity headers only with identityOverride
test('input snapshot headers: only content-type, accept and if-*; identity headers need an override', async () => {
    const g = guard() as any; // eslint-disable-line @typescript-eslint/no-explicit-any
    const refused: Array<[string, Record<string, string>, unknown?]> = [
        ['X-HTTP-Method-Override', { 'X-HTTP-Method-Override': 'DELETE' }],
        ['X-HTTP-Verb', { 'X-HTTP-Verb': 'DELETE' }],
        ['X-Rewrite-URL', { 'X-Rewrite-URL': `/api/v1/roles/${FOREIGN_ROLE}` }],
        ['X-Original-URL', { 'X-Original-URL': `/api/v1/roles/${FOREIGN_ROLE}` }],
        ['X-Forwarded-Prefix / -Path', { 'X-Forwarded-Prefix': '/../..', 'X-Forwarded-Path': '/api/v1/settings' }],
        ['Host', { Host: 'evil.example.test' }],
        ['Authorization without identityOverride', { Authorization: 'Bearer OTHER' }],
        ['ssl-client-cert without identityOverride', { 'ssl-client-cert': 'OTHERCERT' }],
        ['Cookie without identityOverride', { Cookie: 'SESSION=x' }],
        ['content-type with a charset', { 'content-type': 'application/json; charset=Shift_JIS' }, JSON.stringify([OWN_USER])],
        ['content-type form, upper case', { 'Content-Type': 'Application/X-WWW-Form-Urlencoded; charset=utf-8' }, 'a=b'],
        ['content-type multipart', { 'CONTENT-TYPE': 'multipart/form-data; boundary=x' }, 'a=b'],
        // text/plain is allowed for 415 negatives (guardedApiPlainTextAndHealth.spec.ts); another charset is not
        ['content-type text/plain with a charset other than utf-8', { 'content-type': 'text/plain; charset=utf-16' }, JSON.stringify([OWN_USER])],
        ['content-encoding gzip on a string body', { 'content-encoding': 'gzip' }, JSON.stringify([OWN_USER])],
        ['the same header twice in two cases', { Accept: 'application/json', accept: 'text/plain' }],
        ['a protocol media type off a protocol path', { 'content-type': 'application/jose+json' }, '{}'],
    ];
    for (const [name, headers, data] of refused) {
        expect(await outcome(g.patch(own('/users'), { data: data ?? [OWN_USER], headers })), name).toBe('request');
    }
    // A real gzipped foreign body (the server would inflate what the guard never read).
    const zlib = require('zlib') as typeof import('zlib');
    expect(await outcome(g.patch(own('/users'), { data: zlib.gzipSync(Buffer.from(JSON.stringify([FOREIGN_USER]))), headers: { 'content-encoding': 'gzip' } }))).toBe('request');
    // A GET is held to the same list (the context carries the token there too).
    expect(await outcome(g.get('/api/v1/roles', { headers: { 'X-HTTP-Method-Override': 'DELETE' } }))).toBe('request');
    expect(A.arrived).toEqual([]);
    // Controls: accept, if-match, a JSON content type in any case (sent normalised), and an identity override on purpose.
    await g.patch(own('/users'), { data: [OWN_USER], headers: { Accept: 'application/json', 'If-Match': '"v1"', 'Content-Type': 'Application/JSON' } });
    const [m] = A.mutations();
    expect([m.headers.accept, m.headers['if-match'], m.headers['content-type'], m.headers.authorization]).toEqual(['application/json', '"v1"', 'application/json', 'Bearer SECRET-TOKEN']);
    A.reset();
    const res = await g.get('/api/v1/roles', { headers: { Authorization: 'Bearer OTHER-IDENTITY' }, identityOverride: true });
    expect(res.status()).toBe(404);
    expect(A.arrived.map((a) => a.headers.authorization)).toEqual(['Bearer OTHER-IDENTITY']);
    // A protocol POST may declare its protocol media type; its body goes byte for byte.
    A.reset();
    await g.post('/api/v1/protocols/acme/raProfile/x/new-order', { data: '{"protected":"x"}', headers: { 'content-type': 'application/jose+json' } });
    await g.post('/api/v1/protocols/scep/x/pkiclient.exe', { data: 'MIIB-not-json', headers: { 'content-type': 'application/x-pki-message' } });
    await g.post('/api/v1/protocols/cmp/x/pkixcmp', { data: Buffer.from([0x30, 0x82, 0x01]), headers: { 'content-type': 'application/pkixcmp' } });
    expect(A.mutations().map((a) => [a.headers['content-type'], a.body])).toEqual([
        ['application/jose+json', '{"protected":"x"}'],
        ['application/x-pki-message', 'MIIB-not-json'],
        ['application/pkixcmp', Buffer.from([0x30, 0x82, 0x01]).toString('utf8')],
    ]);
});

// input snapshot: every input is read once — what was judged is what arrives (toJSON, getters, Proxies, params, Request
// objects, Buffers)
test('input snapshot: every input is read once, so what was judged is what arrives', async () => {
    const g = guard() as any; // eslint-disable-line @typescript-eslint/no-explicit-any
    let n = 0;
    await g.patch(own('/users'), { data: { toJSON: () => (n++ === 0 ? [OWN_USER] : [FOREIGN_USER]) } });
    let m = 0;
    await g.put(own(), { data: { name: `${RUN}-r`, get userUuids() { return m++ === 0 ? [OWN_USER] : [FOREIGN_USER]; } } });
    let p = 0;
    await g.delete('/api/v1/keys', { data: new Proxy([OWN_KEY], { get: (t, k) => (k === '0' ? (p++ === 0 ? OWN_KEY : FOREIGN_KEY) : Reflect.get(t, k)) }) });
    let q = 0;
    await g.delete(own(), { params: { get x() { return q++ === 0 ? OWN_USER : FOREIGN_USER; } } });
    let r = 0;
    const requestLike = {
        url: () => (r++ === 0 ? own() : `/api/v1/roles/${FOREIGN_ROLE}`),
        method: () => 'DELETE', headers: () => ({}), postDataBuffer: () => null,
    };
    await g.fetch(requestLike);
    let b = 0;
    const bodyRequest = { url: () => '/api/v1/keys', method: () => 'DELETE', headers: () => ({}), postDataBuffer: () => Buffer.from(JSON.stringify([b++ === 0 ? OWN_KEY : FOREIGN_KEY])) };
    await g.fetch(bodyRequest);
    let h = 0;
    const headers = new Proxy({}, {
        ownKeys: () => (h++ === 0 ? [] : ['X-HTTP-Method-Override']),
        getOwnPropertyDescriptor: () => ({ enumerable: true, configurable: true, value: 'DELETE' }),
        get: () => 'DELETE',
    });
    await g.patch(own('/users'), { data: [OWN_USER], headers });
    // A shared Buffer changed after the call started: the guard sends its own copy.
    const buf = Buffer.from(JSON.stringify([OWN_KEY]));
    const pending = g.delete('/api/v1/keys', { data: buf });
    buf.write(JSON.stringify([FOREIGN_KEY]));
    await pending;
    expect([n, m, q, r, b, h], 'each stateful input was read once').toEqual([1, 1, 1, 1, 1, 1]);
    expect(wire()).toEqual([
        `PATCH ${own('/users')} ${JSON.stringify([OWN_USER])}`,
        `PUT ${own()} ${JSON.stringify({ name: `${RUN}-r`, userUuids: [OWN_USER] })}`,
        `DELETE /api/v1/keys ${JSON.stringify([OWN_KEY])}`,
        `DELETE ${own()}?x=${OWN_USER} `,
        `DELETE ${own()} `,
        `DELETE /api/v1/keys ${JSON.stringify([OWN_KEY])}`,
        `PATCH ${own('/users')} ${JSON.stringify([OWN_USER])}`,
        `DELETE /api/v1/keys ${JSON.stringify([OWN_KEY])}`,
    ]);
    expect(A.mutations().every((a) => !a.headers['x-http-method-override'])).toBe(true);
    expect(JSON.stringify(A.arrived)).not.toContain(FOREIGN_USER);
    expect(JSON.stringify(A.arrived)).not.toContain(FOREIGN_KEY);
    // params as a string / URLSearchParams REPLACE the URL's query (Playwright's encodedParams): judged on what is sent.
    A.reset();
    await g.delete(`${own()}?a=1`, { params: new URLSearchParams({ b: '2' }) });
    expect(await outcome(g.delete(`${own()}?a=1`, { params: `b=${FOREIGN_USER}` })), 'a foreign uuid in the replacing params').toBe('ownership');
    expect(wire()).toEqual([`DELETE ${own()}?b=2 `]);
});

// input snapshot: string and Buffer bodies are judged as sent — re-quoted strings, duplicate keys, raw-text uuids, nesting
test('input snapshot: string and Buffer bodies are judged as sent, quirks included', async () => {
    const g = guard() as any; // eslint-disable-line @typescript-eslint/no-explicit-any
    const J = { 'content-type': 'application/json' };
    // Duplicate keys: refused in a string and in a Buffer, at any depth.
    for (const [name, body] of [
        ['foreign first, own last (a duplicate key may not hide the foreign list)', `{"uuids":["${FOREIGN_KEY}"],"uuids":["${OWN_KEY}"]}`],
        ['own first, foreign last', `{"uuids":["${OWN_KEY}"],"uuids":["${FOREIGN_KEY}"]}`],
        ['nested', `{"uuids":["${OWN_KEY}"],"a":{"u":["${FOREIGN_KEY}"],"u":[]}}`],
        ['escaped duplicate', `{"reason":"x","re\\u0061son":"y","uuids":["${OWN_KEY}"]}`],
    ] as const) {
        expect(await outcome(g.patch('/api/v1/keys/compromise', { data: body, headers: J })), `string: ${name}`).toBe('request');
        expect(await outcome(g.patch('/api/v1/keys/compromise', { data: Buffer.from(body) })), `Buffer: ${name}`).toBe('request');
    }
    // A BOM string is not JSON for JSON.parse: Playwright re-quotes it; the guard judges (and sends) that JSON string.
    const bomList = `﻿${JSON.stringify([OWN_KEY])}`;
    expect(await outcome(g.delete('/api/v1/keys', { data: bomList, headers: J })), 'a JSON string is no uuid list').toBe('request');
    expect(await outcome(g.patch(own('/users'), { data: `﻿${JSON.stringify([FOREIGN_USER])}` })), 'a foreign uuid inside the string').toBe('ownership');
    // Raw text: every canonical uuid in it must be own — attribute subtrees and reference fields get no waiver there.
    const attr = { name: `${RUN}-r`, customAttributes: [{ content: [{ data: FOREIGN_USER }] }] };
    expect(await outcome(g.put(own(), { data: JSON.stringify(attr) })), 'string body').toBe('ownership');
    expect(await outcome(g.put(own(), { data: Buffer.from(JSON.stringify(attr)) })), 'Buffer body').toBe('ownership');
    // A Buffer that is not JSON: creates only, its uuids (also \\u-escaped) must be own.
    expect(await outcome(g.post('/api/v1/roles', { data: Buffer.from(`{"userUuids":["\\u0030\\u0030${FOREIGN_USER.slice(2)}"]} junk`) })), 'an escaped foreign uuid').toBe('ownership');
    expect(await outcome(g.put(own(), { data: Buffer.from('{"name": ') })), 'not a create').toBe('request');
    // Nesting deeper than the limit is a refusal, not a RangeError.
    let deep: unknown = { a: 1 };
    for (let i = 0; i < 300; i++) deep = { a: deep };
    expect(await outcome(g.put(own(), { data: deep })), 'a 300-deep object').toBe('request');
    expect(await outcome(g.put(own(), { data: '['.repeat(20_000) + ']'.repeat(20_000), headers: J })), 'a 20k-deep string').toBe('request');
    expect(wire()).toEqual([]);
    // Sent as judged: a string with trailing junk on a create travels as the JSON string Playwright makes of it.
    const junk = `{"name":"${RUN}-x"} junk`;
    await g.post('/api/v1/roles', { data: junk, headers: J });
    // ... a malformed-JSON negative case sends a Buffer, byte for byte, as application/json.
    await g.post('/api/v1/roles', { data: Buffer.from('{"name": ') });
    // ... a valid JSON string and an object go out unchanged (the same bytes Playwright makes without the guard).
    await g.patch(own('/users'), { data: ` ${JSON.stringify([OWN_USER])}` });
    await g.post('/api/v1/roles', { data: { name: `${RUN}-y`, description: 'REG', customAttributes: [] } });
    // ... `null` is sent as `null`; an object literal's prototype is never serialised (harmless).
    await g.patch(own('/users'), { data: null });
    await g.put(own(), { data: { __proto__: { userUuids: [FOREIGN_USER] }, name: `${RUN}-z` } });
    expect(A.mutations().map((a) => [a.method, a.body, a.headers['content-type']])).toEqual([
        ['POST', JSON.stringify(junk), 'application/json'],
        ['POST', '{"name": ', 'application/json'],
        ['PATCH', ` ${JSON.stringify([OWN_USER])}`, 'application/json'],
        ['POST', JSON.stringify({ name: `${RUN}-y`, description: 'REG', customAttributes: [] }), 'application/json'],
        ['PATCH', 'null', 'application/json'],
        ['PUT', JSON.stringify({ name: `${RUN}-z` }), 'application/json'],
    ]);
});

// path-less mutations: path-less mutations need an allow-listed create or bulk route with its DTO body; names and deny
// spellings are refused
test('path-less mutations need an allow-listed create or bulk route with its DTO body', async () => {
    const g = guard() as any; // eslint-disable-line @typescript-eslint/no-explicit-any
    const refused: Array<[string, string, string, unknown?]> = [
        // The legacy name-keyed client API, whatever own list the body carries
        ['DELETE', '/api/v1/operations/Some-RA/endentity/some-user', 'name-keyed end entity', [OWN_CERT]],
        ['PUT', '/api/v1/operations/Some-RA/endentity/some-user/resetPassword', 'name-keyed reset', [OWN_CERT]],
        ['POST', '/api/v1/operations/Some-RA/endentity/some-user', 'name-keyed edit', { uuids: [OWN_CERT] }],
        ['POST', '/api/v1/operations/Some-RA/certificate/revoke', 'revoke by name', { uuids: [OWN_CERT], reason: 'UNSPECIFIED' }],
        ['POST', '/api/v1/operations/tokens/certificate/issue', 'an RA profile named "tokens"', { uuids: [OWN_CERT] }],
        ['PATCH', '/api/v1/notifications', 'mark as read: no bulk route', [OWN_ROLE]],
        ['POST', '/api/v1/inspections', 'no create, no bulk route', [OWN_ROLE]],
        ['POST', '/api/v1/anything/else', 'an unknown path', [OWN_ROLE]],
        ['DELETE', '/api/v1/roles', 'no bulk role delete exists', { uuids: [OWN_ROLE] }],
        // `.suffix` spellings of denied endpoints
        ['PUT', '/api/v1/settings.json', 'settings.json', [OWN_ROLE]],
        ['PUT', '/api/v1/auditLogs/purge.', 'purge.', [OWN_ROLE]],
        ['PUT', '/api/v1/auditLogs/purge.json', 'purge.json', [OWN_ROLE]],
        // a segment that names an object
        ['PATCH', `/api/v1/roles/${OWN_ROLE}/someName`, 'a non-word segment', [OWN_USER]],
        ['PATCH', '/api/v1/roles/abcdefghijklmnopqrstuv/users', 'a 22-character segment', [OWN_USER]],
        ['PUT', '/api/v1/Roles/' + OWN_ROLE, 'a case variant of a word', {}],
        // Bulk bodies are exactly their DTO
        ['DELETE', '/api/v1/keys', 'an array route given an object', { uuids: [OWN_KEY] }],
        ['DELETE', '/api/v1/keys', 'Filters (case)', { uuids: [OWN_KEY], Filters: [{ x: 1 }] }],
        ['PATCH', '/api/v1/keys/compromise', 'selectAll / all / filter', { uuids: [OWN_KEY], reason: 'x', selectAll: true, all: true, filter: [] }],
        ['PATCH', '/api/v1/keys/compromise', 'isAll', { uuids: [OWN_KEY], isAll: true }],
        ['POST', '/api/v1/certificates/delete', 'uuids next to filters', { uuids: [OWN_CERT], filters: [] }],
        ['PATCH', '/api/v1/certificates', 'certificateUuids missing', { groupUuids: [] }],
        ['PATCH', '/api/v1/keys/disable', 'an empty list', []],
        ['PATCH', '/api/v1/keys/disable', 'a nested list', [[OWN_KEY]]],
    ];
    for (const [method, url, name, data] of refused) expect(await outcome(g.fetch(url, { method, data })), name).toBe('request');
    expect(await outcome(g.patch('/api/v1/raProfiles/disable', { data: [OWN_RA, FOREIGN_RA] })), 'one foreign uuid in a bulk list').toBe('ownership');
    expect(A.mutations()).toEqual([]);
    // Allow-listed bulk routes with their DTO bodies, and uuid-keyed operations, are sent.
    await g.patch('/api/v1/raProfiles/disable', { data: [OWN_RA] });
    await g.patch('/api/v1/keys/compromise', { data: { uuids: [OWN_KEY], reason: 'KEY_COMPROMISE' } });
    await g.post('/api/v1/certificates/delete', { data: { uuids: [OWN_CERT] } });
    await g.patch('/api/v1/certificates', { data: { certificateUuids: [OWN_CERT], raProfileUuid: FOREIGN_RA } });
    await g.post(`/api/v2/operations/authorities/${AUTH}/raProfiles/${FOREIGN_RA}/certificates/${OWN_CERT}/revoke`, { data: { reason: 'CESSATION_OF_OPERATION' } });
    expect(A.mutations().map((a) => `${a.method} ${a.url}`)).toEqual([
        'PATCH /api/v1/raProfiles/disable', 'PATCH /api/v1/keys/compromise', 'POST /api/v1/certificates/delete', 'PATCH /api/v1/certificates',
        `POST /api/v2/operations/authorities/${AUTH}/raProfiles/${FOREIGN_RA}/certificates/${OWN_CERT}/revoke`,
    ]);
});

test('base64 forms: real enum values pass; base64 forms count only under a uuid-shaped key', async () => {
    const g = guard() as any; // eslint-disable-line @typescript-eslint/no-explicit-any
    const b64url22 = Buffer.from(FOREIGN_KEY.replace(/-/g, ''), 'hex').toString('base64').replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
    for (const event of ['CERTIFICATE_DISCOVERED', 'CERTIFICATE_REGISTERED', 'SCHEDULED_JOB_FINISHED']) {
        await g.post('/api/v1/workflows/triggers', { data: { name: `${RUN}-t`, type: 'EVENT', event, resource: 'CERTIFICATE', actionsUuids: [], rulesUuids: [] } });
    }
    await g.post(`/api/v2/operations/authorities/${AUTH}/raProfiles/${OWN_RA}/certificates/${OWN_CERT}/revoke`, { data: { reason: 'CESSATION_OF_OPERATION', attributes: [] } });
    await g.post('/api/v1/roles', { data: { name: 'abcdefghijklmnopqrstuv', description: 'x' } });
    await g.put(own(), { data: { certificateFingerprint: 'x' } });
    await g.patch(own('/users'), { data: [OWN_USER], params: { reason: 'CESSATION_OF_OPERATION' } });
    expect(A.mutations()).toHaveLength(7);
    for (const [name, data, params] of [
        ['keyUuid', { request: 'x', keyUuid: b64url22 }, undefined],
        ['userUuids list', { userUuids: [b64url22] }, undefined],
        ['ids', { ids: [b64url22] }, undefined],
        ['id', { id: b64url22 }, undefined],
        ['a top-level array (List<UUID>)', [b64url22], undefined],
        ['query certificateUuid', [OWN_USER], { certificateUuid: b64url22 }],
    ] as const) {
        const url = name === 'keyUuid' ? `/api/v2/operations/authorities/${AUTH}/raProfiles/${OWN_RA}/certificates/${OWN_CERT}/issue` : own('/users');
        expect(await outcome(g.fetch(url, { method: name === 'keyUuid' ? 'POST' : 'PATCH', data, ...(params ? { params } : {}) })), name).toBe('request');
    }
    // Lenient / padded / urn forms stay refused under any key.
    for (const v of ['0-0-4000-8000-2', ` ${FOREIGN_USER}`, `urn:uuid:${FOREIGN_USER}`]) expect(await outcome(g.put(own(), { data: { description: v } })), v).toBe('request');
    expect(A.mutations()).toHaveLength(7);
});

// minor cases: GETs that persist something run on own objects only; encoded spellings and raw contexts are the same endpoint
test('minor cases: persisting GETs run on own objects only; encoded spellings are the same endpoint', async () => {
    const g = guard() as any; // eslint-disable-line @typescript-eslint/no-explicit-any
    const probe = g.probeUuid();
    const refused: Array<[string, RefusalKind]> = [
        [`/api/v1/certificates/${FOREIGN_CERT}/validate`, 'ownership'],
        [`/api/v1/certificates/${FOREIGN_CERT}/valid%61te`, 'ownership'],
        // A `;` anywhere in a GET path is refused before the side-effect rule (request, not ownership).
        [`/api/v1/certificates/${FOREIGN_CERT}/validate;x=1`, 'request'],
        [`/api/v%31/certificates/${FOREIGN_CERT}/validate`, 'ownership'],
        [`/api/v1/certificates/${FOREIGN_CERT}/chain`, 'ownership'],
        [`/api/v1/certificates/${FOREIGN_CERT}/chain/pem`, 'ownership'],
        [`/api/v1/tokens/${FOREIGN_CERT}`, 'ownership'],
        [`/api/v1/secrets/${FOREIGN_CERT}/content`, 'ownership'],
        [`/api/v1/authorities/${AUTH}/raProfiles/${FOREIGN_RA}/caCertificates`, 'ownership'],
        ['/api/v1/certificates/+0000000-0000-4000-8000-000000000011/validate', 'request'],
        ['/api/v1/approvals', 'request'],
        ['/api/v1/approvals/user', 'request'],
        ['/api/v2/oauth2/providers', 'request'],
    ];
    for (const [url, kind] of refused) {
        expect(await outcome(g.get(url)), url).toBe(kind);
        expect(await outcome(g.head(url)), `HEAD ${url}`).toBe(kind);
    }
    expect(sentTo(A)).toEqual([]);
    // A raw authenticated GET (regressionApi apiJson) is refused too: it cannot prove ownership.
    await withProcessEnv({ BASE_URL }, async () => {
        await expect(apiJson(raw, 'GET', `/api/v1/certificates/${OWN_CERT}/validate`)).rejects.toThrow(/persists something/);
    });
    expect(sentTo(A)).toEqual([]);
    // Controls: own and probe objects, and ordinary reads.
    await g.get(`/api/v1/certificates/${OWN_CERT}/validate`, { failOnStatusCode: false });
    await g.get(`/api/v1/certificates/${probe}/validate`, { failOnStatusCode: false });
    await g.get(`/api/v1/certificates/${FOREIGN_CERT}`, { failOnStatusCode: false });
    await g.get(`/api/v1/tokens/${FOREIGN_CERT}/tokenProfiles`, { failOnStatusCode: false });
    // A connector's health check is a plain read (guardedApiPlainTextAndHealth.spec.ts).
    await g.get(`/api/v1/connectors/${FOREIGN_CERT}/health`, { failOnStatusCode: false });
    expect(sentTo(A)).toEqual([
        `GET /api/v1/certificates/${OWN_CERT}/validate`, `GET /api/v1/certificates/${probe}/validate`,
        `GET /api/v1/certificates/${FOREIGN_CERT}`, `GET /api/v1/tokens/${FOREIGN_CERT}/tokenProfiles`,
        `GET /api/v1/connectors/${FOREIGN_CERT}/health`,
    ]);
});

// input snapshot: redirects never carry the token elsewhere — a mutation follows none, a GET only same-origin ones the guard
// re-judges
test('input snapshot: redirects never carry the token elsewhere; a mutation follows none', async () => {
    const g = guard() as any; // eslint-disable-line @typescript-eslint/no-explicit-any
    // GET 307 to another origin: not followed, the 3xx is the answer.
    expect((await g.get('/api/v1/redirect/elsewhere')).status()).toBe(307);
    // GET 302 to a side-effect GET of a foreign object: not followed.
    expect((await g.get('/api/v1/redirect/effect')).status()).toBe(302);
    // A redirect loop ends after maxRedirects hops (here 2).
    expect((await g.get('/api/v1/redirect/loop', { maxRedirects: 2 })).status()).toBe(302);
    // GET 302 on the same origin: followed by the guard, which judged the target like any GET.
    const same = await g.get('/api/v1/redirect/same');
    expect([same.status(), (await same.json()).name]).toEqual([200, `${RUN}-role`]);
    expect(A.arrived.map((a) => `${a.method} ${a.url}`)).toEqual([
        'GET /api/v1/redirect/elsewhere', 'GET /api/v1/redirect/effect',
        'GET /api/v1/redirect/loop', 'GET /api/v1/redirect/loop', 'GET /api/v1/redirect/loop',
        'GET /api/v1/redirect/same', `GET /api/v1/roles/${OWN_ROLE}`,
    ]);
    expect(A.arrived.at(-1)?.headers.authorization).toBe('Bearer SECRET-TOKEN');
    // A mutation answered with a 307 to another origin: the DELETE is not repeated there.
    redirectMutations = true;
    expect((await g.delete(own())).status()).toBe(307);
    expect(B.arrived, 'the other origin saw nothing (no GET and no foreign DELETE with the token)').toEqual([]);
});

test('edge cases: URL forms, the string-only reference waiver, `_method` on a raw read POST', async () => {
    const g = guard() as any; // eslint-disable-line @typescript-eslint/no-explicit-any
    for (const u of ['http:api/v1/roles', `http:/api/v1/roles/${OWN_ROLE}`, `//127.0.0.1:${A.port}/api/v1/roles`, `//127.0.0.1:${B.port}/api/v1/roles`, 'api/v1/roles', '?x=1', '#/api/v1/roles', './api/v1/roles']) {
        expect(await outcome(g.get(u)), `GET ${u}`).toBe('request');
        expect(await outcome(g.delete(u)), `DELETE ${u}`).toBe('request');
    }
    expect(A.arrived).toEqual([]);
    expect(B.arrived).toEqual([]);
    // A reference field waives a canonical STRING only; a list or an object under it is scanned like any value.
    expect(await outcome(g.put(`/api/v1/certificates/${OWN_CERT}`, { data: { raProfileUuid: [FOREIGN_RA] } }))).toBe('ownership');
    expect(await outcome(g.put(`/api/v1/certificates/${OWN_CERT}`, { data: { raProfileUuid: { a: FOREIGN_RA } } }))).toBe('ownership');
    await g.put(`/api/v1/certificates/${OWN_CERT}`, { data: { raProfileUuid: FOREIGN_RA } });
    // `_method` (Spring's HiddenHttpMethodFilter) on a raw read POST, any case, URL or params.
    for (const u of ['/api/v1/certificates?_method=DELETE', '/api/v1/certificates?_METHOD=PUT']) expect(() => allowedRawPost(u, { env: { BASE_URL } }), u).toThrow(/_method/);
    expect(await outcome(g.post('/api/v1/certificates', { data: {}, params: { _Method: 'DELETE' } }))).toBe('request');
    await withProcessEnv({ BASE_URL }, async () => {
        await expect(apiJson(raw, 'POST', '/api/v1/certificates?_method=DELETE', {})).rejects.toThrow(/_method/);
    });
    expect(A.mutations().map((a) => `${a.method} ${a.url}`)).toEqual([`PUT /api/v1/certificates/${OWN_CERT}`]);
    // Absolute URLs on BASE_URL's origin stay fine.
    await g.get(`${A.origin}/api/v1/roles/${OWN_ROLE}`);
    expect(A.arrived.at(-1)?.url).toBe(`/api/v1/roles/${OWN_ROLE}`);
});
