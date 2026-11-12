/**
 * guardedApiTimestamping — the guard rules the timestamping block needs on a shared tier (tests/timestamping/SHARED-TIER.md),
 * each in both directions on the wire (a real Playwright context, a loopback fake core, a second origin that must see nothing):
 * the time-quality configuration (own create / update / delete, no longer platform-level), the signing and TSP profile creates,
 * the nested connector reference of a signing profile, the TSP activation, Basic credentials, role grants, the three attribute
 * callbacks (a kind of their own: registered parent, scanned body, no raw context) and the lists. The refused neighbour of every allowance is a row too, so a rule cannot widen unnoticed.
 */
import { APIRequestContext, expect, test } from '@playwright/test';
import { guardApiWithSeams } from '../../utils/regression/guard/createGuard';
import { findUuidsInBody } from '../../utils/regression/guard/bodies';
import { registerCallbackTarget } from '../../utils/regression/guard/callbackTargets';
import type { GuardedApi } from '../../utils/regression/guard/types';
import { platformDenied, postRouteKind } from '../../utils/regression/guard/allowLists';
import { allowedRawPost, isAllowedRawPostUrl } from '../../utils/regression/guard/rawPost';
import { isRawPostRouteAllowed } from '../../utils/regression/guard/allowLists';
import { ROUTE_PATH_WAIVERS, routePathWaivers } from '../../utils/regression/guard/routes';
import { LedgerLine } from '../../utils/regression/ledger/ledger';
import { OwnObjectViolation, RefusalKind } from '../../utils/regression/ledger/ownership';
import { Arrived, LoopbackServer } from './helpers/loopbackServer';
import { registerGuardRig } from './helpers/guardRig';

const RUN = 'qa-reg-20261026-120000-ts01';
const U = (n: number) => `00000000-0000-4000-8000-${String(n).padStart(12, '0')}`;

// Own objects of the run (a ledger line + a live run-prefixed name each).
const O = {
    role: U(1), user: U(2), cert: U(3), vault: U(4), vaultProfile: U(5), tsp: U(6), sp: U(7), tqc: U(8), cred: U(9), key: U(10), token: U(11), tokenProfile: U(14),
    otherRole: U(12), otherSp: U(13),
};
// Pre-existing objects (no line, or a line of another run): foreign.
const F = { tsp: U(21), sp: U(22), tqc: U(23), cert: U(24), connector: U(25), role: U(26), user: U(27), vaultProfile: U(28), cred: U(29), authority: U(30) };

const mk = (type: string, uuid: string, name = `${RUN}-${type}`, parents?: LedgerLine['parents']): LedgerLine =>
    ({ at: 'a', runId: RUN, type, name, uuid, spec: 'timestamping/setup', event: 'created', ...(parents ? { parents } : {}) });

const lines: LedgerLine[] = [
    mk('roles', O.role), mk('roles', O.otherRole), mk('users', O.user), mk('certificates', O.cert, `${RUN}-tsa`),
    mk('vaultProfiles', O.vaultProfile, `${RUN}-vp`, { vault: O.vault }), mk('tspProfiles', O.tsp), mk('signingProfiles', O.sp), mk('signingProfiles', O.otherSp),
    mk('timeQualityConfigurations', O.tqc), mk('tspBasicCredentials', O.cred, `${RUN}-user`, { tspProfile: O.tsp }), mk('keys', O.key), mk('tokens', O.token), mk('tokenProfiles', O.tokenProfile, `${RUN}-tp`, { token: O.token }),
];

const live: Record<string, unknown> = {
    [`/api/v1/roles/${O.role}`]: { name: `${RUN}-roles` }, [`/api/v1/roles/${O.otherRole}`]: { name: `${RUN}-roles` }, [`/api/v1/users/${O.user}`]: { username: `${RUN}-users` },
    [`/api/v1/certificates/${O.cert}`]: { commonName: `${RUN}-tsa` }, [`/api/v1/vaults/${O.vault}/vaultProfiles/${O.vaultProfile}`]: { name: `${RUN}-vp` },
    [`/api/v1/tspProfiles/${O.tsp}`]: { name: `${RUN}-tspProfiles` }, [`/api/v1/signingProfiles/${O.sp}`]: { name: `${RUN}-signingProfiles` },
    [`/api/v1/signingProfiles/${O.otherSp}`]: { name: `${RUN}-signingProfiles` },
    [`/api/v1/timeQualityConfigurations/${O.tqc}`]: { name: `${RUN}-timeQualityConfigurations` },
    [`/api/v1/tspProfiles/${O.tsp}/basicCredentials/${O.cred}`]: { username: `${RUN}-user` },
    [`/api/v1/tokens/${O.token}/tokenProfiles/${O.tokenProfile}`]: { name: `${RUN}-tp` }, [`/api/v1/keys/${O.key}`]: { name: `${RUN}-keys` }, [`/api/v1/tokens/${O.token}`]: { name: `${RUN}-tokens` },
    // Pre-existing objects have live names of somebody else's.
    [`/api/v1/tspProfiles/${F.tsp}`]: { name: 'production-tsa' }, [`/api/v1/signingProfiles/${F.sp}`]: { name: 'production-signing' },
    [`/api/v1/timeQualityConfigurations/${F.tqc}`]: { name: 'qualified-time-source' },
};
const coreAnswer = (a: Arrived) => (a.method === 'GET' || a.method === 'HEAD' ? (live[a.url] ? { status: 200, body: live[a.url] } : { status: 404, body: {} }) : undefined);

let A: LoopbackServer;
let B: LoopbackServer;
let raw: APIRequestContext;
let BASE_URL: string;

registerGuardRig({ answer: coreAnswer }, (rig) => {
    A = rig.A;
    B = rig.B;
    raw = rig.raw;
    BASE_URL = rig.BASE_URL;
});

const guard = () => guardApiWithSeams(raw, { lines, runId: RUN, tier: null, env: { BASE_URL } });

async function kind(call: Promise<unknown>): Promise<RefusalKind | 'sent' | string> {
    try {
        await call;
        return 'sent';
    } catch (e) {
        return e instanceof OwnObjectViolation ? e.kind : `error: ${String(e).slice(0, 200)}`;
    }
}
const sentMutations = () => A.mutations().map((a) => `${a.method} ${a.url.replace(/^\/api/, '')}`);

const signingProfileBody = (over: { connector?: unknown; cert?: string; tqc?: string; type?: string; extraWorkflow?: Record<string, unknown>; extra?: Record<string, unknown> } = {}) => ({
    name: `${RUN}-tsa-rsa-non-qualified`,
    workflow: {
        type: over.type ?? 'timestamping', signatureFormattingConnectorUuid: over.connector ?? F.connector, signatureFormattingConnectorAttributes: [{ uuid: U(900), name: 'x', content: [], contentType: 'string', version: 'v2' }],
        qualifiedTimestamp: true, defaultPolicyId: '1.2.3.4', allowedPolicyIds: ['1.2.3.4'], allowedDigestAlgorithms: ['SHA-256'],
        ...(over.tqc ? { timeQualityConfigurationUuid: over.tqc } : {}), ...(over.extraWorkflow ?? {}),
    },
    signingScheme: { signingScheme: 'managed', managedSigningType: 'static_key', certificateUuid: over.cert ?? O.cert, signingOperationAttributes: [] },
    customAttributes: [], ...(over.extra ?? {}),
});

// ------------------------------------------------------------------ time-quality configuration: per object, not platform-level

test('time-quality configuration: create, update and delete of an OWN one are sent; a pre-existing one is refused; it is not platform-level any more', async () => {
    const g = guard();
    expect(platformDenied(`/v1/timeQualityConfigurations/${O.tqc}`), 'no longer on the platform deny-list').toBeUndefined();
    expect(postRouteKind('/v1/timeQualityConfigurations')).toBe('create');
    const body = { name: `${RUN}-time-quality`, accuracy: 'PT1S', ntpServers: ['ntp'], maxClockDrift: 'PT0.8S', leapSecondGuard: true, customAttributes: [] };
    expect(await kind(g.post('/api/v1/timeQualityConfigurations', { data: body }))).toBe('sent');
    expect(await kind(g.put(`/api/v1/timeQualityConfigurations/${O.tqc}`, { data: body }))).toBe('sent');
    expect(await kind(g.delete(`/api/v1/timeQualityConfigurations/${O.tqc}`))).toBe('sent');
    expect(sentMutations()).toEqual([
        'POST /v1/timeQualityConfigurations', `PUT /v1/timeQualityConfigurations/${O.tqc}`, `DELETE /v1/timeQualityConfigurations/${O.tqc}`,
    ]);
    A.reset();
    // The refused neighbours: a pre-existing configuration (update, delete), an own uuid of another type, the bulk delete (no route), a body naming a foreign object.
    expect(await kind(g.put(`/api/v1/timeQualityConfigurations/${F.tqc}`, { data: body })), 'update of a pre-existing configuration').toBe('ownership');
    expect(await kind(g.delete(`/api/v1/timeQualityConfigurations/${F.tqc}`)), 'delete of a pre-existing configuration').toBe('ownership');
    expect(await kind(g.delete(`/api/v1/timeQualityConfigurations/${O.role}`)), 'an own role is no configuration').toBe('ownership');
    expect(await kind(g.delete('/api/v1/timeQualityConfigurations', { data: [O.tqc] })), 'the bulk delete has no route in the guard').toBe('request');
    expect(await kind(g.post('/api/v1/timeQualityConfigurations', { data: { ...body, ownerUuid: F.user } })), 'a foreign uuid in a create body').toBe('ownership');
    expect(A.mutations()).toEqual([]);
    expect(B.arrived).toEqual([]);
});

// ------------------------------------------------------------------ signing profile create

test('signing profile create: the connector is referenced, certificate and time-quality configuration must be own', async () => {
    const g = guard();
    expect(postRouteKind('/v1/signingProfiles')).toBe('create');
    expect(await kind(g.post('/api/v1/signingProfiles', { data: signingProfileBody({ tqc: O.tqc }) })), 'pre-existing connector, own certificate and configuration').toBe('sent');
    expect(await kind(g.post('/api/v1/signingProfiles', { data: signingProfileBody({ type: 'content_signing' }) })), 'the content-signing canary has the same waiver').toBe('sent');
    expect(sentMutations()).toEqual(['POST /v1/signingProfiles', 'POST /v1/signingProfiles']);
    A.reset();
    // Direction 2: everything else the body names is still judged.
    expect(await kind(g.post('/api/v1/signingProfiles', { data: signingProfileBody({ cert: F.cert }) })), 'a pre-existing certificate').toBe('ownership');
    expect(await kind(g.post('/api/v1/signingProfiles', { data: signingProfileBody({ tqc: F.tqc }) })), 'a pre-existing time-quality configuration').toBe('ownership');
    expect(await kind(g.post('/api/v1/signingProfiles', { data: signingProfileBody({ tqc: O.role }) })), 'an own role under the configuration field (typed)').toBe('ownership');
    expect(await kind(g.post('/api/v1/signingProfiles', { data: signingProfileBody({ extra: { ownerUuid: F.user } }) })), 'a foreign uuid elsewhere in the body').toBe('ownership');
    expect(A.mutations()).toEqual([]);
    expect(B.arrived).toEqual([]);
});

test('the connector waiver is exact: one key path, one route, a string, the right workflow type', async () => {
    const g = guard();
    const wf = (over: Record<string, unknown>) => ({ ...signingProfileBody().workflow, ...over });
    // The same field elsewhere in the body, another workflow type, a list, another route, another method, a non-canonical form.
    expect(await kind(g.post('/api/v1/signingProfiles', { data: { ...signingProfileBody(), signingScheme: { ...signingProfileBody().signingScheme, signatureFormattingConnectorUuid: F.connector } } })), 'nested elsewhere').toBe('ownership');
    expect(await kind(g.post('/api/v1/signingProfiles', { data: { ...signingProfileBody(), signatureFormattingConnectorUuid: F.connector } })), 'top level').toBe('ownership');
    expect(await kind(g.post('/api/v1/signingProfiles', { data: signingProfileBody({ type: 'raw_signing' }) })), 'a workflow type without the field').toBe('ownership');
    expect(await kind(g.post('/api/v1/signingProfiles', { data: { ...signingProfileBody(), workflow: wf({ signatureFormattingConnectorUuid: [F.connector] }) } })), 'a list').toBe('ownership');
    expect(await kind(g.post('/api/v1/signingProfiles', { data: { ...signingProfileBody(), workflow: { nested: wf({}) } } })), 'one level deeper').toBe('ownership');
    expect(await kind(g.post('/api/v1/signingProfiles', { data: signingProfileBody({ connector: `urn:uuid:${F.connector}` }) })), 'a non-canonical form is never waived').toBe('request');
    expect(await kind(g.put(`/api/v1/signingProfiles/${O.sp}`, { data: signingProfileBody() })), 'the update route has no waiver').toBe('ownership');
    expect(await kind(g.post('/api/v1/tspProfiles', { data: { name: `${RUN}-t`, vaultProfileUuid: O.vaultProfile, signatureFormattingConnectorUuid: F.connector } })), 'another route').toBe('ownership');
    expect(await kind(g.post('/api/v1/signingProfiles', { data: JSON.stringify(signingProfileBody()) })), 'a text body is judged as written: no waiver').toBe('ownership');
    expect(A.mutations()).toEqual([]);
    // The table and its helper.
    expect(ROUTE_PATH_WAIVERS.map((w) => `${w.method} ${w.path} ${w.keyPath.join('.')}`)).toEqual(['POST /v1/signingProfiles workflow.signatureFormattingConnectorUuid']);
    expect(routePathWaivers('POST', '/v1/signingProfiles', signingProfileBody())).toEqual([['workflow', 'signatureFormattingConnectorUuid']]);
    expect(routePathWaivers('POST', '/v1/signingProfiles', [])).toEqual([]);
    expect(routePathWaivers('PUT', '/v1/signingProfiles', signingProfileBody())).toEqual([]);
    expect(findUuidsInBody(signingProfileBody(), { waivePaths: [['workflow', 'signatureFormattingConnectorUuid']] }).canonical).not.toContain(F.connector);
    expect(findUuidsInBody(signingProfileBody(), {}).canonical).toContain(F.connector);
    expect(B.arrived).toEqual([]);
});

// ------------------------------------------------------------------ TSP profile, activation, credentials

test('TSP profile: create and edit take an own vault profile and an own default signing profile; a foreign one is refused', async () => {
    const g = guard();
    expect(postRouteKind('/v1/tspProfiles')).toBe('create');
    const create = { name: `${RUN}-tsp`, vaultProfileUuid: O.vaultProfile, allowedAuthenticationMethods: ['basicPassword'], customAttributes: [] };
    expect(await kind(g.post('/api/v1/tspProfiles', { data: create }))).toBe('sent');
    expect(await kind(g.put(`/api/v1/tspProfiles/${O.tsp}`, { data: { ...create, defaultSigningProfileUuid: O.sp } }))).toBe('sent');
    expect(await kind(g.patch(`/api/v1/tspProfiles/${O.tsp}/enable`))).toBe('sent');
    expect(await kind(g.delete(`/api/v1/tspProfiles/${O.tsp}`))).toBe('sent');
    expect(sentMutations()).toEqual(['POST /v1/tspProfiles', `PUT /v1/tspProfiles/${O.tsp}`, `PATCH /v1/tspProfiles/${O.tsp}/enable`, `DELETE /v1/tspProfiles/${O.tsp}`]);
    A.reset();
    expect(await kind(g.post('/api/v1/tspProfiles', { data: { ...create, vaultProfileUuid: F.vaultProfile } })), 'a pre-existing vault profile').toBe('ownership');
    expect(await kind(g.put(`/api/v1/tspProfiles/${O.tsp}`, { data: { ...create, defaultSigningProfileUuid: F.sp } })), 'a pre-existing default signing profile').toBe('ownership');
    expect(await kind(g.put(`/api/v1/tspProfiles/${O.tsp}`, { data: { ...create, defaultSigningProfileUuid: O.role } })), 'an own role as the default signing profile (typed)').toBe('ownership');
    expect(await kind(g.put(`/api/v1/tspProfiles/${F.tsp}`, { data: create })), 'a pre-existing TSP profile').toBe('ownership');
    expect(await kind(g.patch(`/api/v1/tspProfiles/${F.tsp}/disable`))).toBe('ownership');
    expect(await kind(g.delete(`/api/v1/tspProfiles/${F.tsp}`))).toBe('ownership');
    expect(await kind(g.patch('/api/v1/tspProfiles/disable', { data: [O.tsp] })), 'the bulk routes stay untyped').toBe('request');
    expect(A.mutations()).toEqual([]);
    expect(B.arrived).toEqual([]);
});

test('signing profile: enable, disable, delete and the TSP activation need own objects on both sides', async () => {
    const g = guard();
    expect(await kind(g.patch(`/api/v1/signingProfiles/${O.sp}/enable`))).toBe('sent');
    expect(await kind(g.patch(`/api/v1/signingProfiles/${O.sp}/disable`))).toBe('sent');
    expect(await kind(g.patch(`/api/v1/signingProfiles/${O.sp}/protocols/tsp/activate/${O.tsp}`))).toBe('sent');
    expect(await kind(g.patch(`/api/v1/signingProfiles/${O.sp}/protocols/tsp/deactivate`))).toBe('sent');
    expect(await kind(g.delete(`/api/v1/signingProfiles/${O.otherSp}`))).toBe('sent');
    expect(sentMutations()).toHaveLength(5);
    A.reset();
    expect(await kind(g.patch(`/api/v1/signingProfiles/${F.sp}/enable`)), 'a pre-existing signing profile').toBe('ownership');
    expect(await kind(g.patch(`/api/v1/signingProfiles/${F.sp}/disable`))).toBe('ownership');
    expect(await kind(g.delete(`/api/v1/signingProfiles/${F.sp}`))).toBe('ownership');
    expect(await kind(g.patch(`/api/v1/signingProfiles/${O.sp}/protocols/tsp/activate/${F.tsp}`)), 'activating an own signing profile on a pre-existing TSP profile').toBe('ownership');
    expect(await kind(g.patch(`/api/v1/signingProfiles/${F.sp}/protocols/tsp/activate/${O.tsp}`)), 'activating a pre-existing signing profile on an own TSP profile').toBe('ownership');
    expect(await kind(g.patch(`/api/v1/signingProfiles/${O.sp}/protocols/tsp/activate/${O.role}`)), 'an own role in the TSP profile position (typed)').toBe('ownership');
    expect(await kind(g.patch(`/api/v1/signingProfiles/${F.sp}/protocols/tsp/deactivate`))).toBe('ownership');
    expect(await kind(g.patch('/api/v1/signingProfiles/enable', { data: [O.sp] })), 'the bulk routes stay untyped').toBe('request');
    expect(await kind(g.delete('/api/v1/signingRecords', { data: [O.sp] })), 'signing records are deleted by the teardown handler only').toBe('request');
    expect(await kind(g.delete(`/api/v1/signingRecords/${O.sp}`))).toBe('request');
    expect(A.mutations()).toEqual([]);
    expect(B.arrived).toEqual([]);
});

test('Basic credential: created only under an own TSP profile for an own user; deleted only when recorded', async () => {
    const g = guard();
    const create = { username: `${RUN}-user`, password: 'generated-by-the-test', mappedUserUuid: O.user };
    expect(postRouteKind(`/v1/tspProfiles/${O.tsp}/basicCredentials`), 'not an allow-listed create: the path names an own TSP profile').toBeUndefined();
    expect(await kind(g.post(`/api/v1/tspProfiles/${O.tsp}/basicCredentials`, { data: create }))).toBe('sent');
    expect(await kind(g.delete(`/api/v1/tspProfiles/${O.tsp}/basicCredentials/${O.cred}`))).toBe('sent');
    A.reset();
    expect(await kind(g.post(`/api/v1/tspProfiles/${F.tsp}/basicCredentials`, { data: create })), 'a credential on a pre-existing TSP profile').toBe('ownership');
    expect(await kind(g.post(`/api/v1/tspProfiles/${O.tsp}/basicCredentials`, { data: { ...create, mappedUserUuid: F.user } })), 'a pre-existing user').toBe('ownership');
    expect(await kind(g.post(`/api/v1/tspProfiles/${O.tsp}/basicCredentials`, { data: { ...create, mappedUserUuid: O.role } })), 'an own role as the mapped user (typed)').toBe('ownership');
    expect(await kind(g.delete(`/api/v1/tspProfiles/${F.tsp}/basicCredentials/${O.cred}`)), 'an own credential under a pre-existing profile').toBe('ownership');
    expect(await kind(g.delete(`/api/v1/tspProfiles/${O.tsp}/basicCredentials/${F.cred}`)), 'a pre-existing credential').toBe('ownership');
    expect(await kind(g.put(`/api/v1/tspProfiles/${O.tsp}/basicCredentials/${F.cred}`, { data: create }))).toBe('ownership');
    expect(A.mutations()).toEqual([]);
    expect(B.arrived).toEqual([]);
});

// ------------------------------------------------------------------ role and user wiring of the setup

test('mapped user and role: the role is attached to an own user and holds grants on own objects only', async () => {
    const g = guard();
    const grants = (uuid: string) => ({ allowAllResources: false, resources: [
        { name: 'tspProfiles', allowAllActions: false, actions: [], objects: [{ uuid, name: 'x', allow: ['timestamp', 'detail'], deny: [] }] },
        { name: 'keys', allowAllActions: false, actions: ['sign'], objects: [] },
    ] });
    expect(await kind(g.patch(`/api/v1/users/${O.user}/roles`, { data: [O.role] }))).toBe('sent');
    expect(await kind(g.post(`/api/v1/roles/${O.role}/permissions`, { data: grants(O.tsp) }))).toBe('sent');
    A.reset();
    expect(await kind(g.patch(`/api/v1/users/${O.user}/roles`, { data: [F.role] })), 'a pre-existing role').toBe('ownership');
    expect(await kind(g.patch(`/api/v1/users/${F.user}/roles`, { data: [O.role] })), 'a pre-existing user').toBe('ownership');
    expect(await kind(g.post(`/api/v1/roles/${F.role}/permissions`, { data: grants(O.tsp) })), 'grants on a pre-existing role').toBe('ownership');
    expect(await kind(g.post(`/api/v1/roles/${O.role}/permissions`, { data: grants(F.tsp) })), 'a grant on a pre-existing TSP profile').toBe('ownership');
    expect(A.mutations()).toEqual([]);
    expect(B.arrived).toEqual([]);
});

// ------------------------------------------------------------------ what stays refused

test('trusting the issuing root (a pre-existing certificate) is refused on a shared tier; the own certificate chain is read', async () => {
    const g = guard();
    expect(await kind(g.patch(`/api/v1/certificates/${F.cert}`, { data: { trustedCa: true } })), 'the one pre-existing change of the local setup').toBe('ownership');
    expect(await kind(g.get(`/api/v1/certificates/${O.cert}/chain`, { failOnStatusCode: false })), 'the chain of an own certificate').toBe('sent');
    expect(await kind(g.get(`/api/v1/certificates/${F.cert}/chain`, { failOnStatusCode: false })), 'the chain of a pre-existing one persists issuer rows: refused').toBe('ownership');
    expect(A.mutations()).toEqual([]);
    expect(B.arrived).toEqual([]);
});

// ------------------------------------------------------------------ reads: lists

test('the lists are reads; deleting signing records is not', async () => {
    const g = guard();
    for (const [path, data] of [
        ['/api/v2/connectors/list', { itemsPerPage: 1000, pageNumber: 1, filters: [] }], ['/api/v1/signingProfiles/list', { itemsPerPage: 10, pageNumber: 1, filters: [] }],
        ['/api/v1/tspProfiles/list', { itemsPerPage: 10, pageNumber: 1, filters: [] }], ['/api/v1/timeQualityConfigurations/list', { itemsPerPage: 10, pageNumber: 1, filters: [] }],
        ['/api/v1/signingRecords', { itemsPerPage: 200, pageNumber: 1, filters: [] }],
        [`/api/v1/signingProfiles/${F.sp}/signingRecords`, { itemsPerPage: 10, pageNumber: 1, filters: [] }],
    ] as const) {
        expect(await kind(g.post(path, { data })), path).toBe('sent');
    }
    A.reset();
    expect(await kind(g.post('/api/v1/signingRecords/delete', { data: [F.sp] }))).toBe('request');
    expect(await kind(g.delete('/api/v1/signingRecords', { data: [F.sp] }))).toBe('request');
    expect(A.mutations()).toEqual([]);
    expect(B.arrived).toEqual([]);
});

// ------------------------------------------------------------------ attribute callbacks: a kind of their own

const DEF = U(901); // an attribute definition uuid: not an inventory object
const callbackBody = (over: Record<string, unknown> = {}) => ({ uuid: DEF, name: 'certificateProfile', pathVariable: { endEntityProfileId: 7, authorityId: 'ejbca-authority-1' }, requestParameter: {}, body: {}, filter: {}, ...over });

test('callbacks: the path id must be what the preflight registered (or an own token profile); the body keeps its definition uuids and nothing else foreign', async () => {
    const g = guard();
    // Nothing registered yet: refused, whatever the body says.
    expect(await kind(g.post(`/api/v1/raProfiles/${F.authority}/callback`, { data: callbackBody() })), 'an authority nobody registered').toBe('request');
    expect(await kind(g.post(`/api/v2/connectors/${F.connector}/callback`, { data: callbackBody() })), 'a connector nobody registered').toBe('request');
    registerCallbackTarget(g, 'authority', F.authority);
    registerCallbackTarget(g, 'connector', F.connector);
    expect(await kind(g.post(`/api/v1/raProfiles/${F.authority}/callback`, { data: callbackBody() })), 'the registered authority').toBe('sent');
    expect(await kind(g.post(`/api/v2/connectors/${F.connector}/callback`, { data: callbackBody({ pathVariable: { option: 'new' } }) })), 'the registered connector').toBe('sent');
    expect(await kind(g.post(`/api/v1/keys/${O.tokenProfile}/callback`, { data: callbackBody({ name: 'group_keySpecV2', attributes: [{ name: 'data_keyAlgorithm', uuid: DEF, version: 'v2', contentType: 'string', content: [{ data: 'RSA', reference: 'RSA' }] }] }) })), 'an own token profile, with an attribute definition uuid in `attributes`').toBe('sent');
    expect(await kind(g.post(`/api/v2/connectors/${F.connector}/callback`, { data: callbackBody({ interfaceUuid: U(902), pathVariable: { x: F.connector } }) })), 'the interface and the registered parent in the body').toBe('sent');
    expect(sentMutations()).toHaveLength(4);
    A.reset();

    // The path id: another pre-existing object, the other kind's registration, a foreign or mistyped token profile.
    expect(await kind(g.post(`/api/v1/raProfiles/${F.tsp}/callback`, { data: callbackBody() })), 'an authority that is not the registered one').toBe('request');
    expect(await kind(g.post(`/api/v1/raProfiles/${F.connector}/callback`, { data: callbackBody() })), 'the connector registered, used as an authority').toBe('request');
    expect(await kind(g.post(`/api/v2/connectors/${F.authority}/callback`, { data: callbackBody() })), 'the authority registered, used as a connector').toBe('request');
    expect(await kind(g.post(`/api/v1/keys/${F.vaultProfile}/callback`, { data: callbackBody() })), 'a pre-existing token profile').toBe('ownership');
    expect(await kind(g.post(`/api/v1/keys/${O.role}/callback`, { data: callbackBody() })), 'an own role in the token profile position (typed)').toBe('ownership');

    // The body: core expands what it names (credentials, secrets, resources) and sends it to the connector.
    const credential = { uuid: F.cred, name: 'production-credential' };
    expect(await kind(g.post(`/api/v1/raProfiles/${F.authority}/callback`, { data: callbackBody({ body: { credential } }) })), 'a foreign credential in body').toBe('ownership');
    expect(await kind(g.post(`/api/v1/raProfiles/${F.authority}/callback`, { data: callbackBody({ pathVariable: { credential: F.cred } }) })), 'a foreign uuid in pathVariable').toBe('ownership');
    expect(await kind(g.post(`/api/v1/raProfiles/${F.authority}/callback`, { data: callbackBody({ requestParameter: { secret: F.cred } }) })), 'a foreign uuid in requestParameter').toBe('ownership');
    expect(await kind(g.post(`/api/v1/raProfiles/${F.authority}/callback`, { data: callbackBody({ filter: { x: F.cred } }) })), 'a foreign uuid in filter').toBe('ownership');
    const attribute = (data: unknown) => ({ name: 'credential', uuid: DEF, version: 'v2', contentType: 'credential', content: [{ data }] });
    expect(await kind(g.post(`/api/v2/connectors/${F.connector}/callback`, { data: callbackBody({ attributes: [attribute(credential)] }) })), 'a foreign credential inside an attribute\'s content').toBe('ownership');
    expect(await kind(g.post(`/api/v2/connectors/${F.connector}/callback`, { data: callbackBody({ attributes: [attribute({ secret: { uuid: F.cred } })] }) })), 'a foreign secret nested in an attribute').toBe('ownership');
    expect(await kind(g.post(`/api/v2/connectors/${F.connector}/callback`, { data: callbackBody({ attributes: [{ ...attribute('x'), referenceUuid: F.cred }] }) })), 'a foreign uuid in another field of an attribute').toBe('ownership');
    expect(await kind(g.post(`/api/v2/connectors/${F.connector}/callback`, { data: callbackBody({ attributes: [{ uuid: DEF, content: [{ uuid: F.cred }] }] }) })), 'a content item\'s uuid is not a definition uuid').toBe('ownership');
    expect(await kind(g.post(`/api/v1/raProfiles/${F.authority}/callback`, { data: callbackBody({ body: { credential: O.role } }) })), 'an own object is claimed like any: sent when own').toBe('sent');
    A.reset();
    expect(await kind(g.post(`/api/v1/raProfiles/${F.authority}/callback`, { data: callbackBody({ connectorUuid: F.connector }) })), 'a top-level reference field is no waiver here').toBe('ownership');
    expect(await kind(g.post(`/api/v2/connectors/${F.connector}/callback`, { data: callbackBody({ interfaceUuid: `urn:uuid:${F.cred}` }) })), 'a non-canonical form').toBe('request');
    expect(await kind(g.post(`/api/v2/connectors/${F.connector}/callback`, { data: JSON.stringify(callbackBody()) })), 'a text body is judged as written: its definition uuid is claimed').toBe('ownership');
    expect(await kind(g.post(`/api/v2/connectors/${F.connector}/callback`, { data: Buffer.from('not json') })), 'a non-JSON body').toBe('request');
    expect(A.mutations()).toEqual([]);
    expect(B.arrived).toEqual([]);
});

test('callbacks: a raw context may not send one; registration takes canonical uuids of the two kinds only; the v1 kind path and other resources stay refused', async () => {
    for (const path of [`/api/v1/raProfiles/${F.authority}/callback`, `/api/v1/keys/${O.tokenProfile}/callback`, `/api/v2/connectors/${F.connector}/callback`]) {
        expect(isRawPostRouteAllowed(path.replace(/^\/api/, '')), `${path}: not a read for a raw context`).toBe(false);
        expect(() => allowedRawPost(`${BASE_URL}${path.replace(/^\//, '')}`)).toThrow(OwnObjectViolation);
    }
    expect(isAllowedRawPostUrl(`/api/v1/raProfiles/${F.authority}/callback`)).toBe(false);
    const g = guard();
    expect(() => registerCallbackTarget(g, 'authority', 'not-a-uuid')).toThrow(/canonical uuid/);
    expect(() => registerCallbackTarget(g, 'vault' as 'authority', F.authority)).toThrow(/unknown kind/);
    expect(() => registerCallbackTarget(raw as unknown as GuardedApi, 'authority', F.authority), 'a raw context is no guarded one').toThrow(/not a guarded context/);
    expect((g as unknown as Record<string, unknown>).allowCallbackTarget, 'the guarded context carries no registration method').toBeUndefined();
    registerCallbackTarget(g, 'connector', F.connector.toUpperCase());
    expect(await kind(g.post(`/api/v2/connectors/${F.connector}/callback`, { data: callbackBody() })), 'registered in upper case, sent in lower').toBe('sent');
    A.reset();
    // A registration belongs to its context: another guard over the same raw context has none.
    expect(await kind(guard().post(`/api/v2/connectors/${F.connector}/callback`, { data: callbackBody() }))).toBe('request');
    expect(await kind(g.post(`/api/v1/connectors/${F.connector}/cryptographyProvider/SOFT/callback`, { data: callbackBody() })), 'the v1 connector callback names its kind').toBe('request');
    expect(await kind(g.post(`/api/v1/tspProfiles/${F.tsp}/callback`, { data: callbackBody() })), 'a callback of another resource').toBe('ownership');
    expect(A.mutations()).toEqual([]);
    expect(B.arrived).toEqual([]);
});
