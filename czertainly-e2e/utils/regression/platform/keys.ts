/**
 * keys — the run's own keys on the software cryptography provider: create, read, change and delete; creates are recorded right after the
 * call and every change passes the live own-object check.
 */

import type { APIRequestContext, APIResponse } from '@playwright/test';
import { AttributeDefinition, Family, FAMILIES, Provider, SCP_ATTR, Usage } from './cryptoAlgorithmCases';
import type { GuardedApi } from '../guard/types';
import { assertOwnLive } from '../ledger/ownership';
import { apiJson, apiJsonWithDate } from '../apiReads';
import { requestVersion } from '../attributeVersion';
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

/** The key-spec group whose fields the provider answers once the algorithm is chosen (v2: `group_keySpecV2`). */
const algorithmDependentGroup = (defs: AttributeDefinition[]): AttributeDefinition | undefined =>
    defs.find((d) => d.type === 'group' && ((d.attributeCallback as { dependsOn?: string[] } | undefined)?.dependsOn ?? []).includes(SCP_ATTR.keyAlgorithm.name));

/** The create-key definitions plus the key-spec fields the group callback answers for `family`'s algorithm (core#2837). */
export async function listKeyCreateDefinitions(api: GuardedApi, token: Pick<Ref, 'uuid'>, profile: Pick<Ref, 'uuid'>, family: Family): Promise<AttributeDefinition[]> {
    const defs = await listCreateKeyAttributes(api, token, profile);
    const group = algorithmDependentGroup(defs);
    if (!group) return defs;
    const algorithm = keyRequestAttributes(defs, family, '').find((a) => a.name === SCP_ATTR.keyAlgorithm.name);
    const fields = await apiJson<AttributeDefinition[]>(api, 'POST', `/api/v1/keys/${profile.uuid}/callback`, { uuid: group.uuid, name: group.name, attributes: [algorithm] });
    return [...defs, ...(fields ?? [])];
}

/**
 * The request attributes of a key of `family` (pure): the algorithm comes from the LIVE definitions; throws with the offered names when it
 * is not offered. Each spec field takes the live option of its reference when the definitions carry it, else the family's own value;
 * `sizeOverride` replaces the first one (negative cases).
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
    spec.spec.forEach((choice, i) => {
        const attr = SCP_ATTR[choice.attribute];
        const def = defs.find((d) => d.name === attr.name);
        const override = i === 0 ? sizeOverride : undefined;
        const live = override === undefined ? (def?.content ?? []).find((c) => String(c.reference) === choice.reference) : undefined;
        const content = live ?? (override === undefined ? { reference: choice.reference, data: choice.data } : { reference: String(override), data: override });
        out.push({ name: attr.name, uuid: def?.uuid ?? attr.uuid, version: requestVersion(def), contentType: def?.contentType ?? choice.contentType, content: [content] });
    });
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
    const defs = opts.type === 'secret'
        ? await listCreateKeyAttributes(api, chain.token, chain.tokenProfile, 'secret')
        : await listKeyCreateDefinitions(api, chain.token, chain.tokenProfile, opts.family ?? 'rsa-2048');
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
export function recordKeyItems(detail: JsonObject, keyName: string, spec: string): string[] {
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

/** A destroyed key whose delete core refuses (core#2455) is left to the run-end teardown; any other failure throws after every key. */
export async function deleteEachKey(keys: readonly OwnRef[], o: {
    remove: (key: OwnRef) => Promise<void>;
    isDestroyed: (key: OwnRef) => Promise<boolean>;
    warn: (text: string) => void;
}): Promise<void> {
    const failures: string[] = [];
    for (const key of keys) {
        try {
            await o.remove(key);
        } catch (e) {
            if (await o.isDestroyed(key).catch(() => false)) o.warn(`key ${key.uuid} was destroyed by the test and its delete was refused (core#2455); left on the ledger for the run-end teardown`);
            else failures.push(String(e instanceof Error ? e.message : e));
        }
    }
    if (failures.length) throw new Error(`the delete of ${failures.length} own key(s) failed: ${failures.join(' | ')}`);
}

/** True when every item of the key is in a destroyed state (a read only). */
export async function isDestroyedKey(api: GuardedApi, key: OwnRef): Promise<boolean> {
    const items = (await getKey(api, key.uuid)).items ?? [];
    return items.length > 0 && items.every((i) => /^destroyed/i.test(String(i.state)));
}

interface NamedKey {
    uuid: string;
}

/** Every key whose item rows are named `name` (`<key> private key`; a v1 item carries the alias), created after `since` on the server clock. */
export async function liveKeysNamed(api: GuardedApi, name: string, since?: number): Promise<NamedKey[]> {
    const found = new Map<string, NamedKey>();
    for (let pageNumber = 1; pageNumber <= 50; pageNumber++) {
        const page = await apiJsonWithDate(api, 'POST', '/api/v1/keys', { itemsPerPage: 1000, pageNumber, filters: [] });
        const skew = page.serverAt ? page.serverAt.getTime() - (page.startedAt.getTime() + page.elapsedMs) : 0;
        for (const row of (page.json?.cryptographicKeys ?? []) as JsonObject[]) {
            const rowName = String(row.name ?? '');
            if (rowName !== name && !rowName.startsWith(`${name} `)) continue;
            const created = Date.parse(String(row.creationTime ?? ''));
            // Without the server clock the window is not judged: the name is unique to this run.
            if (since !== undefined && page.serverAt && !Number.isNaN(created) && created < since + skew - 2_000) continue;
            const uuid = String(row.keyWrapperUuid ?? row.uuid);
            found.set(uuid, { uuid });
        }
        if (pageNumber >= Number(page.json?.totalPages ?? 1)) break;
    }
    return [...found.values()];
}

/** Why a row that destroys a key runs on a local stack only: core refuses to delete a destroyed v2 key (core#2455). */
export const DESTROYED_KEY_STAYS = 'core#2455: a destroyed key on a v2 token cannot be deleted and would stay on the shared tier; the row runs on a local stack';
