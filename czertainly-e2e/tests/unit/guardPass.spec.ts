/**
 * Guard-integration pass (2026-10-14; design the test plan GD-01…GD-14 + the platform / lifecycle /
 * protocols requests), proven on the wire: every request goes through a REAL Playwright APIRequestContext to a loopback
 * fake core (tests/unit/helpers/loopbackServer.ts) and a second loopback origin that must never see anything. Each
 * accepted item has its allowance AND its limits here; each rejected item keeps a pin that the guard did not widen.
 *
 * - GD-03  a `users` line named REG_RESTRICTED_USERNAME is own (PATCH roles / enable, DELETE sent); a pre-existing
 *          user, the env unset, a `roles` line of that name, a live username that differs: refused;
 * - GD-06 / GD-07 / GD-12 (rejected): probe `mappingAttributeUuid` sent, a pre-existing definition refused; a pre-existing
 *          recipient refused, the own DED user sent, the DED bearer reads the inbox, `DELETE /v1/notifications` with an
 *          own uuid still refused; a duplicate-key Buffer is sent on the read route and refused on the create;
 * - GD-08  `POST /v1/inspections` is a create (not a raw POST): absent / 'not-a-uuid' / probe `tokenProfileUuid` sent, a
 *          pre-existing one refused (ownership), an own one sent after its live read, a non-canonical form refused, a
 *          foreign uuid in `passphrase` refused, a 7 MB `file` judged under 2 s and sent unchanged;
 * - GD-09  `POST /v1/certificates/import`: the certificate-only shape is sent, every other shape refused before anything
 *          is sent (keyDestination in any case or null, anywhere; unknown keys; bad entryReference; empty entries; a
 *          non-JSON Buffer; a non-string file), the customAttributes waiver unchanged, 7 MB under 2 s;
 * - GD-10  application/xml, application/octet-stream and multipart/form-data with a boundary are sent AS WRITTEN on
 *          `POST /v1/certificates`; refused on a create, a PUT, a GET, with an identity header, as x-www-form-urlencoded,
 *          with a bad / missing boundary, with `_method` in the body, with NUL bytes;
 * - GD-11  QAPROBE is sent as that method, bodyless, to a raw socket server (Node's parser refuses unknown methods, so the
 *          request line is read raw); every other unknown token is refused; the two NO_HANDLER_PROBES pairs are sent
 *          bodyless and query-less, every neighbour refused; the table is absent from the route tables;
 * - GD-13  the four (method, path) shapes with `not-a-uuid` are sent; every neighbour refused; the body is still judged;
 * - platform G-1 `keyItems`: own items under own keys are sent on the item operation routes, the per-key lists and the
 *          bulk item routes; a foreign item, a wrongly typed line, an item without its parent key: refused;
 * - platform G-2 `ruleUuid` of a provider rule on an own compliance profile sent; internal rule, foreign profile, another
 *          route, a list / nested form, a string body: refused;
 * - platform G-3 (rejected): callbacks on a pre-existing connector / object stay refused;
 * - platform G-4 `POST /v2/connectors` sent as a create; `proxyUuid` probes only; connect / approve stay platform-level;
 * - cert-lifecycle G1 `…/certificates/register` sent under foreign scope parents; typed body fields must be own.
 */
import { APIRequestContext, expect, request, test } from '@playwright/test';
import * as net from 'net';
import type { AddressInfo } from 'net';
import {
    BULK_ROUTES, LIST_BODY_TYPES, MALFORMED_UUID_PROBES, malformedUuidProbe, NO_HANDLER_PROBES, noHandlerProbe, ROUTE_FIELD_WAIVERS, routeFieldWaivers, TARGET_TYPES,
} from '../../utils/regression/apiRoutes';
import {
    guardApiForUnitTests, importBodyShapeProblem, isAllowListedPostUrl, isRawPostAllowed, isUuidLike, METHOD_TABLES, POST_CREATE, POST_READ, postKind, readPostType, SENTINEL_METHODS,
} from '../../utils/regression/guardedApi';
import { DryRunRefusal } from '../../utils/regression/flags';
import { OwnObjectViolation, RefusalKind } from '../../utils/regression/ownObjects';
import { LedgerLine } from '../../utils/regression/regressionRun';
import { Arrived, loopbackServer, LoopbackServer } from './helpers/loopbackServer';
import { randomBytes } from 'node:crypto';
// Run-scoped generated test passwords (merge follow-up 2026-10-15): no password-like literal in the file.
const GEN_PW_1 = `qa-${randomBytes(9).toString('base64url')}`;
const GEN_PW_2 = `qa-${randomBytes(9).toString('base64url')}`;

const RUN = 'qa-reg-20261014-200000-gp01';
const U = (n: number) => `00000000-0000-4000-8000-${String(n).padStart(12, '0')}`;
const OWN_ROLE = U(3);
const OWN_USER = U(6);
const OWN_GROUP = U(7);
const OWN_CERT = U(5);
const OWN_TOKEN = U(40);
const OWN_PROFILE = U(41);
const OWN_KEY = U(42);
const OWN_ITEM = U(43);
const OWN_ITEM_NO_PARENT = U(44);
const OWN_ITEM_AS_KEY = U(45);
const OWN_ITEM_RENAMED = U(46);
const OWN_COMPLIANCE = U(50);
const OWN_NI = U(51);
const OWN_CA = U(52);
const DED = U(60);
const DED_NAME = 'qa-ded-user';
const FOREIGN = U(11);
const FOREIGN2 = U(12);
const FOREIGN_USER = U(10);
const FOREIGN_PROFILE = U(13);
const FOREIGN_ITEM = U(14);
const PRE_CONNECTOR = U(30);

const mk = (type: string, uuid: string, name = `${RUN}-${type}`, parents?: LedgerLine['parents']): LedgerLine =>
    ({ at: 'a', runId: RUN, type, name, uuid, spec: 'T', event: 'created', ...(parents ? { parents } : {}) });

const lines: LedgerLine[] = [
    mk('roles', OWN_ROLE), mk('users', OWN_USER), mk('groups', OWN_GROUP), mk('certificates', OWN_CERT, `${RUN}.example.test`),
    mk('tokens', OWN_TOKEN), mk('tokenProfiles', OWN_PROFILE, `${RUN}-tp`, { token: OWN_TOKEN }),
    mk('keys', OWN_KEY, `${RUN}-key`), mk('keyItems', OWN_ITEM, `${RUN}-key`, { key: OWN_KEY }),
    mk('keyItems', OWN_ITEM_NO_PARENT, `${RUN}-key`), mk('keys', OWN_ITEM_AS_KEY, `${RUN}-key`), mk('keyItems', OWN_ITEM_RENAMED, `${RUN}-key`, { key: OWN_KEY }),
    mk('complianceProfiles', OWN_COMPLIANCE), mk('notificationInstances', OWN_NI), mk('customAttributes', OWN_CA),
    // GD-03: the dedicated identity's ILM user, created by this run, named by the operator (no run prefix).
    mk('users', DED, DED_NAME),
];

const live: Record<string, unknown> = {
    [`/api/v1/roles/${OWN_ROLE}`]: { name: `${RUN}-roles` },
    [`/api/v1/users/${OWN_USER}`]: { username: `${RUN}-users` },
    [`/api/v1/users/${DED}`]: { username: 'QA-DED-USER' },
    [`/api/v1/groups/${OWN_GROUP}`]: { name: `${RUN}-groups` },
    [`/api/v1/certificates/${OWN_CERT}`]: { commonName: `${RUN}.example.test` },
    [`/api/v1/tokens/${OWN_TOKEN}`]: { name: `${RUN}-tokens` },
    [`/api/v1/tokens/${OWN_TOKEN}/tokenProfiles/${OWN_PROFILE}`]: { name: `${RUN}-tp` },
    [`/api/v1/keys/${OWN_KEY}`]: { name: `${RUN}-key` },
    [`/api/v1/keys/${OWN_KEY}/items/${OWN_ITEM}`]: { name: `${RUN}-key` },
    [`/api/v1/keys/${OWN_KEY}/items/${OWN_ITEM_RENAMED}`]: { name: 'hsm-production-key' },
    [`/api/v1/keys/${OWN_ITEM_AS_KEY}`]: { name: `${RUN}-key` },
    [`/api/v1/complianceProfiles/${OWN_COMPLIANCE}`]: { name: `${RUN}-complianceProfiles` },
    [`/api/v1/notificationInstances/${OWN_NI}`]: { name: `${RUN}-notificationInstances` },
    [`/api/v1/attributes/custom/${OWN_CA}`]: { name: `${RUN}-customAttributes` },
    [`/api/v1/roles/${FOREIGN}`]: { name: 'Administrators' },
    [`/api/v1/users/${FOREIGN_USER}`]: { username: 'alice' },
};
const coreAnswer = (a: Arrived) => (a.method === 'GET' || a.method === 'HEAD' ? (live[a.url] ? { status: 200, body: live[a.url] } : { status: 404, body: {} }) : undefined);

let A: LoopbackServer;
let B: LoopbackServer;
let raw: APIRequestContext;
let BASE_URL: string;

test.beforeAll(async () => {
    A = await loopbackServer(coreAnswer);
    B = await loopbackServer();
    BASE_URL = `${A.origin}/administrator/`;
    raw = await request.newContext({ baseURL: BASE_URL, extraHTTPHeaders: { Authorization: 'Bearer SECRET-TOKEN' } });
});

test.afterAll(async () => {
    await raw.dispose();
    await A.close();
    await B.close();
});

test.beforeEach(() => {
    A.reset();
    B.reset();
});

const guard = (env: Record<string, string> = {}) => guardApiForUnitTests(raw, { lines, runId: RUN, tier: null, env: { BASE_URL, REG_RESTRICTED_USERNAME: 'QA-DED-User', ...env } });

async function refusal(call: Promise<unknown>): Promise<{ kind: RefusalKind | 'sent' | string; reason: string }> {
    try {
        await call;
        return { kind: 'sent', reason: '' };
    } catch (e) {
        if (e instanceof OwnObjectViolation) return { kind: e.kind, reason: e.reason };
        return { kind: `error: ${String(e).slice(0, 200)}`, reason: String(e) };
    }
}
const outcome = async (call: Promise<unknown>): Promise<string> => (await refusal(call)).kind;

const mutationsSeen = () => A.mutations().map((a) => `${a.method} ${a.url}`);
const noMutationArrived = () => expect(A.mutations(), 'nothing refused reached the core').toEqual([]);

// ------------------------------------------------------------------ GD-03

test('GD-03: the DED-named own users line — PATCH roles / enable and DELETE are sent; a pre-existing user, the env unset, a roles line, a foreign live name: refused', async () => {
    const g = guard();
    expect(await outcome(g.patch(`/api/v1/users/${DED}/roles`, { data: [] }))).toBe('sent');
    expect(await outcome(g.patch(`/api/v1/users/${DED}/enable`))).toBe('sent');
    expect(await outcome(g.delete(`/api/v1/users/${DED}`))).toBe('sent');
    expect(mutationsSeen()).toEqual([`PATCH /api/v1/users/${DED}/roles`, `PATCH /api/v1/users/${DED}/enable`, `DELETE /api/v1/users/${DED}`]);
    A.reset();
    // Limits: a name alone owns nothing; only `users`; the env must be set; the live name must match.
    expect(await outcome(g.patch(`/api/v1/users/${FOREIGN_USER}/enable`))).toBe('ownership');
    expect(await outcome(guard({ REG_RESTRICTED_USERNAME: '' }).patch(`/api/v1/users/${DED}/enable`))).toBe('ownership');
    expect((await refusal(guard({ REG_RESTRICTED_USERNAME: '' }).patch(`/api/v1/users/${DED}/enable`))).reason).toMatch(/does not start with/);
    const roleNamedDed = guardApiForUnitTests(raw, { lines: [mk('roles', FOREIGN, DED_NAME)], runId: RUN, tier: null, env: { BASE_URL, REG_RESTRICTED_USERNAME: DED_NAME } });
    expect(await outcome(roleNamedDed.delete(`/api/v1/roles/${FOREIGN}`))).toBe('ownership');
    expect(await outcome(guard({ REG_RESTRICTED_USERNAME: 'someone-else' }).patch(`/api/v1/users/${DED}/enable`)), 'the live username differs from the configured name').toBe('ownership');
    noMutationArrived();
    expect(B.arrived).toEqual([]);
});

// ------------------------------------------------------------------ GD-06 / GD-07 / GD-12 (rejected: pins)

test('GD-06 / GD-07 / GD-12 pins: the guard did not widen — probe mapping uuid sent, pre-existing refused; own DED recipient sent, pre-existing refused; inbox read as DED; duplicate keys only on the read route', async () => {
    const g = guard();
    const mapping = (u: string) => ({ attributeMappings: [{ mappingAttributeUuid: u, mappingAttributeName: 'x', customAttributeUuid: OWN_CA }] });
    expect(await outcome(g.put(`/api/v1/notificationInstances/${OWN_NI}`, { data: mapping(g.probeUuid()) }))).toBe('sent');
    expect(await outcome(g.put(`/api/v1/notificationInstances/${OWN_NI}`, { data: mapping(FOREIGN) }))).toBe('ownership');
    const profile = (u: string) => ({ name: `${RUN}-np`, recipientType: 'user', recipientUuids: [u] });
    expect(await outcome(g.post('/api/v1/notificationProfiles', { data: profile(FOREIGN_USER) }))).toBe('ownership');
    expect(await outcome(g.post('/api/v1/notificationProfiles', { data: profile(DED) }))).toBe('sent');
    expect(await outcome(g.get('/api/v1/notifications?unread=true', { headers: { Authorization: 'Bearer DED' }, identityOverride: true } as never))).toBe('sent');
    expect(await outcome(g.delete('/api/v1/notifications', { data: [DED] }))).toBe('request');
    expect(await outcome(g.post('/api/v1/certificates', { data: Buffer.from('{"itemsPerPage":5,"itemsPerPage":10}') }))).toBe('sent');
    expect(await outcome(g.post('/api/v1/groups', { data: Buffer.from(`{"name":"${RUN}-g","name":"${RUN}-h"}`) }))).toBe('request');
    expect(mutationsSeen()).toEqual([`PUT /api/v1/notificationInstances/${OWN_NI}`, 'POST /api/v1/notificationProfiles', 'POST /api/v1/certificates']);
    expect(A.arrived.filter((a) => a.url.startsWith('/api/v1/notifications')).map((a) => a.headers.authorization)).toEqual(['Bearer DED']);
    expect(B.arrived).toEqual([]);
});

// ------------------------------------------------------------------ GD-08

const big = () => Buffer.alloc(5 * 1024 * 1024, 7).toString('base64');

test('GD-08: POST /v1/inspections is a body-judged create, never a raw POST; tokenProfileUuid absent / not-a-uuid / probe sent, pre-existing refused, own sent after its live read', async () => {
    expect(postKind('/v1/inspections')).toBe('create');
    expect(isRawPostAllowed('/v1/inspections')).toBe(false);
    expect(isAllowListedPostUrl('/api/v1/inspections')).toBe(false);
    const g = guard();
    expect(await outcome(g.post('/api/v1/inspections', { data: { file: 'AAAA' } }))).toBe('sent');
    expect(await outcome(g.post('/api/v1/inspections', { data: { file: 'AAAA', passphrase: GEN_PW_1, tokenProfileUuid: 'not-a-uuid' } }))).toBe('sent');
    expect(await outcome(g.post('/api/v1/inspections', { data: { file: 'AAAA', tokenProfileUuid: g.probeUuid() } }))).toBe('sent');
    expect(await outcome(g.post('/api/v1/inspections', { data: { file: 'AAAA', tokenProfileUuid: OWN_PROFILE } }))).toBe('sent');
    expect(A.arrived.filter((a) => a.method === 'GET').map((a) => a.url), 'the own profile was read live before the send').toEqual([`/api/v1/tokens/${OWN_TOKEN}/tokenProfiles/${OWN_PROFILE}`]);
    expect(mutationsSeen()).toHaveLength(4);
    A.reset();
    const pre = await refusal(g.post('/api/v1/inspections', { data: { file: 'AAAA', tokenProfileUuid: FOREIGN_PROFILE } }));
    expect(pre.kind).toBe('ownership');
    expect((await refusal(g.post('/api/v1/inspections', { data: { file: 'AAAA', tokenProfileUuid: OWN_ROLE } }))).reason, 'a typed field: the line must be a tokenProfiles line').toMatch(/records it as roles, but the body field tokenProfileUuid names tokenProfiles/);
    expect(await outcome(g.post('/api/v1/inspections', { data: { file: 'AAAA', tokenProfileUuid: `urn:uuid:${OWN_PROFILE}` } }))).toBe('request');
    expect(await outcome(g.post('/api/v1/inspections', { data: { file: 'AAAA', tokenProfileUuid: ` ${OWN_PROFILE}` } }))).toBe('request');
    expect(await outcome(g.post('/api/v1/inspections', { data: { file: 'AAAA', passphrase: `pw ${FOREIGN}` } }))).toBe('ownership');
    expect(await outcome(raw.post('/api/v1/inspections', { data: {} }).then(() => undefined)), 'a raw context can still reach it (the lint refuses it: isAllowListedPostUrl false)').toBe('sent');
    expect(mutationsSeen()).toEqual(['POST /api/v1/inspections']);
    expect(B.arrived).toEqual([]);
});

test('GD-08 / GD-09 u5: a 7 MB file is judged in under 2 s and sent unchanged', async () => {
    const g = guard();
    const file = big();
    expect(file.length).toBeGreaterThan(6_900_000);
    for (const [url, data] of [['/api/v1/inspections', { file, passphrase: GEN_PW_1 }], ['/api/v1/certificates/import', { file, entries: [{ entryReference: 'ab'.repeat(32) }] }]] as const) {
        const started = Date.now();
        await g.check('POST', url, data);
        expect(Date.now() - started, `${url} judged`).toBeLessThan(2000);
        const res = await g.post(url, { data });
        expect(res.status()).toBe(200);
    }
    const sent = A.mutations();
    expect(sent.map((a) => a.url)).toEqual(['/api/v1/inspections', '/api/v1/certificates/import']);
    for (const a of sent) expect(JSON.parse(a.body).file).toBe(file);
});

// ------------------------------------------------------------------ GD-09

test('GD-09: the certificate-only import shape is sent; every other shape is refused before anything is sent; the customAttributes waiver is unchanged', async () => {
    expect(postKind('/v1/certificates/import')).toBe('create');
    expect(isRawPostAllowed('/v1/certificates/import')).toBe(false);
    const g = guard();
    const ref = 'ab'.repeat(32);
    const ok = { file: 'AAAA', entries: [{ entryReference: ref }] };
    expect(await outcome(g.post('/api/v1/certificates/import', { data: ok }))).toBe('sent');
    expect(await outcome(g.post('/api/v1/certificates/import', { data: { ...ok, passphrase: GEN_PW_1, customAttributes: [{ uuid: FOREIGN, name: 'x', content: [{ data: FOREIGN2 }] }] } })), 'customAttributes stays an attribute subtree').toBe('sent');
    expect(await outcome(g.post('/api/v1/certificates/import', { data: { ...ok, entries: [{ entryReference: ref }, { entryReference: 'cd'.repeat(32) }] } }))).toBe('sent');
    expect(mutationsSeen()).toEqual(['POST /api/v1/certificates/import', 'POST /api/v1/certificates/import', 'POST /api/v1/certificates/import']);
    A.reset();
    const refused: Array<[string, unknown]> = [
        ['keyDestination present', { ...ok, entries: [{ entryReference: ref, keyDestination: { tokenProfileUuid: OWN_PROFILE } }] }],
        ['keyDestination null', { ...ok, entries: [{ entryReference: ref, keyDestination: null }] }],
        ['KeyDestination (other case)', { ...ok, entries: [{ entryReference: ref, KeyDestination: null }] }],
        ['keyDestination at the top level', { ...ok, keyDestination: {} }],
        ['keyDestination inside customAttributes', { ...ok, customAttributes: [{ keyDestination: 1 }] }],
        ['an unknown top-level key', { ...ok, extra: 1 }],
        ['an entry with an extra key', { ...ok, entries: [{ entryReference: ref, keyName: 'k' }] }],
        ['an upper-case entryReference', { ...ok, entries: [{ entryReference: ref.toUpperCase() }] }],
        ['a 63-character entryReference', { ...ok, entries: [{ entryReference: ref.slice(1) }] }],
        ['a uuid entryReference', { ...ok, entries: [{ entryReference: FOREIGN }] }],
        ['empty entries', { ...ok, entries: [] }],
        ['entries not a list', { ...ok, entries: { entryReference: ref } }],
        ['251 entries', { ...ok, entries: Array.from({ length: 251 }, () => ({ entryReference: ref })) }],
        ['file not a string', { ...ok, file: 1 }],
        ['passphrase not a string', { ...ok, passphrase: 1 }],
        ['a non-JSON Buffer', Buffer.from('garbage')],
        ['a top-level list', [ok]],
    ];
    const wrong: string[] = [];
    for (const [name, data] of refused) {
        const got = await refusal(g.post('/api/v1/certificates/import', { data }));
        if (got.kind !== 'request' || !/certificate-only entries/.test(got.reason)) wrong.push(`${name}: ${got.kind} ${got.reason.slice(0, 100)}`);
    }
    expect(wrong).toEqual([]);
    expect(await outcome(g.post('/api/v1/certificates/import', { data: { ...ok, passphrase: `pw ${FOREIGN}` } })), 'rule 6d still applies').toBe('ownership');
    expect(await outcome(g.post('/api/v1/certificates/import', { data: JSON.stringify({ ...ok, entries: [{ entryReference: ref }], passphrase: GEN_PW_2, [`k${FOREIGN}`]: 1 }) })), 'a foreign uuid in an entry key / raw text').toBe('request');
    expect(importBodyShapeProblem({ kind: 'json', value: ok })).toBeUndefined();
    expect(importBodyShapeProblem({ kind: 'text', text: 'x' })).toMatch(/JSON object/);
    noMutationArrived();
    expect(B.arrived).toEqual([]);
});

// ------------------------------------------------------------------ GD-10

test('GD-10: xml / octet-stream / multipart with a boundary are sent as written on the read POST; refused everywhere else and in every other form', async () => {
    const g = guard();
    const types = ['application/xml', 'application/octet-stream', 'multipart/form-data; boundary=----qa-boundary_1.2'];
    for (const t of types) {
        expect(await outcome(g.post('/api/v1/certificates', { data: '<x>garbage</x>', headers: { 'Content-Type': t } })), t).toBe('sent');
        expect(await outcome(g.post('/api/v1/certificates', { data: Buffer.from('bytesÿ', 'latin1').toString('utf8'), headers: { 'content-type': t.toUpperCase() } })), `${t} upper-case`).toBe('sent');
    }
    const sent = A.mutations();
    // The media type is normalised to lower case; a multipart boundary is case-sensitive and goes as written.
    expect(sent.map((a) => a.headers['content-type'])).toEqual(types.flatMap((t) => [readPostType(t), readPostType(t.toUpperCase())]));
    expect(sent[0].body).toBe('<x>garbage</x>');
    expect(sent.every((a) => a.headers.authorization === 'Bearer SECRET-TOKEN')).toBe(true);
    A.reset();
    const xml = { 'Content-Type': 'application/xml' };
    const refused: Array<[string, () => Promise<unknown>]> = [
        ['a create', () => g.post('/api/v1/groups', { data: '<x/>', headers: xml })],
        ['a PUT on an own object', () => g.put(`/api/v1/roles/${OWN_ROLE}`, { data: '<x/>', headers: xml })],
        ['a GET', () => g.get('/api/v1/certificates', { headers: xml })],
        ['an identity header', () => g.post('/api/v1/certificates', { data: '<x/>', headers: { ...xml, Authorization: 'Bearer OTHER' }, identityOverride: true } as never)],
        ['x-www-form-urlencoded', () => g.post('/api/v1/certificates', { data: 'a=b', headers: { 'Content-Type': 'application/x-www-form-urlencoded' } })],
        ['multipart without a boundary', () => g.post('/api/v1/certificates', { data: 'x', headers: { 'Content-Type': 'multipart/form-data' } })],
        ['a boundary with a bad character', () => g.post('/api/v1/certificates', { data: 'x', headers: { 'Content-Type': 'multipart/form-data; boundary=a b' } })],
        ['a 71-character boundary', () => g.post('/api/v1/certificates', { data: 'x', headers: { 'Content-Type': `multipart/form-data; boundary=${'a'.repeat(71)}` } })],
        ['a type with another parameter', () => g.post('/api/v1/certificates', { data: 'x', headers: { 'Content-Type': 'application/xml; charset=utf-8' } })],
        ['a body containing _method', () => g.post('/api/v1/certificates', { data: '<x>_METHOD=DELETE</x>', headers: xml })],
        ['an object body', () => g.post('/api/v1/certificates', { data: { a: 1 }, headers: xml })],
        ['no body', () => g.post('/api/v1/certificates', { headers: xml })],
        ['NUL bytes', () => g.post('/api/v1/certificates', { data: 'a\u0000b', headers: { 'Content-Type': 'application/octet-stream' } })],
    ];
    for (const [name, call] of refused) expect(await outcome(call()), name).toBe('request');
    noMutationArrived();
    // A read POST is not judged (section 2 fact 1, like a JSON search naming a foreign uuid): the text goes as written.
    expect(await outcome(g.post('/api/v1/certificates', { data: `<x>${FOREIGN}</x>`, headers: xml }))).toBe('sent');
    expect(A.mutations().map((a) => a.body)).toEqual([`<x>${FOREIGN}</x>`]);
    A.reset();
    expect(B.arrived).toEqual([]);
});

// ------------------------------------------------------------------ GD-11

test('GD-11 (a): QAPROBE is sent as that method, bodyless, through fetch only; PROPFIND, FOO and lower-case variants stay refused', async () => {
    expect([...SENTINEL_METHODS]).toEqual(['TRACE', 'QAPROBE']);
    expect([...METHOD_TABLES.METHODS]).toEqual(['GET', 'HEAD', 'POST', 'PUT', 'PATCH', 'DELETE', ...SENTINEL_METHODS]);
    expect([...METHOD_TABLES.BODYLESS]).toEqual(['GET', 'HEAD', ...SENTINEL_METHODS]);
    // Node's HTTP parser refuses an unknown method, so a raw socket server records the request line.
    const requestLines: string[] = [];
    const server = net.createServer((sock) => {
        let buf = '';
        sock.on('data', (d) => {
            buf += d.toString('latin1');
            if (buf.includes('\r\n\r\n')) {
                requestLines.push(buf.split('\r\n')[0]);
                const body = '{"message":"Bad Request"}';
                sock.end(`HTTP/1.1 400 Bad Request\r\nContent-Type: application/json\r\nContent-Length: ${body.length}\r\nConnection: close\r\n\r\n${body}`);
            }
        });
    });
    await new Promise<void>((r) => server.listen(0, '127.0.0.1', () => r()));
    const origin = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
    const ctx = await request.newContext({ baseURL: `${origin}/`, extraHTTPHeaders: { Authorization: 'Bearer SECRET-TOKEN' } });
    try {
        const g = guardApiForUnitTests(ctx, { lines, runId: RUN, tier: null, env: { BASE_URL: `${origin}/` } });
        const res = await g.fetch('/api/v1/info', { method: 'QAPROBE' });
        expect(res.status()).toBe(400);
        expect(await outcome(g.fetch(`/api/v1/roles/${FOREIGN}`, { method: 'qaprobe' })), 'like TRACE, it may name any object: it changes nothing').toBe('sent');
        expect(requestLines).toEqual(['QAPROBE /api/v1/info HTTP/1.1', `QAPROBE /api/v1/roles/${FOREIGN} HTTP/1.1`]);
        expect(await outcome(g.check('QAPROBE', '/api/v1/info'))).toBe('sent');
        const refused: Array<[string, () => Promise<unknown>]> = [
            ['a body', () => g.fetch('/api/v1/info', { method: 'QAPROBE', data: 'x' })],
            ['identityOverride', () => g.fetch('/api/v1/info', { method: 'QAPROBE', identityOverride: true } as never)],
            ['an identity header', () => g.fetch('/api/v1/info', { method: 'QAPROBE', headers: { cookie: 'a=b' } })],
            ['a side-effect GET path', () => g.fetch(`/api/v1/certificates/${OWN_CERT}/validate`, { method: 'QAPROBE' })],
            ['another origin', () => g.fetch(`${B.origin}/api/v1/info`, { method: 'QAPROBE' })],
            ['a redirect follow', () => g.fetch('/api/v1/info', { method: 'QAPROBE', maxRedirects: 1 })],
            ['text/plain', () => g.fetch('/api/v1/info', { method: 'QAPROBE', headers: { 'content-type': 'text/plain' } })],
            ['PROPFIND', () => g.fetch('/api/v1/groups', { method: 'PROPFIND' })],
            ['FOO', () => g.fetch('/api/v1/info', { method: 'FOO' })],
            ['propfind (lower case)', () => g.fetch('/api/v1/info', { method: 'propfind' })],
            ['QAPROBE2', () => g.fetch('/api/v1/info', { method: 'QAPROBE2' })],
            ['check() PROPFIND', () => g.check('PROPFIND', '/api/v1/info')],
            // An unknown token is refused as a METHOD, not merely as a path-less mutation: on an own object with a body it stays refused.
            ['FOO on an own object with a body', () => g.fetch(`/api/v1/roles/${OWN_ROLE}`, { method: 'FOO', data: { name: `${RUN}-roles` } })],
            ['PROPFIND on an own object', () => g.check('PROPFIND', `/api/v1/roles/${OWN_ROLE}`)],
            ['LOCK on an own object', () => g.fetch(`/api/v1/roles/${OWN_ROLE}`, { method: 'LOCK' })],
        ];
        for (const [name, call] of refused) {
            const got = await refusal(call());
            expect(got.kind, name).toBe('request');
            if (/FOO|PROPFIND|LOCK|QAPROBE2/.test(name)) expect(got.reason, name).toMatch(/^the method "/);
        }
        expect(requestLines, 'nothing refused was sent').toHaveLength(2);
    } finally {
        await ctx.dispose();
        await new Promise<void>((r) => server.close(() => r()));
    }
    expect(B.arrived).toEqual([]);
});

test('GD-11 (b): the two NO_HANDLER_PROBES pairs are sent bodyless and query-less as the run\'s identity; every neighbour is refused; the table is absent from the route tables', async () => {
    expect(NO_HANDLER_PROBES.map((p) => `${p.method} ${p.path}`)).toEqual(['POST /v1/statistics', 'DELETE /v1/info']);
    for (const p of NO_HANDLER_PROBES) {
        expect(p.method === 'POST' ? postKind(p.path) : undefined, `${p.path} is no allow-listed POST`).toBeUndefined();
        expect(BULK_ROUTES.some((r) => r.method === p.method && r.path === p.path), `${p.path} is no bulk route`).toBe(false);
        expect(LIST_BODY_TYPES.some((r) => r.method === p.method && r.path === p.path), `${p.path} is no list-body route`).toBe(false);
        expect(POST_CREATE.includes(p.path) || POST_READ.includes(p.path)).toBe(false);
        expect(/^\/v[12]\/[A-Za-z]+$/.test(p.path), 'a plain two-segment path').toBe(true);
    }
    expect(noHandlerProbe('POST', '/v1/statistics')).toBeDefined();
    expect(noHandlerProbe('POST', '/v1/info')).toBeUndefined();
    const g = guard();
    expect(await outcome(g.post('/api/v1/statistics'))).toBe('sent');
    expect(await outcome(g.delete('/api/v1/info'))).toBe('sent');
    expect(await outcome(g.fetch('/api/v1/statistics', { method: 'POST' }))).toBe('sent');
    const sent = A.mutations();
    expect(sent.map((a) => `${a.method} ${a.url}`)).toEqual(['POST /api/v1/statistics', 'DELETE /api/v1/info', 'POST /api/v1/statistics']);
    expect(sent.every((a) => a.body === '' && a.headers.authorization === 'Bearer SECRET-TOKEN')).toBe(true);
    A.reset();
    const refused: Array<[string, () => Promise<unknown>]> = [
        ['POST /v1/info', () => g.post('/api/v1/info')],
        ['DELETE /v1/statistics', () => g.delete('/api/v1/statistics')],
        ['a query', () => g.post('/api/v1/statistics?x=1')],
        ['params', () => g.post('/api/v1/statistics', { params: { x: '1' } })],
        ['a body', () => g.post('/api/v1/statistics', { data: { a: 1 } })],
        ['a text body', () => g.post('/api/v1/statistics', { data: 'x', headers: { 'content-type': 'text/plain' } })],
        ['an identity header', () => g.post('/api/v1/statistics', { headers: { Authorization: 'Bearer OTHER' }, identityOverride: true } as never)],
        ['identityOverride alone', () => g.post('/api/v1/statistics', { identityOverride: true } as never)],
        ['DELETE /v1/groups (a bulk route without its list)', () => g.delete('/api/v1/groups')],
        ['PUT /v1/statistics', () => g.put('/api/v1/statistics')],
        ['a sub-path', () => g.post('/api/v1/statistics/signingRecords')],
        ['another origin', () => g.post(`${B.origin}/api/v1/statistics`)],
    ];
    for (const [name, call] of refused) expect(await outcome(call()), name).toBe('request');
    expect(await outcome(g.post('/api/v1/groups', { data: { name: `${RUN}-g` } })), 'a create next door is unchanged').toBe('sent');
    expect(mutationsSeen()).toEqual(['POST /api/v1/groups']);
    A.reset();
    // Review X03: the DELETE pair still honours the dry run (rule 7); the POST pair does not need it.
    const dry = guard({ API_TEARDOWN_DRY_RUN: 'on' });
    await expect(dry.delete('/api/v1/info')).rejects.toBeInstanceOf(DryRunRefusal);
    expect(await outcome(dry.post('/api/v1/statistics'))).toBe('sent');
    expect(mutationsSeen()).toEqual(['POST /api/v1/statistics']);
    expect(B.arrived).toEqual([]);
});

// ------------------------------------------------------------------ GD-13

test('GD-13: PUT | DELETE /v1/groups | credentials/not-a-uuid are sent; every neighbour refused; the body is still judged; the literals are never uuid-like', async () => {
    for (const p of MALFORMED_UUID_PROBES) {
        for (const l of p.literals) {
            expect(isUuidLike(l), `${l} is not uuid-like`).toBe(false);
            expect(/^[A-Za-z0-9._~-]+$/.test(l)).toBe(true);
        }
        expect(p.template.split('{x}')[0]).toMatch(/^\/v1\/(groups|credentials)\/$/);
    }
    expect(malformedUuidProbe('PUT', '/v1/groups/not-a-uuid')).toBeDefined();
    expect(malformedUuidProbe('PATCH', '/v1/groups/not-a-uuid')).toBeUndefined();
    const g = guard();
    expect(await outcome(g.put('/api/v1/groups/not-a-uuid', { data: { description: 'x', customAttributes: [] } }))).toBe('sent');
    expect(await outcome(g.delete('/api/v1/groups/not-a-uuid'))).toBe('sent');
    expect(await outcome(g.put('/api/v1/credentials/not-a-uuid', { data: { description: 'x' } }))).toBe('sent');
    expect(await outcome(g.delete('/api/v1/credentials/not-a-uuid'))).toBe('sent');
    expect(mutationsSeen()).toEqual(['PUT /api/v1/groups/not-a-uuid', 'DELETE /api/v1/groups/not-a-uuid', 'PUT /api/v1/credentials/not-a-uuid', 'DELETE /api/v1/credentials/not-a-uuid']);
    A.reset();
    const refused: Array<[string, () => Promise<unknown>, RefusalKind]> = [
        ['PUT /v1/roles/not-a-uuid', () => g.put('/api/v1/roles/not-a-uuid', { data: { name: 'x' } }), 'request'],
        ['DELETE /v1/groups/some-name', () => g.delete('/api/v1/groups/some-name'), 'request'],
        ['DELETE /v1/groups/not-a-uuid2', () => g.delete('/api/v1/groups/not-a-uuid2'), 'request'],
        ['a uuid-like non-canonical literal', () => g.delete('/api/v1/groups/+0-0-4000-8000-6'), 'request'],
        ['PATCH /v1/groups/not-a-uuid', () => g.patch('/api/v1/groups/not-a-uuid'), 'request'],
        ['DELETE /v1/credentials/ (empty segment)', () => g.delete('/api/v1/credentials/'), 'request'],
        ['DELETE /v1/operations/x/certificate/revoke', () => g.delete('/api/v1/operations/x/certificate/revoke'), 'request'],
        ['DELETE /v1/groups/not-a-uuid/users', () => g.delete('/api/v1/groups/not-a-uuid/users'), 'request'],
        ['a body naming a pre-existing group', () => g.put('/api/v1/groups/not-a-uuid', { data: { description: FOREIGN } }), 'ownership'],
        ['a Buffer body that is not JSON', () => g.put('/api/v1/groups/not-a-uuid', { data: Buffer.from('garbage') }), 'request'],
    ];
    for (const [name, call, kind] of refused) expect(await outcome(call()), name).toBe(kind);
    noMutationArrived();
    expect(B.arrived).toEqual([]);
});

// ------------------------------------------------------------------ platform G-1

test('platform G-1: keyItems — own items under own keys are sent on the item operation, per-key list and bulk item routes; foreign, mistyped or parentless items are refused', async () => {
    expect(TARGET_TYPES.items).toBe('keyItems');
    expect(BULK_ROUTES.filter((r) => r.path.startsWith('/v1/keys/items')).every((r) => r.type === 'keyItems')).toBe(true);
    expect(LIST_BODY_TYPES.filter((r) => /keys\/\{id\}/.test(r.path)).every((r) => r.type === 'keyItems')).toBe(true);
    const g = guard();
    const ops = `/api/v1/operations/tokens/${OWN_TOKEN}/tokenProfiles/${OWN_PROFILE}/keys/${OWN_KEY}/items`;
    expect(await outcome(g.post(`${ops}/${OWN_ITEM}/sign`, { data: { data: [{ data: 'AQ==' }], signatureAttributes: [] } }))).toBe('sent');
    expect(await outcome(g.post(`${ops}/${OWN_ITEM}/verify`, { data: { data: [], signatures: [], signatureAttributes: [] } }))).toBe('sent');
    expect(await outcome(g.post(`/api/v1/keys/${OWN_KEY}/items/${OWN_ITEM}/export`, { data: { exportAttributes: [] } }))).toBe('sent');
    expect(await outcome(g.patch(`/api/v1/keys/${OWN_KEY}/items/${OWN_ITEM}/export/disable`))).toBe('sent');
    expect(await outcome(g.patch(`/api/v1/keys/${OWN_KEY}/items/${OWN_ITEM}`, { data: { name: `${RUN}-key` } }))).toBe('sent');
    expect(await outcome(g.patch('/api/v1/keys/items/disable', { data: [OWN_ITEM] }))).toBe('sent');
    expect(await outcome(g.patch('/api/v1/keys/items/compromise', { data: { uuids: [OWN_ITEM], reason: 'unspecified' } }))).toBe('sent');
    expect(await outcome(g.patch(`/api/v1/keys/${OWN_KEY}/disable`, { data: [OWN_ITEM] }))).toBe('sent');
    expect(await outcome(g.delete(`/api/v1/tokens/${OWN_TOKEN}/keys/${OWN_KEY}`, { data: [OWN_ITEM] }))).toBe('sent');
    expect(mutationsSeen()).toHaveLength(9);
    expect(A.arrived.filter((a) => a.method === 'GET' && a.url === `/api/v1/keys/${OWN_KEY}/items/${OWN_ITEM}`).length, 'the item was read live under its key').toBeGreaterThan(0);
    A.reset();
    const refused: Array<[string, () => Promise<unknown>, RefusalKind | string]> = [
        ['a foreign item on sign', () => g.post(`${ops}/${FOREIGN_ITEM}/sign`, { data: {} }), 'ownership'],
        ['a foreign item in the bulk list', () => g.patch('/api/v1/keys/items/disable', { data: [FOREIGN_ITEM] }), 'ownership'],
        ['a foreign item in the per-key list', () => g.patch(`/api/v1/keys/${OWN_KEY}/disable`, { data: [FOREIGN_ITEM] }), 'ownership'],
        ['an item recorded as keys (type mismatch)', () => g.post(`/api/v1/keys/${OWN_KEY}/items/${OWN_ITEM_AS_KEY}/export`, { data: {} }), 'ownership'],
        ['a keys line in the item list', () => g.patch('/api/v1/keys/items/enable', { data: [OWN_KEY] }), 'ownership'],
        ['an item line without its parent key', () => g.patch(`/api/v1/keys/${OWN_KEY}/items/${OWN_ITEM_NO_PARENT}/export/disable`), 'error: LiveObjectMissing'],
        ['an item whose live name is foreign (review X02)', () => g.post(`/api/v1/keys/${OWN_KEY}/items/${OWN_ITEM_RENAMED}/export`, { data: {} }), 'ownership'],
        ['a foreign token profile in the operations path', () => g.post(`/api/v1/operations/tokens/${OWN_TOKEN}/tokenProfiles/${FOREIGN_PROFILE}/keys/${OWN_KEY}/items/${OWN_ITEM}/sign`, { data: {} }), 'ownership'],
        ['a foreign key in the item path', () => g.post(`/api/v1/keys/${FOREIGN}/items/${OWN_ITEM}/export`, { data: {} }), 'ownership'],
    ];
    for (const [name, call, kind] of refused) expect(await outcome(call()), name).toMatch(new RegExp(`^${kind}`));
    expect(await outcome(g.patch('/api/v1/keys/items/disable', { data: [g.probeUuid()] })), 'probes still pass').toBe('sent');
    expect(mutationsSeen()).toEqual(['PATCH /api/v1/keys/items/disable']);
    expect(B.arrived).toEqual([]);
});

// ------------------------------------------------------------------ platform G-2

test('platform G-2: ruleUuid of a provider rule on an own compliance profile is waived; internal rules, foreign profiles, other routes, lists, nested keys and string bodies are not', async () => {
    expect(ROUTE_FIELD_WAIVERS.map((w) => `${w.method} ${w.path} ${w.field}`)).toEqual(['PATCH /v2/complianceProfiles/{id}/rules ruleUuid']);
    expect([...routeFieldWaivers('PATCH', `/v2/complianceProfiles/${OWN_COMPLIANCE}/rules`, { connectorUuid: FOREIGN2 })]).toEqual(['ruleUuid']);
    expect([...routeFieldWaivers('PATCH', `/v2/complianceProfiles/${OWN_COMPLIANCE}/rules`, { connectorUuid: `urn:uuid:${FOREIGN2}` })]).toEqual([]);
    expect([...routeFieldWaivers('PATCH', `/v2/complianceProfiles/${OWN_COMPLIANCE}/rules`, [])]).toEqual([]);
    const g = guard();
    const url = `/api/v2/complianceProfiles/${OWN_COMPLIANCE}/rules`;
    const provider = { removal: false, ruleUuid: FOREIGN, connectorUuid: FOREIGN2, kind: 'x509', attributes: [] };
    expect(await outcome(g.patch(url, { data: provider }))).toBe('sent');
    expect(await outcome(g.patch(url, { data: { ...provider, removal: true } }))).toBe('sent');
    expect(mutationsSeen()).toEqual([`PATCH ${url}`, `PATCH ${url}`]);
    A.reset();
    const refused: Array<[string, () => Promise<unknown>, RefusalKind]> = [
        ['an internal rule (no connectorUuid)', () => g.patch(url, { data: { removal: false, ruleUuid: FOREIGN } }), 'request'],
        ['a foreign profile', () => g.patch(`/api/v2/complianceProfiles/${FOREIGN2}/rules`, { data: provider }), 'ownership'],
        ['another route (PUT the profile)', () => g.put(`/api/v2/complianceProfiles/${OWN_COMPLIANCE}`, { data: { name: `${RUN}-c`, ruleUuid: FOREIGN, connectorUuid: FOREIGN2 } }), 'request'],
        ['the groups route', () => g.patch(`/api/v2/complianceProfiles/${OWN_COMPLIANCE}/groups`, { data: { removal: false, groupUuid: FOREIGN, connectorUuid: FOREIGN2, kind: 'x509' } }), 'ownership'],
        ['a non-canonical ruleUuid', () => g.patch(url, { data: { ...provider, ruleUuid: `urn:uuid:${FOREIGN}` } }), 'request'],
        ['ruleUuid as a list', () => g.patch(url, { data: { ...provider, ruleUuid: [FOREIGN] } }), 'request'],
        ['ruleUuid nested', () => g.patch(url, { data: { ...provider, ruleUuid: g.probeUuid(), rules: [{ ruleUuid: FOREIGN }] } }), 'request'],
        ['a string body (raw text: no waivers)', () => g.patch(url, { data: JSON.stringify(provider) }), 'ownership'],
        ['connectorUuid as a list', () => g.patch(url, { data: { ...provider, connectorUuid: [FOREIGN2] } }), 'request'],
    ];
    for (const [name, call, kind] of refused) expect(await outcome(call()), name).toBe(kind);
    noMutationArrived();
    expect(B.arrived).toEqual([]);
});

// ------------------------------------------------------------------ platform G-3 (rejected), G-4, lifecycle G1

test('platform G-3 pin (rejected): a callback on a pre-existing connector or object stays refused; G-4: POST /v2/connectors is a create, proxyUuid probes only, connect / approve platform-level', async () => {
    const g = guard();
    expect(await outcome(g.post(`/api/v2/connectors/${PRE_CONNECTOR}/callback`, { data: { name: 'x' } }))).toBe('ownership');
    expect(await outcome(g.post(`/api/v1/connectors/${PRE_CONNECTOR}/authorityProvider/ejbca/callback`, { data: { name: 'x' } })), 'a connector KIND segment is name-keyed (rule 6a) before ownership').toBe('request');
    expect(await outcome(g.post(`/api/v1/certificates/${FOREIGN}/callback`, { data: { name: 'x' } }))).toBe('ownership');
    expect(postKind('/v2/connectors')).toBe('create');
    expect(postKind('/v2/complianceProfiles')).toBe('create');
    expect(await outcome(g.post('/api/v2/complianceProfiles', { data: { name: `${RUN}-cp`, description: 'x', customAttributes: [] } }))).toBe('sent');
    expect(await outcome(g.post('/api/v2/complianceProfiles', { data: { name: `${RUN}-cp`, internalRules: [FOREIGN] } })), 'internalRules stay probes-only').toBe('request');
    A.reset();
    expect(isRawPostAllowed('/v2/connectors')).toBe(false);
    expect(await outcome(g.post('/api/v2/connectors', { data: { name: `${RUN}-stub`, url: 'http://host.docker.internal:9999', authType: 'none', customAttributes: [] } }))).toBe('sent');
    expect(await outcome(g.post('/api/v2/connectors', { data: { name: `${RUN}-stub`, url: 'http://x', authType: 'none', proxyUuid: g.probeUuid() } }))).toBe('sent');
    expect(mutationsSeen()).toEqual(['POST /api/v2/connectors', 'POST /api/v2/connectors']);
    A.reset();
    expect(await outcome(g.post('/api/v2/connectors', { data: { name: `${RUN}-stub`, url: 'http://x', authType: 'none', proxyUuid: FOREIGN } }))).toBe('request');
    // Review F1: a pre-existing proxy named by its CODE (no uuid) binds the new connector: refused on both creates, any depth / case; blank / null / absent pass.
    for (const path of ['/api/v2/connectors', '/api/v1/connectors']) {
        const base = { name: `${RUN}-stub`, url: 'http://x', authType: 'none' };
        for (const body of [{ ...base, proxyCode: 'edge-1' }, { ...base, ProxyCode: 'edge-1' }, { ...base, proxyCode: ' x ' }, { ...base, proxyCode: 1 }, { ...base, proxyCode: ['edge-1'] }, { ...base, customAttributes: [{ proxyCode: 'edge-1' }] }, { ...base, nested: { proxycode: 'e' } }]) {
            const got = await refusal(g.post(path, { data: body }));
            expect([got.kind, got.reason.slice(0, 40)], `${path} ${JSON.stringify(body)}`).toEqual(['request', expect.stringMatching(/^a connector create with a "/)]);
        }
        for (const body of [base, { ...base, proxyCode: '' }, { ...base, proxyCode: '   ' }, { ...base, proxyCode: null }]) expect(await outcome(g.post(path, { data: body })), `${path} ${JSON.stringify(body)}`).toBe('sent');
    }
    expect(mutationsSeen()).toEqual(['POST /api/v2/connectors', 'POST /api/v2/connectors', 'POST /api/v2/connectors', 'POST /api/v2/connectors', 'POST /api/v1/connectors', 'POST /api/v1/connectors', 'POST /api/v1/connectors', 'POST /api/v1/connectors']);
    A.reset();
    expect(await outcome(g.post('/api/v2/connectors/connect', { data: { url: 'http://x', authType: 'none' } }))).toBe('request');
    expect(await outcome(g.patch(`/api/v2/connectors/${g.probeUuid()}/approve`))).toBe('request');
    expect(await outcome(g.post('/api/v2/connectors/approve', { data: [g.probeUuid()] }))).toBe('request');
    expect(await outcome(g.post('/api/v1/connector/register', { data: { name: 'x' } }))).toBe('request');
    noMutationArrived();
    expect(B.arrived).toEqual([]);
});

test('cert-lifecycle G1: …/certificates/register is a create under foreign scope parents; sourceCertificateUuid / ownerUuid / groupUuids must be own', async () => {
    const path = `/api/v2/operations/authorities/${FOREIGN}/raProfiles/${FOREIGN2}/certificates/register`;
    expect(postKind(path.slice(4))).toBe('create');
    const g = guard();
    expect(await outcome(g.post(path, { data: { subjectDn: 'CN=x', csrAttributes: [], attributes: [{ uuid: FOREIGN, content: [] }] } }))).toBe('sent');
    expect(await outcome(g.post(path, { data: { subjectDn: 'CN=x', sourceCertificateUuid: OWN_CERT, ownerUuid: OWN_USER, groupUuids: [OWN_GROUP] } }))).toBe('sent');
    expect(mutationsSeen()).toEqual([`POST ${path}`, `POST ${path}`]);
    A.reset();
    expect(await outcome(g.post(path, { data: { subjectDn: 'CN=x', sourceCertificateUuid: FOREIGN } }))).toBe('ownership');
    expect(await outcome(g.post(path, { data: { subjectDn: 'CN=x', ownerUuid: FOREIGN_USER } }))).toBe('ownership');
    expect(await outcome(g.post(path, { data: { subjectDn: 'CN=x', groupUuids: [OWN_GROUP, FOREIGN] } }))).toBe('ownership');
    expect((await refusal(g.post(path, { data: { subjectDn: 'CN=x', sourceCertificateUuid: OWN_ROLE } }))).reason).toMatch(/records it as roles, but the body field sourceCertificateUuid names certificates/);
    expect(await outcome(g.post(`${path}/extra`, { data: { subjectDn: 'CN=x' } }))).toBe('request');
    noMutationArrived();
    expect(B.arrived).toEqual([]);
});
