/**
 * guardedApiKeyOnboarding — the guard rules the key onboarding block needs on a shared tier, each allowance next to its refused neighbour.
 */
import { APIRequestContext, expect, test } from '@playwright/test';
import { guardApiWithSeams } from '../../utils/regression/guard/createGuard';
import { registerCallbackTarget } from '../../utils/regression/guard/callbackTargets';
import { API_WORDS, bulkRoute } from '../../utils/regression/guard/routes';
import { LedgerLine } from '../../utils/regression/ledger/ledger';
import { OwnObjectViolation, RefusalKind } from '../../utils/regression/ledger/ownership';
import { LoopbackServer } from './helpers/loopbackServer';
import { registerGuardRig } from './helpers/guardRig';

const RUN = 'qa-reg-20261102-120000-ko01';
const U = (n: number) => `00000000-0000-4000-8000-${String(n).padStart(12, '0')}`;

const O = { token: U(1), tokenProfile: U(2), key: U(3), item: U(4), attribute: U(5) };
const F = { connector: U(21), tokenProfile: U(22), key: U(23), item: U(24) };

const mk = (type: string, uuid: string, name = `${RUN}-${type}`, parents?: LedgerLine['parents']): LedgerLine =>
    ({ at: 'a', runId: RUN, type, name, uuid, spec: 'key-onboarding/setup', event: 'created', ...(parents ? { parents } : {}) });

const lines: LedgerLine[] = [
    mk('tokens', O.token), mk('tokenProfiles', O.tokenProfile, `${RUN}-tp`, { token: O.token }), mk('keys', O.key, `${RUN}-ko-rsa`),
    mk('keyItems', O.item, `${RUN}-ko-rsa`, { key: O.key }), mk('customAttributes', O.attribute),
];

const live: Record<string, unknown> = {
    [`/api/v1/tokens/${O.token}`]: { name: `${RUN}-tokens` }, [`/api/v1/tokens/${O.token}/tokenProfiles/${O.tokenProfile}`]: { name: `${RUN}-tp` },
    [`/api/v1/keys/${O.key}`]: { name: `${RUN}-ko-rsa` }, [`/api/v1/keys/${O.key}/items/${O.item}`]: { name: `${RUN}-ko-rsa` },
    [`/api/v1/keys/${O.key}/items/${F.item}`]: { name: `${RUN}-ko-rsa` },
    [`/api/v1/attributes/custom/${O.attribute}`]: { name: `${RUN}-customAttributes` },
    [`/api/v1/keys/${F.key}`]: { name: 'production-signing-key' },
};

let A: LoopbackServer;
let raw: APIRequestContext;
let BASE_URL: string;

registerGuardRig({ answer: (a) => (a.method === 'GET' || a.method === 'HEAD' ? (live[a.url] ? { status: 200, body: live[a.url] } : { status: 404, body: {} }) : undefined) }, (rig) => {
    A = rig.A;
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

const onboardBody = { keys: [{ keyHandle: 'aGFuZGxl', name: `${RUN}-ko-ec-edge-signer` }], customAttributes: [{ uuid: O.attribute, name: `${RUN}-customAttributes`, content: [{ data: 'Payments' }] }] };

test('the token-key words are API words, and the bulk removal is a bulk route over keys', () => {
    for (const word of ['tokenKeys', 'onboard', 'removeFromInventory']) expect(API_WORDS.has(word), word).toBe(true);
    expect(bulkRoute('PATCH', '/v1/keys/removeFromInventory')).toMatchObject({ list: 'array', type: 'keys' });
});

test('onboarding: under an own token profile it is sent with own attribute uuids; a foreign profile or a foreign uuid in the body is refused', async () => {
    const g = guard();
    const onboard = (profile: string) => `/api/v1/tokens/${O.token}/tokenProfiles/${profile}/tokenKeys/onboard`;
    expect(await kind(g.get(`/api/v1/tokens/${O.token}/tokenProfiles/${O.tokenProfile}/tokenKeys?pageNumber=1&itemsPerPage=10`)), 'the listing').toBe('sent');
    expect(await kind(g.post(onboard(O.tokenProfile), { data: onboardBody })), 'own token profile').toBe('sent');
    expect(sentMutations()).toEqual([`POST /v1/tokens/${O.token}/tokenProfiles/${O.tokenProfile}/tokenKeys/onboard`]);
    A.reset();
    expect(await kind(g.post(onboard(F.tokenProfile), { data: onboardBody })), 'a pre-existing token profile').toBe('ownership');
    expect(await kind(g.post(onboard(O.tokenProfile), { data: { ...onboardBody, keys: [{ keyHandle: 'aGFuZGxl', keyUuid: F.key }] } })), 'a foreign key named in the body').toBe('ownership');
    expect(await kind(g.post(onboard(O.tokenProfile), { data: { ...onboardBody, ownerUuid: F.key } })), 'a foreign uuid elsewhere in the body').toBe('ownership');
    expect(await kind(g.post(`/api/v1/tokens/${O.token}/tokenProfiles/${O.key}/tokenKeys/onboard`, { data: onboardBody })), 'an own key in the profile position (typed)').toBe('ownership');
    expect(A.mutations()).toEqual([]);
});

test('removal from the inventory: an own key, one or in bulk, is sent; a pre-existing key or a mixed list is refused', async () => {
    const g = guard();
    expect(await kind(g.patch(`/api/v1/keys/${O.key}/removeFromInventory`)), 'one own key').toBe('sent');
    expect(await kind(g.patch('/api/v1/keys/removeFromInventory', { data: [O.key] })), 'own keys in bulk').toBe('sent');
    expect(sentMutations()).toEqual([`PATCH /v1/keys/${O.key}/removeFromInventory`, 'PATCH /v1/keys/removeFromInventory']);
    A.reset();
    expect(await kind(g.patch(`/api/v1/keys/${F.key}/removeFromInventory`)), 'a pre-existing key').toBe('ownership');
    expect(await kind(g.patch('/api/v1/keys/removeFromInventory', { data: [O.key, F.key] })), 'one foreign key in the list').toBe('ownership');
    expect(await kind(g.patch('/api/v1/keys/removeFromInventory', { data: [O.tokenProfile] })), 'an own uuid of another type').toBe('ownership');
    expect(await kind(g.patch('/api/v1/keys/removeFromInventory', { data: { uuids: [O.key] } })), 'not the array the route takes').not.toBe('sent');
    expect(A.mutations()).toEqual([]);
});

test('the token-form callback goes only to the registered connector; signing only with an own key item', async () => {
    const g = guard();
    const callback = { name: 'token', uuid: U(900), interfaceUuid: U(901), attributes: [{ name: 'profile', uuid: U(902), content: [{ data: 'softhsm' }] }] };
    expect(await kind(g.post(`/api/v2/connectors/${F.connector}/callback`, { data: callback })), 'not registered').toBe('request');
    registerCallbackTarget(g, 'connector', F.connector);
    expect(await kind(g.post(`/api/v2/connectors/${F.connector}/callback`, { data: callback })), 'registered').toBe('sent');
    expect(await kind(g.post(`/api/v2/connectors/${U(25)}/callback`, { data: callback })), 'another connector').toBe('request');
    A.reset();

    const sign = (item: string) => `/api/v1/operations/tokens/${O.token}/tokenProfiles/${O.tokenProfile}/keys/${O.key}/items/${item}/sign`;
    expect(await kind(g.post(sign(O.item), { data: { signatureAttributes: [], data: [{ data: 'AA==' }] } })), 'an own item').toBe('sent');
    expect(await kind(g.post(sign(F.item), { data: { signatureAttributes: [], data: [{ data: 'AA==' }] } })), 'an item without its own line').toBe('ownership');
    expect(sentMutations()).toEqual([`POST /v1/operations/tokens/${O.token}/tokenProfiles/${O.tokenProfile}/keys/${O.key}/items/${O.item}/sign`]);
});
