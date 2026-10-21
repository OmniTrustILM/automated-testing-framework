/**
 * The guard judges what is SENT, on the wire (a real Playwright context, a loopback fake core): a URL with a control,
 * space or non-ASCII character is refused before parsing, the path as written must be the path sent (no dot segments),
 * non-canonical uuid forms are refused, and reads go to BASE_URL's origin only, so the token never reaches another host.
 */
import { APIRequestContext, expect, request, test } from '@playwright/test';
import { allowedRawPost } from '../../utils/regression/guard/rawPost';
import { guardApiWithSeams } from '../../utils/regression/guard/createGuard';
import { OwnObjectViolation, RefusalKind } from '../../utils/regression/ledger/ownership';
import { apiJson } from '../../utils/regression/apiReads';
import { LedgerLine } from '../../utils/regression/ledger/ledger';
import { Arrived, loopbackServer, LoopbackServer } from './helpers/loopbackServer';
import { registerGuardRig, withProcessEnv } from './helpers/guardRig';

const RUN = 'qa-reg-20261013-120000-ab12';
const U = (n: number) => `00000000-0000-4000-8000-${String(n).padStart(12, '0')}`;
const OWN_RA = U(1);
const FOREIGN_RA = U(2);
const OWN_ROLE = U(3);
const OWN_CERT = U(5);
const OWN_USER = U(6);
const AUTH = U(9);
const FOREIGN_USER = U(10);
const FOREIGN_ROLE = U(20);
const FOREIGN_KEY = 'a1b2c3d4-1111-4222-8333-444455556666';

const lines: LedgerLine[] = [
    { at: 'a', runId: RUN, type: 'raProfiles', name: `${RUN}-ra`, uuid: OWN_RA, spec: 'T', event: 'created' },
    { at: 'a', runId: RUN, type: 'roles', name: `${RUN}-role`, uuid: OWN_ROLE, spec: 'T', event: 'created' },
    { at: 'a', runId: RUN, type: 'users', name: `${RUN}-user`, uuid: OWN_USER, spec: 'T', event: 'created' },
    { at: 'a', runId: RUN, type: 'certificates', name: `${RUN}.example.test`, uuid: OWN_CERT, spec: 'T', event: 'created' },
];

/** The fake core's live objects (GET); everything else GET answers 404, every other method 200 `{}`. */
const live: Record<string, unknown> = {
    [`/api/v1/raProfiles/${OWN_RA}`]: { name: `${RUN}-ra` },
    [`/api/v1/roles/${OWN_ROLE}`]: { name: `${RUN}-role` },
    [`/api/v1/users/${OWN_USER}`]: { username: `${RUN}-user` },
    [`/api/v1/certificates/${OWN_CERT}`]: { commonName: `${RUN}.example.test` },
    [`/api/v1/roles/${FOREIGN_ROLE}`]: { name: 'Administrators' },
};
const coreAnswer = (a: Arrived) => (a.method === 'GET' || a.method === 'HEAD' ? (live[a.url] ? { status: 200, body: live[a.url] } : { status: 404, body: {} }) : undefined);

const b64 = (u: string) => Buffer.from(u.replace(/-/g, ''), 'hex').toString('base64');
const b64url = (u: string) => b64(u).replace(/\+/g, '-').replace(/\//g, '_');
const b64url22 = (u: string) => b64url(u).replace(/=+$/, '');

let A: LoopbackServer;
let B: LoopbackServer;
let raw: APIRequestContext;
let BASE_URL: string;

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

/** The refusal kind of a guarded call, or 'sent' when it went through. */
async function outcome(call: Promise<unknown>): Promise<RefusalKind | 'sent' | string> {
    try {
        await call;
        return 'sent';
    } catch (e) {
        return e instanceof OwnObjectViolation ? e.kind : `error: ${String(e).slice(0, 120)}`;
    }
}

const wire = (s: LoopbackServer) => s.mutations().map((a) => `${a.method} ${a.url}`);

test('characterisation: without the guard, Playwright strips tab / LF, trims spaces and serialises toJSON', async () => {
    const F = FOREIGN_ROLE;
    const sent = async (u: string) => {
        A.reset();
        await raw.fetch(u, { method: 'PATCH', data: [] });
        return wire(A);
    };
    // This is why the guard must judge the URL as sent, not as written (N1).
    expect(await sent(`/api/v1/roles/${F}\t/users`)).toEqual([`PATCH /api/v1/roles/${F}/users`]);
    expect(await sent(`/api/v1/roles/${F}\n/users`)).toEqual([`PATCH /api/v1/roles/${F}/users`]);
    expect(await sent(`/api/v1/roles/${F.slice(0, 18)}\t${F.slice(18)}/users`)).toEqual([`PATCH /api/v1/roles/${F}/users`]);
    expect(await sent(` /api/v1/roles/${F}`)).toEqual([`PATCH /api/v1/roles/${F}`]);
    expect(await sent(`/api/v1/roles/${F}\t`)).toEqual([`PATCH /api/v1/roles/${F}`]);
    // ... and dot segments are normalised (N2).
    expect(await sent('/api/v1/protocols/acme/x/.\t./.\t./.\t./auditLogs/purge')).toEqual(['PATCH /api/v1/auditLogs/purge']);
    // A data object is sent as JSON.stringify(data): toJSON wins (the guard walks JSON.parse(JSON.stringify(data))).
    A.reset();
    await raw.fetch('/api/v1/x', { method: 'PATCH', data: { toJSON: () => ['FROM-TOJSON'] } as unknown as object });
    expect(A.mutations()[0].body).toBe('["FROM-TOJSON"]');
});

// control characters: a foreign uuid with a trailing space / tab / NUL / \\u0001 / LF / CR, or a tab inside it, never reaches
// the server
test('control characters: a foreign uuid with trailing space, tab, NUL, LF or CR never reaches the server', async () => {
    const g = guard();
    const F = FOREIGN_ROLE;
    const vectors: Array<[string, () => Promise<unknown>]> = [
        ['trailing space + own list body', () => g.delete(`/api/v1/roles/${F} `, { data: [OWN_ROLE] })],
        ['trailing tab + own list body', () => g.delete(`/api/v1/roles/${F}\t`, { data: [OWN_ROLE] })],
        ['trailing tab, no body', () => g.delete(`/api/v1/roles/${F}\t`)],
        ['trailing NUL', () => g.delete(`/api/v1/roles/${F}\u0000`, { data: [OWN_ROLE] })],
        ['trailing \\u0001', () => g.delete(`/api/v1/roles/${F}\u0001`, { data: [OWN_ROLE] })],
        ['trailing LF', () => g.delete(`/api/v1/roles/${F}\n`, { data: [OWN_ROLE] })],
        ['trailing CR', () => g.delete(`/api/v1/roles/${F}\r`, { data: [OWN_ROLE] })],
        ['tab inside the uuid (PATCH users)', () => g.patch(`/api/v1/roles/${F.slice(0, 18)}\t${F.slice(18)}/users`, { data: [OWN_USER] })],
        ['LF after the uuid (PUT + own list)', () => g.put(`/api/v1/roles/${F}\n`, { data: { name: 'x', userUuids: [OWN_USER] } })],
        ['raw space segment', () => g.patch(`/api/v1/roles/${F} /users`, { data: [OWN_USER] })],
        ['leading space, whole URL', () => g.delete(` /api/v1/roles/${F}`)],
        ['DEL character', () => g.delete(`/api/v1/roles/${F}\u007f`)],
        ['C1 character', () => g.delete(`/api/v1/roles/${F}\u0085`)],
        ['full-width digits', () => g.patch(`/api/v1/roles/${F.replace(/0/g, '０')}/users`, { data: [OWN_USER] })],
        ['query: tab inside a uuid', () => g.patch(`/api/v1/roles/${OWN_ROLE}?x=${FOREIGN_USER.slice(0, 18)}\t${FOREIGN_USER.slice(18)}`)],
        ['query: LF inside a uuid', () => g.patch(`/api/v1/roles/${OWN_ROLE}?x=${FOREIGN_USER.slice(0, 18)}\n${FOREIGN_USER.slice(18)}`)],
        ['GET with a tab (the origin check reads the URL as sent too)', () => g.get(`/api/v1/roles/${F}\t`)],
    ];
    for (const [name, call] of vectors) {
        expect(await outcome(call()), name).toBe('request');
    }
    expect(wire(A), 'no mutation reached the server').toEqual([]);
    expect(A.arrived, 'not even a read: refused before the live check').toEqual([]);
    // Control: the own role, written plainly, is deleted.
    await g.delete(`/api/v1/roles/${OWN_ROLE}`);
    expect(wire(A)).toEqual([`DELETE /api/v1/roles/${OWN_ROLE}`]);
});

// dot segments: dot segments (plain, tab-split, encoded, backslash) never move a protocol / read POST onto a platform endpoint
test('dot segments (plain, tab-split, encoded, backslash) never reach a platform endpoint via POST', async () => {
    const g = guard();
    const targets = ['auditLogs/purge', 'cboms/sync', 'local/admins'];
    for (const t of targets) {
        for (const prefix of ['/api/v1/protocols/acme/x', '/api/v1/workflows/events/x']) {
            const variants = [
                `${prefix}/../../../${t}`,
                `${prefix}/.\t./.\t./.\t./${t}`,
                `${prefix}/..\t/..\t/..\t/${t}`,
                `${prefix}/%2e%2e/%2e%2e/%2e%2e/${t}`,
                `${prefix}\\..\\..\\..\\${t}`,
                `${prefix}/./../../../${t}`,
            ];
            for (const v of variants) {
                expect(await outcome(g.post(v, { data: [] })), JSON.stringify(v)).toBe('request');
                expect(() => allowedRawPost(v, { env: { BASE_URL } }), JSON.stringify(v)).toThrow(OwnObjectViolation);
            }
        }
    }
    expect(A.arrived, 'nothing reached the server').toEqual([]);
    // The raw-context path: allowedRawPost refuses before the raw context is ever asked.
    let rawCalled = false;
    const attempt = async () => {
        const u = allowedRawPost('/api/v1/protocols/acme/x/.\t./.\t./.\t./auditLogs/purge', { env: { BASE_URL } });
        rawCalled = true;
        await raw.post(u, { data: [] });
    };
    await expect(attempt()).rejects.toThrow(/control character/);
    expect([rawCalled, A.arrived]).toEqual([false, []]);
    // Controls: real protocol and read POSTs still go out, exactly as written.
    await g.post('/api/v1/protocols/acme/raProfile/qa-reg-20261013-120000-ab12-ra/new-order', { data: {} });
    await g.post('/api/v1/workflows/events/certificateStatusChanged/history', { data: {} });
    await raw.post(allowedRawPost('/api/v1/certificates', { env: { BASE_URL } }), { data: { filters: [] } });
    expect(wire(A)).toEqual([
        'POST /api/v1/protocols/acme/raProfile/qa-reg-20261013-120000-ab12-ra/new-order',
        'POST /api/v1/workflows/events/certificateStatusChanged/history',
        'POST /api/v1/certificates',
    ]);
});

// origin: GET / HEAD / fetch, raw read POSTs and apiJson on an authenticated context never carry the token to another host
test('origin: GET, HEAD, fetch, read POSTs and apiJson on an authenticated context never leak the token', async () => {
    const g = guard();
    const elsewhere = `${B.origin}/api/v1/roles`;
    expect(await outcome(g.get(elsewhere))).toBe('request');
    expect(await outcome(g.head(elsewhere))).toBe('request');
    expect(await outcome(g.fetch(elsewhere, { method: 'GET' }))).toBe('request');
    expect(await outcome(g.get(`//127.0.0.1:${B.port}/api/v1/roles`)), 'protocol-relative').toBe('request');
    expect(await outcome(g.get(`http://localhost:${A.port}/api/v1/roles`)), 'another host name for the same server is another origin').toBe('request');
    expect(await outcome(g.get(`http://user@127.0.0.1:${A.port}/api/v1/roles`)), 'user info').toBe('request');
    expect(() => allowedRawPost(`${B.origin}/api/v1/certificates`, { env: { BASE_URL } }), 'a raw read POST').toThrow(/origin is not BASE_URL/);
    await withProcessEnv({ BASE_URL }, async () => {
        await expect(apiJson(raw, 'GET', elsewhere), 'regressionApi apiJson GET with a raw context').rejects.toThrow(/origin is not BASE_URL/);
        await expect(apiJson(raw, 'POST', `${B.origin}/api/v1/certificates`, { filters: [] }), 'apiJson raw read POST').rejects.toThrow(/origin is not BASE_URL/);
        // Controls on the own origin: a relative GET and a read POST through the raw context.
        await apiJson(raw, 'GET', `/api/v1/roles/${OWN_ROLE}`);
        await apiJson(raw, 'POST', '/api/v1/certificates', { filters: [] });
    });
    expect(B.arrived, 'the other host saw nothing — no request, no Authorization, no client certificate').toEqual([]);
    expect(A.arrived.map((a) => `${a.method} ${a.url}`)).toEqual([`GET /api/v1/roles/${OWN_ROLE}`, 'POST /api/v1/certificates']);
    expect(A.arrived[0].headers.authorization, 'the token goes to BASE_URL\'s origin').toBe('Bearer SECRET-TOKEN');
    // The ACME client sends no credentials: its directory may name another host (unauthenticated: true).
    expect(allowedRawPost(`${B.origin}/api/v1/protocols/acme/raProfile/x/new-order`, { env: { BASE_URL }, unauthenticated: true })).toContain(B.origin);
    // A guarded GET on the own origin (control).
    await g.get(`${A.origin}/api/v1/roles/${OWN_ROLE}`);
    expect(A.arrived.at(-1)?.url).toBe(`/api/v1/roles/${OWN_ROLE}`);
});

interface Case {
    name: string;
    method: string;
    url: string;
    data?: unknown;
    options?: Record<string, unknown>;
    expect: RefusalKind | 'sent';
    /** For a sent case: what must have arrived (`METHOD /path?query`). */
    arrived?: string;
    /** For a sent case: a string the arrived body must NOT contain. */
    bodyWithout?: string;
}

/** The adversarial table, with the guard's verdict per row. */
function adversarialTable(): Case[] {
    const OTHER = B.origin;
    const own = (u: string) => `/api/v1/roles/${OWN_ROLE}${u}`;
    return [
        { name: 'JSON string body, foreign user', method: 'PATCH', url: own('/users'), data: JSON.stringify([FOREIGN_USER]), expect: 'ownership' },
        { name: 'Buffer body, foreign user', method: 'PATCH', url: own('/users'), data: Buffer.from(JSON.stringify([FOREIGN_USER])), expect: 'ownership' },
        { name: 'Uint8Array body: sent as Playwright serialises it (an index object), no uuid on the wire', method: 'PATCH', url: own('/users'),
            data: new Uint8Array(Buffer.from(JSON.stringify([FOREIGN_USER]))), expect: 'sent', arrived: `PATCH ${own('/users')}`, bodyWithout: FOREIGN_USER },
        { name: 'ArrayBuffer body: sent as {}', method: 'PATCH', url: own('/users'), data: new Uint8Array(Buffer.from(JSON.stringify([FOREIGN_USER]))).buffer,
            expect: 'sent', arrived: `PATCH ${own('/users')}`, bodyWithout: FOREIGN_USER },
        { name: 'UTF-16 Buffer body (NUL bytes)', method: 'PATCH', url: own('/users'), data: Buffer.from(JSON.stringify([FOREIGN_USER]), 'utf16le'), expect: 'request' },
        { name: 'form body', method: 'PUT', url: own(''), options: { form: { userUuids: FOREIGN_USER } }, expect: 'request' },
        { name: 'multipart body', method: 'POST', url: own('/x'), options: { multipart: { a: 'b' } }, expect: 'request' },
        { name: 'form via an urlencoded string body + header', method: 'PUT', url: own(''), data: `userUuids=${FOREIGN_USER}`,
            options: { headers: { 'content-type': 'application/x-www-form-urlencoded' } }, expect: 'request' },
        { name: 'query uuid foreign', method: 'PATCH', url: `${own('')}?userUuid=${FOREIGN_USER}`, expect: 'ownership' },
        { name: 'params uuid foreign', method: 'PATCH', url: own(''), options: { params: { x: FOREIGN_USER } }, expect: 'ownership' },
        { name: 'params uuid foreign, key side', method: 'PATCH', url: own(''), options: { params: { [FOREIGN_USER]: '1' } }, expect: 'ownership' },
        { name: 'singular ownerUuid foreign', method: 'PUT', url: own(''), data: { ownerUuid: FOREIGN_USER }, expect: 'ownership' },
        { name: 'body key uuid foreign', method: 'PUT', url: own(''), data: { uuid: FOREIGN_USER }, expect: 'ownership' },
        { name: 'uuid-valued MAP KEY (N3: keys are scanned)', method: 'PUT', url: own(''), data: { map: { [FOREIGN_USER]: ['read'] } }, expect: 'ownership' },
        { name: 'leading space in a body uuid (N3)', method: 'PUT', url: own(''), data: { userUuids: [` ${FOREIGN_USER}`] }, expect: 'request' },
        { name: 'trailing newline in a body uuid (N3)', method: 'PUT', url: own(''), data: { userUuids: [`${FOREIGN_USER}\n`] }, expect: 'request' },
        { name: 'upper-case body uuid (canonical, either case)', method: 'PUT', url: own(''), data: { userUuids: [FOREIGN_USER.toUpperCase()] }, expect: 'ownership' },
        { name: '24-char base64 (standard)', method: 'PUT', url: own(''), data: { userUuids: [b64(FOREIGN_KEY)] }, expect: 'request' },
        { name: '24-char base64 (URL-safe, padded)', method: 'PUT', url: own(''), data: { userUuids: [b64url(FOREIGN_KEY)] }, expect: 'request' },
        { name: '22-char base64 (URL-safe, unpadded)', method: 'PUT', url: own(''), data: { userUuids: [b64url22(FOREIGN_KEY)] }, expect: 'request' },
        { name: '22-char base64 (standard, unpadded)', method: 'PUT', url: own(''), data: { userUuids: [b64(FOREIGN_KEY).replace(/=+$/, '')] }, expect: 'request' },
        { name: 'lenient short groups', method: 'PUT', url: own(''), data: { userUuids: ['0-0-4000-8000-2'] }, expect: 'request' },
        { name: 'plus-sign alias', method: 'PUT', url: own(''), data: { userUuids: ['+0000000-0000-4000-8000-000000000002'] }, expect: 'request' },
        { name: 'over-long first group', method: 'PUT', url: own(''), data: { userUuids: ['100000000-0-4000-8000-000000000002'] }, expect: 'request' },
        { name: 'urn:uuid: prefix', method: 'PUT', url: own(''), data: { userUuids: [`urn:uuid:${FOREIGN_USER}`] }, expect: 'request' },
        { name: 'a uuid inside a longer string (comma list)', method: 'PUT', url: own(''), data: { userUuids: [`${OWN_USER},${FOREIGN_USER}`] }, expect: 'ownership' },
        { name: 'a uuid inside an attribute subtree (content is not an association)', method: 'PUT', url: own(''),
            data: { customAttributes: [{ content: [{ data: FOREIGN_USER }] }] }, expect: 'sent', arrived: `PUT ${own('')}` },
        { name: 'a uuid under a key called metadata (attribute subtree, open point)', method: 'PUT', url: own(''), data: { metadata: { ownerUuid: FOREIGN_USER } },
            expect: 'sent', arrived: `PUT ${own('')}` },
        { name: 'reference raProfileUuid on a PUT of an own role (a top-level reference field)', method: 'PUT', url: own(''), data: { raProfileUuid: FOREIGN_RA },
            expect: 'sent', arrived: `PUT ${own('')}` },
        { name: 'reference raProfileUuid on an own ACME profile create', method: 'POST', url: '/api/v1/acmeProfiles', data: { name: `${RUN}-a`, raProfileUuid: FOREIGN_RA },
            expect: 'sent', arrived: 'POST /api/v1/acmeProfiles' },
        { name: 'reference field in a LENIENT form (N3: never waived)', method: 'POST', url: '/api/v1/acmeProfiles', data: { name: `${RUN}-a`, raProfileUuid: '0-0-4000-8000-2' },
            expect: 'request' },
        { name: 'reference connectorUuid nested in an array (top-level only)', method: 'POST', url: '/api/v1/authorities',
            data: { name: `${RUN}-a`, nested: [{ connectorUuid: FOREIGN_RA }] }, expect: 'ownership' },
        { name: 'users create with a top-level raProfileUuid', method: 'POST', url: '/api/v1/users', data: { username: `${RUN}-u`, raProfileUuid: FOREIGN_RA },
            expect: 'sent', arrived: 'POST /api/v1/users' },
        { name: 'reference raProfileUuid + foreign groupUuids', method: 'POST', url: '/api/v1/acmeProfiles',
            data: { name: `${RUN}-a`, raProfileUuid: FOREIGN_RA, groupUuids: [FOREIGN_USER] }, expect: 'ownership' },
        { name: 'absolute URL, other origin', method: 'DELETE', url: `${OTHER}/api/v1/roles/${OWN_ROLE}`, expect: 'request' },
        { name: 'absolute URL, user-info trick', method: 'DELETE', url: `http://127.0.0.1:${A.port}@127.0.0.1:${B.port}/api/v1/roles/${OWN_ROLE}`, expect: 'request' },
        { name: 'absolute URL, same origin', method: 'DELETE', url: `${A.origin}/api/v1/roles/${OWN_ROLE}`, expect: 'sent', arrived: `DELETE /api/v1/roles/${OWN_ROLE}` },
        { name: 'protocol-relative, other origin', method: 'DELETE', url: `//127.0.0.1:${B.port}/api/v1/roles/${OWN_ROLE}`, expect: 'request' },
        { name: 'other origin, upper-case scheme', method: 'DELETE', url: `HTTP://127.0.0.1:${B.port}/api/v1/roles/${OWN_ROLE}`, expect: 'request' },
        { name: 'same server under another host name', method: 'DELETE', url: `http://localhost:${A.port}/api/v1/roles/${OWN_ROLE}`, expect: 'request' },
        { name: 'settings PUT', method: 'PUT', url: '/api/v1/settings/platform', data: {}, expect: 'request' },
        { name: 'settings PUT, trailing slash', method: 'PUT', url: '/api/v1/settings/platform/', data: {}, expect: 'request' },
        { name: 'settings PATCH with an own uuid', method: 'PATCH', url: `/api/v1/settings/${OWN_ROLE}`, data: {}, expect: 'request' },
        { name: 'scheduler', method: 'POST', url: '/api/v1/scheduler/jobs', data: {}, expect: 'request' },
        { name: 'settings, upper-case path + own list', method: 'PUT', url: '/api/v1/Settings/platform', data: [OWN_ROLE], expect: 'request' },
        { name: 'settings v2 + own list', method: 'PUT', url: '/api/v2/settings/platform', data: [OWN_ROLE], expect: 'request' },
        { name: 'a relative path without a leading slash (resolves under BASE_URL\'s path)', method: 'PUT', url: 'api/v1/settings/platform', data: {}, expect: 'request' },
        { name: 'auth profile', method: 'PUT', url: '/api/v1/auth/profile', data: {}, expect: 'request' },
        { name: 'auth profile, trailing slash', method: 'PUT', url: '/api/v1/auth/profile/', data: {}, expect: 'request' },
        { name: 'events, no object', method: 'POST', url: '/api/v1/workflows/events', data: { triggerUuids: [] }, expect: 'request' },
        { name: 'events, objectUuid blank', method: 'POST', url: '/api/v1/workflows/events', data: { objectUuid: ' ', triggerUuids: [] }, expect: 'request' },
        { name: 'events, objectUuid=true + own triggers', method: 'POST', url: '/api/v1/workflows/events', data: { objectUuid: true, triggerUuids: [OWN_ROLE] }, expect: 'request' },
        // An object-level event association is an allow-listed CREATE (POST_CREATE); its object is own.
        // `objectUuid` is typed by its sibling `resource` (the DTO requires it); without one it takes probes only.
        { name: 'events, own objectUuid in a string body, EMPTY triggerUuids', method: 'POST', url: '/api/v1/workflows/events',
            data: JSON.stringify({ resource: 'certificates', objectUuid: OWN_CERT, triggerUuids: [] }), expect: 'sent', arrived: 'POST /api/v1/workflows/events' },
        { name: 'events, own objectUuid without its resource code', method: 'POST', url: '/api/v1/workflows/events',
            data: JSON.stringify({ objectUuid: OWN_CERT, triggerUuids: [] }), expect: 'request' },
        { name: 'events, body is an array', method: 'POST', url: '/api/v1/workflows/events', data: [], expect: 'request' },
        { name: 'events, Buffer without objectUuid', method: 'POST', url: '/api/v1/workflows/events', data: Buffer.from('{"triggerUuids":[]}'), expect: 'request' },
        { name: 'trusted certificates', method: 'DELETE', url: `/api/v1/trustedCertificates/${OWN_CERT}`, expect: 'request' },
        { name: 'connectors approve (bulk)', method: 'PUT', url: '/api/v1/connectors/approve', data: [OWN_ROLE], expect: 'request' },
        { name: 'OID PUT (no uuid)', method: 'PUT', url: '/api/v1/oids/1.2.3', data: { displayName: 'x' }, expect: 'request' },
        { name: 'OID PUT with an own list', method: 'PUT', url: '/api/v1/oids/1.2.3', data: [OWN_ROLE], expect: 'request' },
        { name: 'auth logout POST (no explicit list)', method: 'POST', url: '/api/v1/auth/logout', expect: 'request' },
        { name: 'audit log purge', method: 'DELETE', url: '/api/v1/auditLogs/purge', expect: 'request' },
        { name: 'notifications read-all', method: 'PUT', url: '/api/v1/notifications/readAll', expect: 'request' },
        // A path-less mutation off the create / bulk allow-lists is refused, whatever its body names.
        { name: 'an unknown path with an own top-level list', method: 'POST', url: '/api/v1/anything/else', data: [OWN_ROLE], expect: 'request' },
        { name: 'method override via _method', method: 'DELETE', url: `/api/v1/roles/${OWN_ROLE}?_method=PUT`, expect: 'request' },
        { name: 'method override, lower-case header', method: 'POST', url: own('/x'), data: {}, options: { headers: { 'x-http-method-override': 'DELETE' } }, expect: 'request' },
        { name: 'method override, mixed-case header on a create', method: 'POST', url: '/api/v1/roles', data: { name: 'x' }, options: { headers: { 'X-Http-Method-Override': 'DELETE' } }, expect: 'request' },
        { name: 'X-Forwarded-Method header', method: 'POST', url: '/api/v1/roles', data: { name: 'x' }, options: { headers: { 'X-Forwarded-Method': 'DELETE' } }, expect: 'request' },
        { name: 'path TAB trick', method: 'PATCH', url: `/api/v1/roles/${FOREIGN_ROLE}\t/users`, data: [OWN_USER], expect: 'request' },
        { name: 'path NEWLINE trick', method: 'PATCH', url: `/api/v1/roles/${FOREIGN_ROLE}\n/users`, data: [OWN_USER], expect: 'request' },
        { name: 'path CR trick', method: 'PATCH', url: `/api/v1/roles/${FOREIGN_ROLE}\r/users`, data: [OWN_USER], expect: 'request' },
        { name: 'path tab INSIDE the uuid', method: 'PATCH', url: `/api/v1/roles/${FOREIGN_ROLE.slice(0, 18)}\t${FOREIGN_ROLE.slice(18)}/users`, data: [OWN_USER], expect: 'request' },
        { name: 'path raw SPACE', method: 'PATCH', url: `/api/v1/roles/${FOREIGN_ROLE} /users`, data: [OWN_USER], expect: 'request' },
        { name: 'path Unicode digits', method: 'PATCH', url: `/api/v1/roles/${FOREIGN_ROLE.replace(/0/g, '０')}/users`, data: [OWN_USER], expect: 'request' },
        { name: 'path +alias', method: 'PATCH', url: '/api/v1/roles/+0000000-0000-4000-8000-000000000020/users', data: [OWN_USER], expect: 'request' },
        { name: 'path short-group alias', method: 'PATCH', url: '/api/v1/roles/0-0-4000-8000-20/users', data: [OWN_USER], expect: 'request' },
        { name: 'path foreign uuid with a trailing dot', method: 'PATCH', url: `/api/v1/roles/${FOREIGN_ROLE}./users`, data: [OWN_USER], expect: 'request' },
        { name: 'path 22-char base64url segment', method: 'PATCH', url: `/api/v1/roles/${b64url22(FOREIGN_KEY)}/users`, data: [OWN_USER], expect: 'request' },
        { name: 'query TAB inside a uuid', method: 'PATCH', url: `${own('')}?x=${FOREIGN_USER.slice(0, 18)}\t${FOREIGN_USER.slice(18)}`, expect: 'request' },
        { name: 'query NEWLINE inside a uuid', method: 'PATCH', url: `${own('')}?x=${FOREIGN_USER.slice(0, 18)}\n${FOREIGN_USER.slice(18)}`, expect: 'request' },
        { name: 'query percent-encoded uuid (decoded like the server does)', method: 'PATCH', url: `${own('')}?x=%30${FOREIGN_USER.slice(1)}`, expect: 'ownership' },
        // Base64 counts as a uuid only under a uuid-shaped key.
        { name: 'query URL-safe base64 uuid under a uuid-shaped key', method: 'PATCH', url: `${own('')}?keyUuid=${b64url22(FOREIGN_KEY)}`, expect: 'request' },
        { name: 'query 22-character value under another key (an enum value, a name)', method: 'PATCH', url: `${own('')}?x=${b64url22(FOREIGN_KEY)}`,
            expect: 'sent', arrived: `PATCH ${own('')}?x=${b64url22(FOREIGN_KEY)}` },
        { name: 'query glued-prefix uuid', method: 'PATCH', url: `${own('')}?x=u${FOREIGN_USER}`, expect: 'ownership' },
        { name: 'fragment uuid (never sent)', method: 'PATCH', url: `${own('')}#${FOREIGN_USER}`, expect: 'sent', arrived: `PATCH ${own('')}` },
        { name: 'issue with a foreign keyUuid', method: 'POST', url: `/api/v2/operations/authorities/${AUTH}/raProfiles/${FOREIGN_RA}/certificates`,
            data: { request: 'x', keyUuid: FOREIGN_KEY }, expect: 'ownership' },
        { name: 'issue with a foreign keyUuid, 22-char base64url', method: 'POST', url: `/api/v2/operations/authorities/${AUTH}/raProfiles/${FOREIGN_RA}/certificates`,
            data: { request: 'x', keyUuid: b64url22(FOREIGN_KEY) }, expect: 'request' },
        { name: 'issue with a foreign keyUuid, 24-char base64url', method: 'POST', url: `/api/v2/operations/authorities/${AUTH}/raProfiles/${FOREIGN_RA}/certificates`,
            data: { request: 'x', keyUuid: b64url(FOREIGN_KEY) }, expect: 'request' },
        { name: 'issue with a foreign keyUuid, space padded', method: 'POST', url: `/api/v2/operations/authorities/${AUTH}/raProfiles/${FOREIGN_RA}/certificates`,
            data: { request: 'x', keyUuid: ` ${FOREIGN_KEY} ` }, expect: 'request' },
        { name: 'toJSON object body (judged as serialised)', method: 'PATCH', url: own('/users'), data: { toJSON: () => [FOREIGN_USER] }, expect: 'ownership' },
        { name: 'non-enumerable body field (not serialised)', method: 'PATCH', url: own('/users'),
            data: Object.defineProperty({}, 'userUuids', { enumerable: false, value: [FOREIGN_USER] }), expect: 'sent', arrived: `PATCH ${own('/users')}`, bodyWithout: FOREIGN_USER },
        { name: 'URLSearchParams as data (serialised as {})', method: 'PATCH', url: own('/users'), data: new URLSearchParams({ userUuids: FOREIGN_USER }),
            expect: 'sent', arrived: `PATCH ${own('/users')}`, bodyWithout: FOREIGN_USER },
        { name: 'a Readable-like object (functions dropped, fields kept)', method: 'PATCH', url: own('/users'), data: { pipe() {}, userUuids: FOREIGN_USER }, expect: 'ownership' },
        { name: 'bulk: filters nested next to an own list', method: 'DELETE', url: '/api/v1/keys', data: { uuids: [OWN_ROLE], inner: { filters: [] } }, expect: 'request' },
        { name: 'bulk: EMPTY uuids next to an own *Uuids list', method: 'DELETE', url: '/api/v1/keys', data: { uuids: [], certificateUuids: [OWN_CERT] }, expect: 'request' },
        { name: 'bulk: a nested own list only', method: 'DELETE', url: '/api/v1/keys', data: { x: { roleUuids: [OWN_ROLE] } }, expect: 'request' },
        { name: 'bulk: an array of objects with nested uuids', method: 'POST', url: '/api/v1/anything/purge', data: [{ uuids: [OWN_ROLE] }], expect: 'request' },
        { name: 'DELETE an own role with a reference field in the body', method: 'DELETE', url: `/api/v1/roles/${OWN_ROLE}`, data: { connectorUuid: FOREIGN_RA }, expect: 'ownership' },
        { name: 'a fake probe uuid not issued by probeUuid()', method: 'DELETE', url: `/api/v1/roles/${FOREIGN_ROLE}`, expect: 'ownership' },
        { name: 'GET with a method-override header', method: 'GET', url: '/api/v1/roles', options: { headers: { 'x-http-method-override': 'DELETE' } }, expect: 'request' },
        { name: 'lower-case method delete, foreign', method: 'delete', url: `/api/v1/roles/${FOREIGN_ROLE}`, expect: 'ownership' },
        // GET, HEAD, POST, PUT, PATCH and DELETE only.
        { name: 'unknown verb OPTIONS', method: 'OPTIONS', url: `/api/v1/roles/${FOREIGN_ROLE}`, expect: 'request' },
        { name: 'unknown verb PROPPATCH', method: 'PROPPATCH', url: `/api/v1/roles/${FOREIGN_ROLE}`, expect: 'request' },
        { name: 'GET (control)', method: 'GET', url: `/api/v1/roles/${FOREIGN_ROLE}`, expect: 'sent', arrived: `GET /api/v1/roles/${FOREIGN_ROLE}` },
        { name: 'own DELETE (control)', method: 'DELETE', url: `/api/v1/roles/${OWN_ROLE}`, expect: 'sent', arrived: `DELETE /api/v1/roles/${OWN_ROLE}` },
        { name: 'own create (control)', method: 'POST', url: '/api/v1/roles', data: { name: `${RUN}-new` }, expect: 'sent', arrived: 'POST /api/v1/roles' },
    ];
}

test('the adversarial table: each row refused for the right reason, or sent exactly as judged', async () => {
    test.setTimeout(90_000);
    const cases = adversarialTable();
    const mismatches: string[] = [];
    for (const c of cases) {
        A.reset();
        B.reset();
        const g = guard();
        const got = await outcome(g.fetch(c.url, { method: c.method, ...(c.data === undefined ? {} : { data: c.data }), ...(c.options ?? {}) } as Parameters<typeof g.fetch>[1]));
        if (got !== c.expect) mismatches.push(`${c.name}: expected ${c.expect}, got ${got}`);
        const arrivedHere = A.arrived.filter((a) => !(a.method === 'GET' && live[a.url] !== undefined && c.method.toUpperCase() !== 'GET'));
        if (B.arrived.length) mismatches.push(`${c.name}: the other origin saw ${B.arrived.map((a) => `${a.method} ${a.url}`).join(', ')}`);
        if (c.expect === 'sent') {
            const seen = arrivedHere.map((a) => `${a.method} ${a.url}`);
            if (JSON.stringify(seen) !== JSON.stringify([c.arrived])) mismatches.push(`${c.name}: arrived ${JSON.stringify(seen)}, expected ${c.arrived}`);
            if (c.bodyWithout && arrivedHere.some((a) => a.body.toLowerCase().includes(c.bodyWithout!.toLowerCase()))) mismatches.push(`${c.name}: the body on the wire names ${c.bodyWithout}`);
        } else if (A.mutations().length) {
            mismatches.push(`${c.name}: refused, yet ${wire(A).join(', ')} reached the server`);
        }
    }
    expect(mismatches).toEqual([]);
    expect(cases.length).toBeGreaterThanOrEqual(100);
});

test('issue body: a foreign key in an issue body is refused in every encoding; nothing reaches the server', async () => {
    const g = guard();
    const path = `/api/v2/operations/authorities/${AUTH}/raProfiles/${FOREIGN_RA}/certificates/${OWN_CERT}/issue`;
    const K = 'fbff0000-0000-4000-8000-0000000000fe';
    const encodings: Array<[string, string, RefusalKind]> = [
        ['canonical', K, 'ownership'], ['standard base64, 24', b64(K), 'request'], ['URL-safe base64, 24 (-_)', b64url(K), 'request'],
        ['URL-safe base64, 22', b64url22(K), 'request'], ['space padded', ` ${K}`, 'request'], ['tab padded', `${K}\t`, 'request'],
        ['upper case', K.toUpperCase(), 'ownership'], ['urn:uuid:', `urn:uuid:${K}`, 'request'], ['lenient (+ sign)', `+${K.slice(1)}`, 'request'],
    ];
    for (const [name, value, kind] of encodings) expect(await outcome(g.post(path, { data: { request: 'x', keyUuid: value } })), name).toBe(kind);
    expect(wire(A)).toEqual([]);
    // Control: without the key the own certificate is issued.
    await g.post(path, { data: { request: 'x' } });
    expect(wire(A)).toEqual([`POST ${path}`]);
});

// bulk endpoints: path-less platform endpoints and nested / empty lists are refused; nothing reaches the server
test('bulk endpoints: path-less platform endpoints and nested or empty lists are refused unsent', async () => {
    const g = guard();
    const cases: Array<[string, string, string, unknown]> = [
        ['purge audit logs, nested own list in a filter array', 'POST', '/api/v1/auditLogs/purge', [{ uuids: [OWN_ROLE] }]],
        ['purge audit logs, empty filters', 'POST', '/api/v1/auditLogs/purge', []],
        ['purge audit logs, a real filter', 'POST', '/api/v1/auditLogs/purge', [{ fieldSource: 'property', fieldIdentifier: 'x', condition: 'EQUALS', value: 'y' }]],
        ['CBOM delete', 'DELETE', '/api/v1/cboms', { uuids: [OWN_ROLE] }],
        ['CBOM upload with a stray list', 'POST', '/api/v1/cboms/upload', { x: { roleUuids: [OWN_ROLE] } }],
        ['OID delete with a stray list', 'DELETE', '/api/v1/oids', { oidUuids: [OWN_ROLE] }],
        ['discovery schedule with a stray list', 'POST', '/api/v1/discoveries/schedule', { a: { uuids: [OWN_ROLE] } }],
        ['list view create with nested filters', 'POST', '/api/v1/listViews', { name: 'x', filters: { uuids: [OWN_ROLE] } }],
        ['settings events PATCH with an own list', 'PATCH', '/api/v1/settings/events', { eventsMapping: { x: [OWN_ROLE] }, uuids: [OWN_ROLE] }],
    ];
    for (const [name, method, url, data] of cases) expect(await outcome(g.fetch(url, { method, data: data as object })), name).toBe('request');
    expect(wire(A)).toEqual([]);
    // PATCH /v1/notifications (mark as read) is no bulk route; an allow-listed bulk route with an own list is sent.
    expect(await outcome(g.patch('/api/v1/notifications', { data: [OWN_ROLE] }))).toBe('request');
    await g.patch('/api/v1/raProfiles/disable', { data: [OWN_RA] });
    expect(wire(A)).toEqual(['PATCH /api/v1/raProfiles/disable']);
});

test('a probe uuid passes path, body and query; the wire sees exactly the request the guard judged', async () => {
    const g = guard();
    const probe = g.probeUuid();
    await g.delete(`/api/v1/roles/${probe}`);
    await g.patch(`/api/v1/roles/${OWN_ROLE}/users`, { data: [probe], params: { other: probe } });
    expect(A.mutations().map((a) => `${a.method} ${a.url} ${a.body}`)).toEqual([
        `DELETE /api/v1/roles/${probe} `,
        `PATCH /api/v1/roles/${OWN_ROLE}/users?other=${probe} ${JSON.stringify([probe])}`,
    ]);
});
