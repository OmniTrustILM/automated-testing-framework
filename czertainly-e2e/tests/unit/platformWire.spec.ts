/**
 * platformWire — the key, vault, compliance and connector helpers through the real guard against a stateful loopback
 * fake core: each test asserts the requests that arrived (routes, bodies), the ledger types and parents the teardown
 * relies on, and the response readers on fixtures shaped like the interface DTOs.
 */
import { APIRequestContext, expect, test } from '@playwright/test';
import { GuardedApi } from '../../utils/regression/guard/types';
import { cipherOutputOf, itemRef, operationUrl, signatureAttributesFor, signatureOf, signWithItem, verificationOf } from '../../utils/regression/platform/keyOperations';
import { compromiseOwnKey, createOwnKey, deleteOwnKey, KeyChain, updateOwnKeyItemUsages } from '../../utils/regression/platform/keys';
import { createOwnToken, createOwnTokenProfile, enableOwnTokenProfile, findCryptoConnector } from '../../utils/regression/platform/tokens';
import { toRequestAttributes } from '../../utils/regression/customAttributes';
import { patchOwnComplianceRule } from '../../utils/regression/platform/complianceProfiles';
import { findCredentialConnector } from '../../utils/regression/platform/connectorLookup';
import { teardownHandlers as platformHandlers } from '../../utils/regression/platform/platformTeardown';
import { createOwnVaultProfile } from '../../utils/regression/platform/secretsAndVaults';
import { PlatformStack, stackConfig } from '../../utils/regression/platform/localStack';
import { readLedger, recordCreated } from '../../utils/regression/ledger/ledger';
import { runId } from '../../utils/regression/ledger/runState';
import type { TeardownContext } from '../../utils/regression/teardown/runTeardown';
import { Answer, Arrived, LoopbackServer } from './helpers/loopbackServer';
import { FakeCore as BaseCore } from './helpers/fakeCore';
import { registerFakeCore } from './helpers/guardRig';
import type { JsonObject } from '../../utils/regression/json';

const U = (n: number) => `00000000-0000-4000-8000-${String(n).padStart(12, '0')}`;
const C_V2 = U(1);
const C_V1 = U(2);
const C_CRED = U(3);
const C_CRED_KS = U(4);
const VAULT = U(50);
const RULE = U(60);
const PROFILE = U(61);
const SPEC = 'platform-wire';

/** A fake core that remembers what the run created (GET answers it; a deleted uuid answers 404). */
class PlatformCore extends BaseCore {
    protected seq = 100;
    readonly deleted = new Set<string>();

    protected respond(a: Arrived): Answer | undefined {
        const path = a.url.split('?')[0];
        const body = a.body ? (JSON.parse(a.body) as JsonObject) : undefined;
        const uuids = path.match(/[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/g) ?? [];
        const last = uuids[uuids.length - 1];
        if (last && this.deleted.has(last)) return { status: 404, body: { message: 'gone' } };
        if (a.method === 'GET') return this.get(path, uuids);
        if (a.method === 'POST') return this.post(path, body);
        if (a.method === 'DELETE' && last) {
            this.deleted.add(last);
            return { status: 204 };
        }
        return { status: 204 };
    }

    private get(path: string, uuids: string[]): Answer {
        const fixed: Record<string, unknown> = {
            '/api/v1/connectors': [
                { uuid: C_V1, name: 'Software-Cryptography-Provider', status: 'connected', functionGroups: [{ functionGroupCode: 'cryptographyProvider', kinds: ['SOFT'] }] },
                { uuid: C_V2, name: 'Software-Cryptography-Provider-v2', status: 'connected', functionGroups: [{ functionGroupCode: 'cryptographyProvider', kinds: [] }] },
                { uuid: C_CRED_KS, name: 'Keystore-Only-Credentials', status: 'connected', functionGroups: [{ functionGroupCode: 'credentialProvider', kinds: ['SoftKeyStore'] }] },
                { uuid: C_CRED, name: 'Common-Credential-Connector', status: 'connected', functionGroups: [{ functionGroupCode: 'credentialProvider', kinds: ['SoftKeyStore', 'Basic', 'ApiKey'] }] },
            ],
            [`/api/v2/connectors/${C_V1}`]: { uuid: C_V1, version: 'v1' },
            [`/api/v2/connectors/${C_V2}`]: { uuid: C_V2, version: 'v2' },
            [`/api/v1/tokens/${C_V2}/attributes`]: [{ name: 'data_options', uuid: U(70) }, { name: 'data_createTokenAction', uuid: U(71) }, { name: 'data_newTokenName', uuid: U(72) }, { name: 'data_tokenCode', uuid: U(73) }],
            [`/api/v1/vaults/${VAULT}/vaultProfiles/attributes`]: [{ name: 'data_mount', uuid: U(80), type: 'data', contentType: 'string', properties: { required: true } }],
        };
        if (path in fixed) return { status: 200, body: fixed[path] };
        if (path.startsWith('/api/v1/attributes/custom/resources/')) return { status: 200, body: [] };
        if (/\/keys\/keyPair\/attributes$/.test(path)) return { status: 200, body: [{ name: 'data_keyAlgorithm', uuid: U(90), content: [{ reference: 'RSA', data: 'RSA' }, { reference: 'ECDSA', data: 'ECDSA' }] }, { name: 'data_keyAlias', uuid: U(91) }] };
        const last = uuids[uuids.length - 1];
        // GET /v1/keys/{key}/items/{item}: the live read of a keyItems line answers the KEY's name.
        const itemRead = /^\/api\/v1\/keys\/([0-9a-f-]{36})\/items\/([0-9a-f-]{36})$/.exec(path);
        if (itemRead && this.store.has(itemRead[1])) return { status: 200, body: { uuid: itemRead[2], name: this.store.get(itemRead[1])!.name, type: 'PrivateKey' } };
        if (last && this.store.has(last)) return { status: 200, body: this.store.get(last) };
        return { status: 404, body: { message: `no fake route GET ${path}` } };
    }

    private post(path: string, body: JsonObject | undefined): Answer {
        const uuid = this.next();
        if (path === '/api/v1/tokens') {
            this.store.set(uuid, { uuid, name: body?.name, connectorUuid: body?.connectorUuid, status: { status: 'Unknown' } });
            return { status: 200, body: { uuid } };
        }
        if (/^\/api\/v1\/tokens\/[0-9a-f-]{36}\/tokenProfiles$/.test(path)) {
            this.store.set(uuid, { uuid, name: body?.name, tokenInstanceUuid: path.split('/')[4], enabled: body?.enabled });
            return { status: 200, body: { uuid } };
        }
        if (/\/keys\/keyPair$/.test(path)) {
            const items = [{ uuid: this.next(), type: 'PrivateKey', state: 'active', enabled: false }, { uuid: this.next(), type: 'PublicKey', state: 'active', enabled: false }];
            this.store.set(uuid, { uuid, name: body?.name, items });
            return { status: 200, body: { uuid, items } };
        }
        if (/\/items\/[0-9a-f-]{36}\/sign$/.test(path)) return { status: 200, body: { signatures: [{ data: 'c2ln' }] } };
        if (/^\/api\/v1\/vaults\/[0-9a-f-]{36}\/vaultProfiles$/.test(path)) {
            this.store.set(uuid, { uuid, name: body?.name, vaultInstanceUuid: VAULT });
            return { status: 200, body: { uuid } };
        }
        return { status: 404, body: { message: `no fake route POST ${path}` } };
    }
}

let server: LoopbackServer;
let core: PlatformCore;
let raw: APIRequestContext;
let api: GuardedApi;

registerFakeCore(() => core, (rig) => ({ server, raw, api } = rig), { clear: ['REG_CRYPTO_CONNECTOR_V1', 'REG_CRYPTO_CONNECTOR_V2', 'REG_CREDENTIAL_CONNECTOR'] });
test.beforeEach(() => {
    core = new PlatformCore();
});

const arrivedPath = (a: Arrived) => a.url.split('?')[0];

/** The chain of one test through the real guard: own token (v2), own profile (enabled), own RSA key. */
async function chain(): Promise<KeyChain> {
    const connector = (await findCryptoConnector(api, 2))!;
    const token = await createOwnToken(api, SPEC, 'wire-tok', { connector });
    const tokenProfile = await createOwnTokenProfile(api, SPEC, 'wire-tp', { token });
    await enableOwnTokenProfile(api, token, tokenProfile);
    const key = await createOwnKey(api, SPEC, 'wire-key', { chain: { token, tokenProfile }, family: 'rsa-2048' });
    return { connector, provider: 'scp-v2', token, tokenProfile, key: { uuid: key.uuid, name: key.name, kind: 'own', keyItems: key.keyItems } };
}

test('findCryptoConnector picks by interface VERSION (v2 → the v2 record, v1 → the v1 record); findCredentialConnector needs the Basic KIND', async () => {
    expect((await findCryptoConnector(api, 2))?.uuid).toBe(C_V2);
    expect((await findCryptoConnector(api, 1))?.uuid).toBe(C_V1);
    // The named connector is the v2 record: for version 1 the version check must fall through to the detected v1 record.
    process.env.REG_CRYPTO_CONNECTOR_V1 = 'Software-Cryptography-Provider-v2';
    expect((await findCryptoConnector(api, 1))?.uuid, 'a wrong-version name is skipped, never returned').toBe(C_V1);
    process.env.REG_CRYPTO_CONNECTOR_V2 = 'Software-Cryptography-Provider';
    expect((await findCryptoConnector(api, 2))?.uuid).toBe(C_V2);
    process.env.REG_CREDENTIAL_CONNECTOR = 'Keystore-Only-Credentials';
    expect((await findCredentialConnector(api, 'Basic'))?.uuid, 'the named connector lacks the Basic kind: the one with it wins').toBe(C_CRED);
    expect(server.mutations(), 'reads only').toEqual([]);
});

test('token → profile → key through the guard: the v2 token body has no kind, the profile is disabled by default, the ledger carries the types and parents the teardown needs', async () => {
    const c = await chain();
    const posts = server.mutations().filter((a) => a.method === 'POST');
    const tokenPost = posts.find((a) => arrivedPath(a) === '/api/v1/tokens')!;
    const tokenBody = JSON.parse(tokenPost.body) as JsonObject;
    expect(tokenBody.kind, 'a v2 token carries no kind').toBeUndefined();
    expect(tokenBody.connectorUuid).toBe(C_V2);
    expect((tokenBody.attributes as JsonObject[]).map((a) => a.name)).toEqual(['data_options', 'data_createTokenAction', 'data_newTokenName', 'data_tokenCode']);
    expect(String(tokenBody.name).startsWith(`${runId()}-`)).toBe(true);
    const profilePost = posts.find((a) => /tokenProfiles$/.test(arrivedPath(a)))!;
    expect(JSON.parse(profilePost.body)).toMatchObject({ enabled: false, usage: ['sign', 'verify', 'encrypt', 'decrypt'] });
    expect(server.mutations().some((a) => a.method === 'PATCH' && arrivedPath(a) === `/api/v1/tokens/${c.token.uuid}/tokenProfiles/${c.tokenProfile.uuid}/enable`)).toBe(true);
    const keyPost = posts.find((a) => /keys\/keyPair$/.test(arrivedPath(a)))!;
    expect(arrivedPath(keyPost)).toBe(`/api/v1/tokens/${c.token.uuid}/tokenProfiles/${c.tokenProfile.uuid}/keys/keyPair`);
    expect(JSON.parse(keyPost.body).attributes.map((a: JsonObject) => a.name)).toEqual(['data_keyAlias', 'data_keyAlgorithm', 'data_rsaKeySize']);
    const lines = readLedger().filter((l) => l.event === 'created');
    expect(lines.map((l) => l.type)).toEqual(['tokens', 'tokenProfiles', 'keys', 'keyItems', 'keyItems']);
    expect(lines[1].parents).toEqual({ token: c.token.uuid });
    expect(lines[2].parents).toEqual({ token: c.token.uuid, tokenProfile: c.tokenProfile.uuid });
    // Each item: parent key, the KEY's run-prefixed name (what the live read answers).
    expect(lines.slice(3).map((l) => ({ parents: l.parents, name: l.name, uuid: l.uuid }))).toEqual([
        { parents: { key: c.key.uuid }, name: c.key.name, uuid: c.key.keyItems!.privateUuid },
        { parents: { key: c.key.uuid }, name: c.key.name, uuid: c.key.keyItems!.publicUuid },
    ]);
    expect(c.key.keyItems).toEqual({ privateUuid: expect.stringMatching(/^aaaaaaaa/), publicUuid: expect.stringMatching(/^aaaaaaaa/) });
});

test('compromise sends {reason} to PATCH /keys/{own}/compromise; deleteOwnKey sends DELETE /keys/{own} and writes the deleted line', async () => {
    const c = await chain();
    server.reset();
    const res = await compromiseOwnKey(api, c.key, 'disclosure');
    expect(res.status()).toBe(204);
    const patch = server.mutations().find((a) => a.method === 'PATCH')!;
    expect(arrivedPath(patch)).toBe(`/api/v1/keys/${c.key.uuid}/compromise`);
    expect(JSON.parse(patch.body)).toEqual({ reason: 'disclosure' });
    server.reset();
    await deleteOwnKey(api, c.key, SPEC);
    expect(server.mutations().map((a) => `${a.method} ${arrivedPath(a)}`)).toEqual([`DELETE /api/v1/keys/${c.key.uuid}`]);
    expect(readLedger().some((l) => l.event === 'deleted' && l.uuid === c.key.uuid && l.type === 'keys')).toBe(true);
});

test('on the wire: an own key ITEM signs through its operation route, the per-item usage DTO is sent, a provider ruleUuid on an own compliance profile is sent', async () => {
    const c = await chain();
    server.reset();
    const signed = await signWithItem(api, itemRef(c, 'private'), 'AAAA', []);
    expect(signed.status()).toBe(200);
    expect(signatureOf(await signed.json())).toBe('c2ln');
    expect(server.mutations().map(arrivedPath)).toEqual([operationUrl(itemRef(c, 'private'), 'sign')]);
    expect(JSON.parse(server.mutations()[0].body)).toEqual({ signatureAttributes: [], data: [{ data: 'AAAA' }] });
    server.reset();
    expect((await updateOwnKeyItemUsages(api, c.key.keyItems!.privateUuid!, ['sign', 'decrypt'])).status()).toBe(204);
    expect(server.mutations().map((a) => `${a.method} ${arrivedPath(a)}`)).toEqual(['PUT /api/v1/keys/items/usages']);
    expect(JSON.parse(server.mutations()[0].body)).toEqual({ uuids: [c.key.keyItems!.privateUuid], usage: ['sign', 'decrypt'] });
    server.reset();
    const profile = recordCreated('complianceProfiles', { uuid: PROFILE, name: `${runId()}-cp` }, { spec: SPEC });
    core.store.set(PROFILE, { uuid: PROFILE, name: profile.name });
    const patched = await patchOwnComplianceRule(api, profile, { ruleUuid: RULE, connectorUuid: C_CRED, kind: 'x509' }, []);
    expect(patched.status()).toBe(204);
    expect(server.mutations().map((a) => `${a.method} ${arrivedPath(a)}`)).toEqual([`PATCH /api/v2/complianceProfiles/${PROFILE}/rules`]);
    expect(JSON.parse(server.mutations()[0].body)).toEqual({ removal: false, ruleUuid: RULE, connectorUuid: C_CRED, kind: 'x509', attributes: [] });
});

test('own vault profile under a pre-existing vault: POST /vaults/{vault}/vaultProfiles with the filled attributes, ledger parent vault; the teardown deletes through that parent', async () => {
    const profile = await createOwnVaultProfile(api, SPEC, 'wire-vp', { vault: { uuid: VAULT, name: 'pre-existing-vault' } });
    const post = server.mutations().find((a) => a.method === 'POST')!;
    expect(arrivedPath(post)).toBe(`/api/v1/vaults/${VAULT}/vaultProfiles`);
    expect(JSON.parse(post.body).attributes).toEqual([{ name: 'data_mount', uuid: U(80), version: 'v2', contentType: 'string', content: [{ data: 'qa' }] }]);
    const line = readLedger().find((l) => l.uuid === profile.uuid)!;
    expect(line).toMatchObject({ type: 'vaultProfiles', parents: { vault: VAULT } });
    server.reset();
    // `live` without the vault field: the LEDGER parent must drive the URL (the detail is only the fallback).
    const ctx: TeardownContext = { api: raw, runId: runId(), ledger: readLedger(), seen: new Set([profile.uuid]), tier: null, warn: () => {}, live: { uuid: profile.uuid, name: profile.name } };
    await platformHandlers.vaultProfiles.remove(ctx, line);
    expect(server.mutations().map((a) => `${a.method} ${arrivedPath(a)}`)).toEqual([`DELETE /api/v1/vaults/${VAULT}/vaultProfiles/${profile.uuid}`]);
    // The vault parent of the LINE decides the URL: a line without it (and a detail without the vault) is refused, not guessed.
    await expect(platformHandlers.vaultProfiles.remove({ ...ctx, live: {} }, { ...line, parents: undefined })).rejects.toThrow(/no vault known/);
});

test('response readers on DTO-shaped fixtures; operationUrl; signatureAttributesFor carries the picked option; toRequestAttributes drops info attributes', () => {
    expect(signatureOf({ signatures: [{ data: 'c2ln', identifier: 'x' }] })).toBe('c2ln');
    expect(signatureOf({ signature: 'wrong' })).toBeUndefined();
    expect(verificationOf({ verifications: [{ result: true, identifier: 'x' }] })).toBe(true);
    expect(verificationOf({ verifications: [{ result: false }] })).toBe(false);
    expect(verificationOf({ result: true })).toBeUndefined();
    expect(cipherOutputOf({ encryptedData: [{ data: 'ZW5j' }] })).toBe('ZW5j');
    expect(cipherOutputOf({ decryptedData: [{ data: 'ZGVj' }] })).toBe('ZGVj');
    expect(cipherOutputOf({ cipher: 'x' })).toBeUndefined();
    const item = { tokenUuid: U(1), tokenProfileUuid: U(2), keyUuid: U(3), itemUuid: U(4) };
    expect(operationUrl(item, 'sign')).toBe(`/api/v1/operations/tokens/${U(1)}/tokenProfiles/${U(2)}/keys/${U(3)}/items/${U(4)}/sign`);
    expect(operationUrl(item, 'decrypt')).toMatch(/\/items\/[0-9a-f-]{36}\/decrypt$/);
    const defs = [{ name: 'signatureAlgorithm', uuid: U(9), contentType: 'string', content: [{ reference: 'RSASSA-PSS with SHA-256', data: 'RSA_PSS_SHA256' }, { reference: 'ECDSA with SHA-256', data: 'ECDSA_SHA256' }] }];
    expect(signatureAttributesFor(defs, { family: 'rsa-2048', scheme: 'PSS', digest: 'SHA-256', label: '' })).toEqual([{ name: 'signatureAlgorithm', uuid: U(9), version: 'v2', contentType: 'string', content: [{ reference: 'RSASSA-PSS with SHA-256', data: 'RSA_PSS_SHA256' }] }]);
    expect(signatureAttributesFor(defs, { family: 'ml-dsa-65', label: '' })).toBeUndefined();
    expect(toRequestAttributes([{ uuid: 'a', name: 'data_x', contentType: 'string', content: [{ data: 1 }] }, { uuid: 'i', name: 'info_y', type: 'info', contentType: 'text', content: [] }, { uuid: 'm', name: 'meta_z', type: 'meta', contentType: 'string', content: [] }]).map((a) => a.name)).toEqual(['data_x']);
});

test('the stack guard stops every command outside a proven local tier: nothing reaches the runner', () => {
    const calls: string[][] = [];
    const runner = (bin: string, args: string[]) => {
        calls.push([bin, ...args]);
        return { ok: true, status: 0, stdout: '', stderr: '' };
    };
    const cfg = stackConfig({ LOCAL_COMPOSE_PROJECT: 'proj', REG_DOCKER_BIN: '/tmp/fake-docker' });
    const shared = new PlatformStack(cfg, runner, { TIER_KIND: 'shared', BASE_URL: 'http://127.0.0.1:3080' });
    for (const call of [() => shared.stop('core'), () => shared.start('rabbitmq'), () => shared.downWithVolumes(), () => shared.psql('select 1'), () => shared.logs('core')]) {
        expect(call).toThrow(/TIER_KIND=local/);
    }
    const remote = new PlatformStack(cfg, runner, { TIER_KIND: 'local', BASE_URL: 'https://qa.example.com' });
    expect(() => remote.stop('core')).toThrow(/loopback/);
    const noProject = new PlatformStack(stackConfig({ REG_DOCKER_BIN: '/tmp/fake-docker' }), runner, { TIER_KIND: 'local', BASE_URL: 'http://127.0.0.1:3080' });
    expect(() => noProject.downWithVolumes()).toThrow(/LOCAL_COMPOSE_PROJECT or LOCAL_COMPOSE_FILE/);
    expect(calls).toEqual([]);
});
