/**
 * keys — the run's own keys on the software cryptography provider: create, read, change and delete; creates are recorded right after the
 * call and every change passes the live own-object check.
 */

import type { APIRequestContext, APIResponse } from '@playwright/test';
import { AttributeDefinition, Family, FAMILIES, Provider, SCP_ATTR, specAttributeOf, Usage } from './cryptoAlgorithmCases';
import type { GuardedApi } from '../guard/types';
import { assertOwnLive } from '../ledger/ownership';
import { apiJson } from '../apiReads';
import { requiredCustomAttributes } from '../customAttributes';
import { pollUntil } from '../wait';
import { KeyRef, OwnRef, recordCreated, Ref } from '../ledger/ledger';
import { runName, runId, ownName } from '../ledger/runState';
import { JsonObject } from '../json';
import { createOwn, deleteOwn } from '../ownCrud';
import { CryptoConnector, tokenAlias, uuidOf, profileUrl } from './tokens';


export type KeyRequestType = 'keyPair' | 'secret';

export function listCreateKeyAttributes(api: APIRequestContext, token: Pick<Ref, 'uuid'>, profile: Pick<Ref, 'uuid'>, type: KeyRequestType = 'keyPair'): Promise<AttributeDefinition[]> {
    return apiJson<AttributeDefinition[]>(api, 'GET', `${profileUrl(token, profile)}/keys/${type}/attributes`);
}

export const keyAlias = (name: string): string => tokenAlias(name);

/**
 * The request attributes of a key of `family` (pure): the algorithm comes from the LIVE definitions; throws with the offered names when it
 * is not offered.
 */
export function keyRequestAttributes(defs: AttributeDefinition[], family: Family, alias: string, sizeOverride?: string | number): JsonObject[] {
    const spec = FAMILIES[family];
    const algorithmDef = defs.find((d) => d.name === SCP_ATTR.keyAlgorithm.name);
    if (!algorithmDef) throw new Error(`create-key definitions carry no ${SCP_ATTR.keyAlgorithm.name} (offered: ${defs.map((d) => d.name).join(', ')})`);
    const option = (algorithmDef.content ?? []).find((c) => String(c.data) === spec.algorithm || String(c.reference) === spec.algorithm);
    if (!option) throw new Error(`algorithm ${spec.algorithm} is not offered (${(algorithmDef.content ?? []).map((c) => String(c.reference ?? c.data)).join(', ')})`);
    const out: JsonObject[] = [
        { name: SCP_ATTR.keyAlias.name, uuid: uuidOf(defs, SCP_ATTR.keyAlias), version: 'v2', contentType: 'string', content: [{ data: alias }] },
        { name: SCP_ATTR.keyAlgorithm.name, uuid: algorithmDef.uuid ?? SCP_ATTR.keyAlgorithm.uuid, version: 'v2', contentType: 'string', content: [option] },
    ];
    const sizeAttr = specAttributeOf(family);
    if (sizeAttr) {
        const data = sizeOverride ?? spec.optionData;
        const reference = sizeOverride === undefined ? spec.option : String(sizeOverride);
        out.push({ name: sizeAttr.name, uuid: uuidOf(defs, sizeAttr), version: 'v2', contentType: sizeAttr.contentType, content: [{ reference, data }] });
    }
    return out;
}

export interface KeyOptions {
    family?: Family;
    enabled?: boolean;
    /** SCP v2 only; refused on a connector without KEY_EXPORT. */
    exportable?: boolean;
    type?: KeyRequestType;
    /** Override the size / curve / level (negative cases). */
    sizeOverride?: string | number;
    name?: string;
    alias?: string;
}

export interface KeyChain {
    connector: CryptoConnector;
    provider: Provider;
    token: OwnRef;
    tokenProfile: OwnRef;
    key: KeyRef;
}

export function keyCreateBody(defs: AttributeDefinition[], name: string, opts: KeyOptions, customAttributes: JsonObject[]): JsonObject {
    const family = opts.family ?? 'rsa-2048';
    return {
        name,
        description: `REG run ${runId()} ${FAMILIES[family].label}`,
        groupUuids: [],
        attributes: keyRequestAttributes(defs, family, opts.alias ?? keyAlias(name), opts.sizeOverride),
        customAttributes,
        enabled: opts.enabled ?? false,
        exportable: opts.exportable ?? false,
    };
}

/**
 * Creates a key pair on an own enabled profile (PRIVATE and PUBLIC items, disabled unless `enabled`), recorded before any assertion;
 * returns the KeyRef with the item uuids.
 */
export async function createOwnKey(api: GuardedApi, spec: string, suffix: string, o: KeyOptions & { chain: Pick<KeyChain, 'token' | 'tokenProfile'> }): Promise<KeyRef & { detail: JsonObject }> {
    const { chain, ...opts } = o;
    const name = opts.name ?? ownName(suffix);
    const defs = await listCreateKeyAttributes(api, chain.token, chain.tokenProfile, opts.type ?? 'keyPair');
    const { name: _name, ...body } = keyCreateBody(defs, name, opts, await requiredCustomAttributes(api, 'keys', runName('ca')));
    const { answer, ...ref } = await createOwn(api, spec, {
        type: 'keys',
        path: `${profileUrl(chain.token, chain.tokenProfile)}/keys/${opts.type ?? 'keyPair'}`,
        name,
        note: `own ${FAMILIES[opts.family ?? 'rsa-2048'].label} key`,
        parents: { token: chain.token.uuid, tokenProfile: chain.tokenProfile.uuid },
        body,
    });
    const created = answer.json as KeyDetail;
    recordKeyItems(created, name, spec);
    return { ...ref, keyItems: keyItemsOf(created), detail: created };
}

/**
 * Records every item of a key detail as a `keyItems` ledger line (parent `key`, the key's run-prefixed name); the teardown treats them as
 * gone with their key.
 */
function recordKeyItems(detail: JsonObject, keyName: string, spec: string): string[] {
    const uuids: string[] = [];
    for (const item of (detail?.items ?? []) as JsonObject[]) {
        if (!item?.uuid) continue;
        recordCreated('keyItems', { uuid: String(item.uuid), name: keyName }, { spec, note: `${String(item.type)} item of key ${String(detail.uuid)}`, parents: { key: String(detail.uuid) } });
        uuids.push(String(item.uuid));
    }
    return uuids;
}

export function keyItemsOf(detail: KeyDetail): { privateUuid?: string; publicUuid?: string } {
    return { privateUuid: itemOf(detail, 'private')?.uuid, publicUuid: itemOf(detail, 'public')?.uuid };
}

export function itemOf(detail: KeyDetail, kind: 'private' | 'public'): KeyItem | undefined {
    const re = kind === 'private' ? /^private/i : /^public/i;
    return (detail?.items ?? []).find((i) => re.test(String(i.type)));
}

export interface KeyItem extends JsonObject {
    uuid?: string;
    type?: string;
    state?: string;
    enabled?: boolean;
    keyAlgorithm?: string;
    length?: number;
    usage?: string[];
}

export interface KeyDetail extends JsonObject {
    uuid?: string;
    name?: string;
    items?: KeyItem[];
}

export const getKey = (api: APIRequestContext, uuid: string): Promise<KeyDetail> => apiJson<KeyDetail>(api, 'GET', `/api/v1/keys/${uuid}`);

export const keyItemHistory = (api: APIRequestContext, keyUuid: string, itemUuid: string): Promise<JsonObject[]> =>
    apiJson<JsonObject[]>(api, 'GET', `/api/v1/keys/${keyUuid}/items/${itemUuid}/history`);

/** The wire codes of `KeyEvent`: a history row's `event` carries the code ('Create Key'), not the enum name; the status travels as the name. */
export const KEY_EVENT = {
    CREATE: 'Create Key', IMPORT: 'Import Key', EXPORT: 'Export Key', EXPORT_DISABLED: 'Disable Key Export', COMPROMISED: 'Compromised Key',
    DESTROY: 'Destroy Key', UPDATE_USAGE: 'Update Key Usages', SIGN: 'Sign Data', VERIFY: 'Verify Data', ENCRYPT: 'Encrypt Data', DECRYPT: 'Decrypt Data',
    ENABLE: 'Enable Key', DISABLE: 'Disable Key',
} as const;
export type KeyEventName = keyof typeof KEY_EVENT;

export const eventsOf = (history: JsonObject[], event: KeyEventName, status?: 'SUCCESS' | 'FAILED'): JsonObject[] =>
    history.filter((h) => String(h.event) === KEY_EVENT[event] && (status === undefined || String(h.status) === status));


async function ownKey(api: GuardedApi, key: OwnRef, helper: string): Promise<void> {
    await assertOwnLive(api, 'keys', key, helper);
}

export async function enableOwnKey(api: GuardedApi, key: OwnRef): Promise<void> {
    await ownKey(api, key, 'keys.enableOwnKey');
    await apiJson(api, 'PATCH', `/api/v1/keys/${key.uuid}/enable`);
}

export async function disableOwnKey(api: GuardedApi, key: OwnRef): Promise<void> {
    await ownKey(api, key, 'keys.disableOwnKey');
    await apiJson(api, 'PATCH', `/api/v1/keys/${key.uuid}/disable`);
}

export type CompromiseReason = 'disclosure' | 'modification' | 'substitution' | 'use_of_sensitive_data';

export async function compromiseOwnKey(api: GuardedApi, key: OwnRef, reason: CompromiseReason = 'disclosure'): Promise<APIResponse> {
    await ownKey(api, key, 'keys.compromiseOwnKey');
    return api.patch(`/api/v1/keys/${key.uuid}/compromise`, { data: { reason } });
}

export async function destroyOwnKey(api: GuardedApi, key: OwnRef): Promise<APIResponse> {
    await ownKey(api, key, 'keys.destroyOwnKey');
    return api.patch(`/api/v1/keys/${key.uuid}/destroy`);
}

/**
 * `PUT /v1/keys/{uuid}/usages` without `uuids` applies the list to every item, so a mixed set is refused with 422; use it only for sets
 * legal on both items (e.g. `[]`). The raw response.
 */
async function updateOwnKeyUsages(api: GuardedApi, key: OwnRef, usages: readonly Usage[]): Promise<APIResponse> {
    await ownKey(api, key, 'keys.updateOwnKeyUsages');
    return api.put(`/api/v1/keys/${key.uuid}/usages`, { data: { usage: [...usages] } });
}

/** The per-item usage update (private: sign / decrypt, public: verify / encrypt). The raw response. */
export function updateOwnKeyItemUsages(api: GuardedApi, itemUuid: string, usages: readonly Usage[]): Promise<APIResponse> {
    // The item is an own `keyItems` line; the guard types the bulk route `keyItems`.
    return api.put('/api/v1/keys/items/usages', { data: { uuids: [itemUuid], usage: [...usages] } });
}

/**
 * Hard delete of an own key inside a test and its `deleted` ledger line; the provider and core slow down past ~14 keys on one token
 * (software-cryptography-provider#137), so specs delete at the end of each test.
 */
export async function deleteOwnKey(api: GuardedApi, key: OwnRef, spec: string): Promise<void> {
    const answer = await deleteOwn(api, 'keys', key, spec, {
        note: 'deleted at the end of the test (key cap per token)',
        alsoAccept: [404],
        readBack: async () => {
            const gone = await pollUntil(
                async () => (await api.get(`/api/v1/keys/${key.uuid}`)).status() === 404,
                (absent) => absent,
                { attempts: 10, timeoutMs: Number.POSITIVE_INFINITY, intervalMs: 1_000, tolerateErrors: 0, onTimeout: 'return' },
            );
            if (!gone) throw new Error(`key ${key.uuid}: the delete was answered but the detail still answers; not deleted`);
        },
    });
    if (!answer.status || (answer.status >= 300 && answer.status !== 404)) throw new Error(`DELETE /v1/keys/${key.uuid} answered ${answer.status} ${answer.text.slice(0, 300)}`);
}
