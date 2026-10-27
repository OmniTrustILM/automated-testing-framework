/**
 * The guard's refusal messages, one row per named rule, and the order of the rules.
 *
 * WHAT: every step of the guard that refuses (readRequest.ts: readOptions … readForwarded; checkRequest.ts:
 * checkProbeRead … checkDryRun) has a row here: a request that breaks that rule and the message the guard refuses it
 * with. The two steps that are not plain refusals are pinned elsewhere: the waiver of the caller's own user in an own
 * approval profile (waiveSelfSteps) and the approval-decision proofs (approvalDecisionProblem, assertOwnApprovalDecision)
 * in guardedApiApprovalsAndOidTeardown.spec.ts. A second test sends requests that break a rule AND every rule that
 * comes after it and expects the message of the first.
 * WHY: the order of the rules is part of the guard's specification; a request that breaks two rules is refused with the
 * message of the earlier one. If the rules are reordered the failing row is named after the rule that moved.
 * HOW: a real Playwright context against a loopback fake core, like the other guard unit files; every refused request
 * must leave the core untouched.
 */
import { APIRequestContext, expect, test } from '@playwright/test';
import { guardApiWithSeams } from '../../utils/regression/guard/createGuard';
import { DryRunRefusal } from '../../utils/regression/run/flags';
import { OwnObjectViolation, RefusalKind } from '../../utils/regression/ledger/ownership';
import { LedgerLine } from '../../utils/regression/ledger/ledger';
import { LoopbackServer } from './helpers/loopbackServer';
import { guardVerdict } from './helpers/guardVerdict';
import { looseApi, registerGuardRig } from './helpers/guardRig';

const RUN = 'qa-reg-20261022-100000-ro01';
const U = (n: number) => `00000000-0000-4000-8000-${String(n).padStart(12, '0')}`;
const OWN_ROLE = U(3);
const OWN_CERT = U(5);
const OWN_USER = U(6);
const OWN_VIEW = U(7);
const FOREIGN = U(20);

const lines: LedgerLine[] = [
    { at: 'a', runId: RUN, type: 'roles', name: `${RUN}-role`, uuid: OWN_ROLE, spec: 'T', event: 'created' },
    { at: 'a', runId: RUN, type: 'certificates', name: `${RUN}.example.test`, uuid: OWN_CERT, spec: 'T', event: 'created' },
    { at: 'a', runId: RUN, type: 'users', name: `${RUN}-user`, uuid: OWN_USER, spec: 'T', event: 'created' },
    // A saved view the run once recorded: the type has no route any more, so it authorises nothing.
    { at: 'a', runId: RUN, type: 'savedViews', name: `${RUN}-view`, uuid: OWN_VIEW, spec: 'T', event: 'created' },
];
const live: Record<string, unknown> = {
    [`/api/v1/roles/${OWN_ROLE}`]: { name: `${RUN}-role` },
    [`/api/v1/certificates/${OWN_CERT}`]: { commonName: `${RUN}.example.test` },
    [`/api/v1/users/${OWN_USER}`]: { username: `${RUN}-user` },
};

let A: LoopbackServer;
let B: LoopbackServer;
let raw: APIRequestContext;
let BASE_URL: string;

registerGuardRig(
    { answer: (a) => (a.method === 'GET' ? (live[a.url] ? { status: 200, body: live[a.url] } : { status: 404, body: {} }) : undefined) },
    (rig) => {
        A = rig.A;
        B = rig.B;
        raw = rig.raw;
        BASE_URL = rig.BASE_URL;
    },
);

const guard = (env: Record<string, string> = {}) => guardApiWithSeams(raw, { lines, runId: RUN, tier: null, env: { BASE_URL, ...env } });

async function refusal(call: Promise<unknown>): Promise<{ kind: RefusalKind | 'sent' | string; reason: string }> {
    try {
        await call;
        return { kind: 'sent', reason: '' };
    } catch (e) {
        if (e instanceof OwnObjectViolation) return { kind: e.kind, reason: e.reason };
        if (e instanceof DryRunRefusal) return { kind: 'dry-run', reason: e.message };
        return { kind: `error: ${String(e).slice(0, 200)}`, reason: String(e) };
    }
}

type Row = [rule: string, call: (g: any) => Promise<unknown>, kind: string, message: RegExp]; // eslint-disable-line @typescript-eslint/no-explicit-any

const own = (suffix = '') => `/api/v1/roles/${OWN_ROLE}${suffix}`;
const TP = { 'content-type': 'text/plain' };

/** Step by step, in the order the guard runs them: reading the request (rules a–d), then checking it (rules 1–7). */
const ROWS: Row[] = [
    // readOptions
    ['readOptions: options that are not an object', (g) => g.get('/api/v1/roles', 'x'), 'request', /^request options that are not an object$/],
    ['readOptions: a symbol key', (g) => g.get('/api/v1/roles', { [Symbol('x')]: 1 }), 'request', /^a symbol option key$/],
    ['readOptions: a form body', (g) => g.post(own(), { form: {} }), 'request', /^a form \/ multipart body \(the guard reads JSON bodies only\)$/],
    ['readOptions: an option the guard does not forward', (g) => g.get('/api/v1/roles', { whatever: 1 }), 'request', /^the option "whatever" \(the guard forwards data, params, headers, timeout, failOnStatusCode, ignoreHTTPSErrors only; the URL goes as the first argument\)$/],
    ['readOptions: method is an option of fetch only', (g) => g.get('/api/v1/roles', { method: 'DELETE' }), 'request', /^the option "method" \(/],
    // readMethodAndUrl
    ['readMethodAndUrl: a URL that is not a string', (g) => g.get(undefined), 'request', /^a URL that is not a string \(a String \/ URL object is refused; pass the string\)$/],
    ['readMethodAndUrl: a Request object', (g) => g.fetch({ url: () => own(), method: () => 'GET' }), 'request', /^a URL that is not a string/],
    ['readMethodAndUrl: a method that is not a string', (g) => g.fetch(own(), { method: 5 }), 'request', /^a method that is not a string$/],
    ['readMethodAndUrl: a method the guard does not send', (g) => g.fetch(own(), { method: 'OPTIONS' }), 'request', /^the method "OPTIONS" \(GET, POST, PUT, PATCH, DELETE and TRACE only\)$/],
    ['readMethodAndUrl: the method HEAD', (g) => g.head(own()), 'request', /^the method "HEAD" \(GET, POST, PUT, PATCH, DELETE and TRACE only\)$/],
    ['readMethodAndUrl: another origin', (g) => g.get(`${B.origin}/api/v1/roles`), 'request', /requests go to BASE_URL only, as written$/],
    // readIdentityOverride
    ['readIdentityOverride: not a boolean', (g) => g.get('/api/v1/roles', { identityOverride: 'yes' }), 'request', /^identityOverride must be a boolean$/],
    ['readIdentityOverride: on a refused-method probe', (g) => g.fetch('/api/v1/info', { method: 'TRACE', identityOverride: true }), 'request', /^identityOverride on a TRACE \(a refused-method probe carries no identity header\)$/],
    // readParams, readQuery
    ['readParams: params that are not a plain object', (g) => g.get('/api/v1/roles', { params: new Map() }), 'request', /^params that are not a string, URLSearchParams or a plain object$/],
    ['readParams: a value that is not a primitive', (g) => g.get('/api/v1/roles', { params: { x: {} } }), 'request', /^a params value that is not a string, number or boolean$/],
    ['readQuery: a _method override', (g) => g.get('/api/v1/roles', { params: { _method: 'DELETE' } }), 'request', /^a _method query parameter \(a method override\)$/],
    // readHeaders
    ['readHeaders: headers that are not a plain object', (g) => g.get('/api/v1/roles', { headers: [] }), 'request', /^headers that are not a plain object$/],
    ['readHeaders: a value that is not a string', (g) => g.get('/api/v1/roles', { headers: { accept: 1 } }), 'request', /^a header value that is not a string$/],
    ['readHeaders: the same header twice', (g) => g.get('/api/v1/roles', { headers: { Accept: 'a', accept: 'b' } }), 'request', /^the same header twice \(in another case\)$/],
    ['readHeaders: a method-override header', (g) => g.get('/api/v1/roles', { headers: { 'X-HTTP-Method-Override': 'DELETE' } }), 'request', /^a method-override header$/],
    ['readHeaders: an identity header without identityOverride', (g) => g.get('/api/v1/roles', { headers: { Authorization: 'x' } }), 'request', /^an identity header \(authorization, ssl-client-cert, cookie\) without identityOverride: true$/],
    // readBody
    ['readBody: text/plain on a GET', (g) => g.get('/api/v1/roles', { headers: TP }), 'request', /^text\/plain on a GET \/ TRACE \(/],
    ['readBody: text/plain with an identity header', (g) => g.put(own(), { data: 'x', headers: { ...TP, Authorization: 'x' }, identityOverride: true }), 'request', /^an identity header on a text\/plain request/],
    ['readBody: text/plain with an object body', (g) => g.put(own(), { data: {}, headers: TP }), 'request', /^text\/plain with a body that is not a string or Buffer/],
    ['readBody: a duplicate JSON key', (g) => g.put(own(), { data: '{"a":1,"a":2}' }), 'request', /duplicate/i],
    ['readBody: a body on a GET', (g) => g.get('/api/v1/roles', { data: [1] }), 'request', /^a body on a GET \/ TRACE$/],
    // readForwarded
    ['readForwarded: timeout', (g) => g.get('/api/v1/roles', { timeout: '5' }), 'request', /^timeout must be a non-negative number$/],
    ['readForwarded: failOnStatusCode', (g) => g.get('/api/v1/roles', { failOnStatusCode: 1 }), 'request', /^failOnStatusCode must be a boolean$/],
    ['readForwarded: ignoreHTTPSErrors', (g) => g.get('/api/v1/roles', { ignoreHTTPSErrors: 'x' }), 'request', /^ignoreHTTPSErrors must be a boolean$/],
    // checkProbeRead, checkRead
    ['checkProbeRead: a path that is not plain', (g) => g.fetch('/api/v1//info', { method: 'TRACE' }), 'request', /: the guard checks plain paths only \(TRACE too\)$/],
    ['checkProbeRead: a side-effect GET path', (g) => g.fetch(`/api/v1/certificates/${OWN_CERT}/validate`, { method: 'TRACE' }), 'request', /^a TRACE on a path that persists something for a GET/],
    ['checkRead: a path that is not plain', (g) => g.get('/api/v1//roles'), 'request', /: the guard checks plain paths only \(GET too\)$/],
    ['checkRead: a side-effect GET without an object of the run', (g) => g.get('/api/v1/approvals'), 'request', /^a GET that persists something .*without an object of the run in its path$/],
    ['checkRead: a side-effect GET on a foreign object', (g) => g.get(`/api/v1/certificates/${FOREIGN}/validate`), 'ownership', /no ledger "created" line/],
    // checkMutationPath
    ['checkMutationPath: a path that is not plain', (g) => g.delete('/api/v1/roles//x'), 'request', /: the guard checks plain paths only$/],
    ['checkMutationPath: outside the ILM API', (g) => g.delete('/somewhere/else'), 'request', /^a mutating request outside the ILM API is not allowed through the guarded context$/],
    // checkNoHandlerProbe
    ['checkNoHandlerProbe: a body', (g) => g.delete('/api/v1/info', { data: { a: 1 } }), 'request', /^a body on the no-handler probe DELETE \/v1\/info/],
    ['checkNoHandlerProbe: a query', (g) => g.delete('/api/v1/info?x=1'), 'request', /^a query on the no-handler probe DELETE \/v1\/info/],
    ['checkNoHandlerProbe: an identity header', (g) => g.delete('/api/v1/info', { headers: { cookie: 'a=b' }, identityOverride: true }), 'request', /^an identity header or identityOverride on the no-handler probe DELETE \/v1\/info/],
    // checkUuidSegments
    ['checkUuidSegments: a canonical uuid inside a longer segment', (g) => g.delete(`/api/v1/roles/${OWN_ROLE}x`), 'request', /^a non-canonical uuid segment in the path/],
    // checkBody
    ['checkBody: a Buffer body that is not JSON on a route that is not a create', (g) => g.put(own(), { data: Buffer.from('not json') }), 'request', /^a Buffer body that is not JSON/],
    ['checkBody: the shape rule of a create', (g) => g.post('/api/v1/connectors', { data: { name: `${RUN}-c`, proxyCode: 'p' } }), 'request', /^a connector create with a "proxyCode"/],
    // findUuids
    ['findUuids: a non-canonical uuid form', (g) => g.put(own(), { data: { roleUuid: ` ${OWN_ROLE}` } }), 'request', /^a non-canonical uuid form in the body or query/],
    // checkPlatformDeny
    ['checkPlatformDeny: a platform endpoint', (g) => g.put('/api/v1/settings/platform', { data: {} }), 'request', /^platform settings is platform-level: @local rows with localStack on a proven local stack only$/],
    // checkOwnership (claims)
    ['checkOwnership: a name-keyed path', (g) => g.put('/api/v1/roles/some-name', { data: {} }), 'request', /^a path segment that is neither a uuid nor a word of the ILM API/],
    ['checkOwnership: a mutation without a uuid off the allow-lists', (g) => g.post('/api/v1/certificates/create', { data: {} }), 'request', /^a mutation without a uuid in the path that is neither an allow-listed create/],
    ['checkOwnership: a bulk body with filters', (g) => g.patch('/api/v1/raProfiles/disable', { data: { filters: [] } }), 'request', /^a bulk body with filters \(never accepted: they select objects the guard cannot see\)$/],
    ['checkOwnership: a foreign object in the path', (g) => g.delete(`/api/v1/roles/${FOREIGN}`), 'ownership', /no ledger "created" line/],
    ['checkOwnership: a foreign object in the body', (g) => g.put(own(), { data: { name: 'x', userUuids: [FOREIGN] } }), 'ownership', /no ledger "created" line/],
    ['checkOwnership: a typed target of the wrong type', (g) => g.delete(`/api/v1/raProfiles/${OWN_ROLE}`), 'ownership', /^the ledger records it as roles, but the request acts on raProfiles/],
    ['checkOwnership: a uuid named as two resources', (g) => g.put(`/api/v1/users/${OWN_USER}/roles/${OWN_USER}`), 'request', /^one uuid named as two different resources in one request$/],
    // checkDryRun
    ['checkDryRun: a DELETE of an own object under the dry run', (g) => g.delete(own()), 'dry-run', /: API_TEARDOWN_DRY_RUN is on, nothing may be deleted or changed by the teardown$/],
];

test('every rule of the guard refuses with its own message, and sends nothing', async () => {
    const wrong: string[] = [];
    for (const [rule, call, kind, message] of ROWS) {
        const g = guard(rule.startsWith('checkDryRun') ? { API_TEARDOWN_DRY_RUN: '1' } : {});
        const got = await refusal(call(g));
        if (got.kind !== kind) wrong.push(`${rule}: ${got.kind} ${got.reason.slice(0, 120)}`);
        else if (!message.test(got.reason)) wrong.push(`${rule}: message ${JSON.stringify(got.reason.slice(0, 160))} does not match ${message}`);
    }
    expect(wrong).toEqual([]);
    expect(A.mutations(), 'nothing refused reached the core').toEqual([]);
    expect(A.arrived.every((a) => a.method === 'GET' && live[a.url] !== undefined), 'only live reads of own objects').toBe(true);
    expect(B.arrived).toEqual([]);
});

/**
 * Requests that break a rule AND every later rule: the guard names the first. The body of each carries a foreign uuid, a
 * padded uuid, a platform path or a name-keyed path where the rule allows it, so a reorder shows as a named diff.
 */
const LADDER: Row[] = [
    ['rule 1 path (before the uuid segment, the body and the ownership)', (g) => g.put(`/api/v1/roles//${FOREIGN}x`, { data: { roleUuid: ` ${FOREIGN}` } }), 'request', /: the guard checks plain paths only$/],
    ['rule 2b no-handler probe (before the body rules)', (g) => g.delete('/api/v1/info', { data: { roleUuid: ` ${FOREIGN}` } }), 'request', /^a body on the no-handler probe/],
    ['rule 3 uuid segment (before the body and the ownership)', (g) => g.put(`/api/v1/roles/${FOREIGN}x`, { data: { roleUuid: ` ${FOREIGN}`, userUuids: [FOREIGN] } }), 'request', /^a non-canonical uuid segment in the path/],
    ['rule 4 body shape (before the uuid forms and the ownership)', (g) => g.post('/api/v1/connectors', { data: { proxyCode: 'p', roleUuid: ` ${FOREIGN}`, userUuids: [FOREIGN] } }), 'request', /^a connector create with a "proxyCode"/],
    ['rule 4 uuid forms (before the platform deny-list and the ownership)', (g) => g.put('/api/v1/settings/platform', { data: { roleUuid: ` ${FOREIGN}`, userUuids: [FOREIGN] } }), 'request', /^a non-canonical uuid form in the body or query/],
    ['rule 5 platform deny-list (before the ownership)', (g) => g.put('/api/v1/settings/platform', { data: { userUuids: [FOREIGN] } }), 'request', /^platform settings is platform-level/],
    ['rule 6 name-keyed path (before the claims)', (g) => g.put('/api/v1/roles/some-name', { data: { userUuids: [FOREIGN] } }), 'request', /^a path segment that is neither a uuid nor a word of the ILM API/],
    ['rule 6 ownership (before the dry run)', (g) => g.delete(`/api/v1/roles/${FOREIGN}`), 'ownership', /no ledger "created" line/],
];

test('a request that breaks several rules is refused by the first one, in the order of the rules', async () => {
    const wrong: string[] = [];
    for (const [rule, call, kind, message] of LADDER) {
        const got = await refusal(call(guard({ API_TEARDOWN_DRY_RUN: '1' })));
        if (got.kind !== kind) wrong.push(`${rule}: ${got.kind} ${got.reason.slice(0, 120)}`);
        else if (!message.test(got.reason)) wrong.push(`${rule}: message ${JSON.stringify(got.reason.slice(0, 160))} does not match ${message}`);
    }
    expect(wrong).toEqual([]);
    // The dry run comes last: a DELETE of an own object under it is refused only after the ownership proof.
    expect((await refusal(guard({ API_TEARDOWN_DRY_RUN: '1' }).delete(own()))).kind).toBe('dry-run');
    expect(A.mutations()).toEqual([]);
});

test('the read POSTs are allowed before the body and ownership rules (rule 2)', async () => {
    const g = guard();
    const search = { filters: [{ fieldSource: 'property', fieldIdentifier: 'COMMON_NAME', condition: 'EQUALS', value: FOREIGN }], itemsPerPage: 10, pageNumber: 1 };
    expect((await refusal(g.post('/api/v1/certificates', { data: search }))).kind).toBe('sent');
    expect(A.mutations().map((a) => `${a.method} ${a.url}`)).toEqual(['POST /api/v1/certificates']);
});

// What the guard does not take: a saved view write, an observer option, a verdict-only method, HEAD, the redirect and retry
// options and a Request object as the target. Each is refused (or absent), never forwarded.
test('refused: saved view writes, HEAD, the options maxRedirects and maxRetries and a Request object; absent: onRequest and check', async () => {
    const calls: string[] = [];
    // an observer option the public seams do not take: the cast is the point of the case
    const g = looseApi(guardApiWithSeams(raw, { lines, runId: RUN, tier: null, env: { BASE_URL }, onRequest: (m: string, u: string) => calls.push(`${m} ${u}`) } as never));
    await g.get('/api/v1/roles', { failOnStatusCode: false });
    expect(calls, 'the observer option is not read').toEqual([]);
    // `check` is not a member of the guarded API: read through a record view to prove it is absent
    expect((g as unknown as Record<string, unknown>).check, 'the verdict-only method is gone').toBeUndefined();
    const viewBody = { name: `${RUN}-view`, resource: 'certificates', columns: [] };
    expect((await refusal(g.post('/api/v1/listViews', { data: viewBody }))).reason).toMatch(/^a mutation without a uuid in the path that is neither an allow-listed create/);
    for (const uuid of [OWN_ROLE, FOREIGN]) {
        const update = await refusal(g.put(`/api/v1/listViews/${uuid}`, { data: viewBody }));
        expect([update.kind, update.reason]).toEqual(['request', expect.stringMatching(/^a mutation of PUT \/v1\/listViews\/.* on a resource the suite has no ledger type for/)]);
    }
    for (const uuid of [OWN_VIEW, FOREIGN]) {
        const removed = await refusal(g.delete(`/api/v1/listViews/${uuid}`));
        expect([removed.kind, removed.reason], `DELETE of the view ${uuid === OWN_VIEW ? 'the run recorded' : 'of someone else'}`)
            .toEqual(['request', expect.stringMatching(/^a mutation of DELETE \/v1\/listViews\/.* on a resource the suite has no ledger type for/)]);
    }
    expect(A.mutations(), 'no saved-view write reached the core').toEqual([]);
    expect((await refusal(g.get('/api/v1/roles', { maxRedirects: 1 }))).reason).toMatch(/^the option "maxRedirects"/);
    expect((await refusal(g.get('/api/v1/roles', { maxRetries: 1 }))).reason).toMatch(/^the option "maxRetries"/);
    expect((await refusal(g.head('/api/v1/roles'))).reason).toMatch(/^the method "HEAD"/);
    expect((await refusal(g.fetch({ url: () => '/api/v1/roles', method: () => 'GET' }))).reason).toMatch(/^a URL that is not a string/);
    expect(A.arrived.filter((a) => a.url.startsWith('/api/v1/listViews'))).toEqual([]);
});

test('the verdict helper judges exactly what the guard sends: same refusal, nothing on the wire', async () => {
    const judge = guardVerdict(raw, { lines, runId: RUN, tier: null, env: { BASE_URL } });
    await judge.check('GET', '/api/v1/roles');
    await expect(judge.check('DELETE', `/api/v1/roles/${FOREIGN}`)).rejects.toThrow(OwnObjectViolation);
    expect(A.arrived).toEqual([]);
});
