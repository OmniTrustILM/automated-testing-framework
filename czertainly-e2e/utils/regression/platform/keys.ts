/**
 * keys — the run's own keys on the software cryptography provider and their lifecycle.
 *
 * WHAT: Builds the create-key request from the live definitions, creates own keys and records their items, reads key detail and item history, and enables, disables, compromises, destroys, changes usages of and deletes own keys.
 * WHY: Key creation and lifecycle change for key reasons only, apart from the token form and the item operations.
 * HOW: Creates and key items are recorded right after the create; every change first passes the live own-object check; the run-end teardown removes keys before profiles and tokens.
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

/** `GET /v1/tokens/{t}/tokenProfiles/{p}/keys/{type}/attributes`: the LIVE create-key definitions. */
export function listCreateKeyAttributes(api: APIRequestContext, token: Pick<Ref, 'uuid'>, profile: Pick<Ref, 'uuid'>, type: KeyRequestType = 'keyPair'): Promise<AttributeDefinition[]> {
    return apiJson<AttributeDefinition[]>(api, 'GET', `${profileUrl(token, profile)}/keys/${type}/attributes`);
}

/** The provider-side key alias: unique within the token (`data_keyAlias`), same alphabet as the token alias. */
export const keyAlias = (name: string): string => tokenAlias(name);

/**
 * The request attributes of a key of `family` (pure): the algorithm option is taken from the LIVE definition list
 * (by code or label); the size / curve / level attribute is the SCP child attribute of `group_keySpecV2` (sent as a
 * data attribute with the SCP uuid). Throws with the offered names when the algorithm is not offered: the matrix
 * asserts absence through `cryptoAlgorithmCases.algorithmListProblems`, a create never guesses.
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
    /** Request `enabled` (core default false). */
    enabled?: boolean;
    /** Request `exportable` (SCP v2 only; refused on a connector without KEY_EXPORT). */
    exportable?: boolean;
    type?: KeyRequestType;
    /** Override the size / curve / level content (the negative cases: RSA 2047, an unknown curve, …). */
    sizeOverride?: string | number;
    /** Override the ILM key name (duplicate-name negative). */
    name?: string;
    /** Override the provider alias (case-only duplicate negative). */
    alias?: string;
}

export interface KeyChain {
    connector: CryptoConnector;
    provider: Provider;
    token: OwnRef;
    tokenProfile: OwnRef;
    key: KeyRef;
}

/** The request body of a key create (pure, for the wire unit test). */
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
 * `POST /v1/tokens/{t}/tokenProfiles/{p}/keys/keyPair` on an own enabled profile: a PRIVATE and a PUBLIC item, both
 * ACTIVE and disabled unless `enabled`. Recorded as `keys` (parents `token`, `tokenProfile`) before any
 * assertion; returns the KeyRef with the item uuids.
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
 * Every item of a key detail as a `keyItems` ledger line: parent `key`, the KEY's
 * run-prefixed name (`KeyItemDetailDto extends NameAndUuidDto`: the live read `GET /v1/keys/{key}/items/{item}` answers it).
 * The item routes (sign / verify / encrypt / decrypt, export, `PUT /v1/keys/items/usages`) are typed by these lines; the
 * teardown treats them as gone with their key (`goneWith`). Idempotent per uuid within the ledger of this process.
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

/** The private / public item uuids of a key detail. */
export function keyItemsOf(detail: KeyDetail): { privateUuid?: string; publicUuid?: string } {
    return { privateUuid: itemOf(detail, 'private')?.uuid, publicUuid: itemOf(detail, 'public')?.uuid };
}

/** The item of a key detail by kind (`type` code `Private…` / `Public…`, any case). */
export function itemOf(detail: KeyDetail, kind: 'private' | 'public'): KeyItem | undefined {
    const re = kind === 'private' ? /^private/i : /^public/i;
    return (detail?.items ?? []).find((i) => re.test(String(i.type)));
}

/** A key item of a key detail (`items[]`): the fields the tests read. */
export interface KeyItem extends JsonObject {
    uuid?: string;
    type?: string;
    state?: string;
    enabled?: boolean;
    keyAlgorithm?: string;
    length?: number;
    usage?: string[];
}

/** A key detail (`GET /v1/keys/{uuid}`) with its items. */
export interface KeyDetail extends JsonObject {
    uuid?: string;
    name?: string;
    items?: KeyItem[];
}

export const getKey = (api: APIRequestContext, uuid: string): Promise<KeyDetail> => apiJson<KeyDetail>(api, 'GET', `/api/v1/keys/${uuid}`);

/** `GET /v1/keys/{k}/items/{i}/history` (newest first on the wire; callers sort by `created` when they need order). */
export const keyItemHistory = (api: APIRequestContext, keyUuid: string, itemUuid: string): Promise<JsonObject[]> =>
    apiJson<JsonObject[]>(api, 'GET', `/api/v1/keys/${keyUuid}/items/${itemUuid}/history`);

/**
 * The wire codes of `KeyEvent` (the `@JsonValue` of the interfaces' `KeyEvent`): the `event` field of a
 * history row carries the CODE ('Create Key'), never the Java enum name. `KeyEventStatus` has no code:
 * `SUCCESS` / `FAILED` travel as the names.
 */
export const KEY_EVENT = {
    CREATE: 'Create Key', IMPORT: 'Import Key', EXPORT: 'Export Key', EXPORT_DISABLED: 'Disable Key Export', COMPROMISED: 'Compromised Key',
    DESTROY: 'Destroy Key', UPDATE_USAGE: 'Update Key Usages', SIGN: 'Sign Data', VERIFY: 'Verify Data', ENCRYPT: 'Encrypt Data', DECRYPT: 'Decrypt Data',
    ENABLE: 'Enable Key', DISABLE: 'Disable Key',
} as const;
export type KeyEventName = keyof typeof KEY_EVENT;

/** The events of a history of one kind (by the KeyEvent NAME, matched on the wire code), optionally by status (`SUCCESS` / `FAILED`). */
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

/** `PATCH /v1/keys/{uuid}/compromise {reason}` on an own key; returns the raw response (a second compromise is 422). */
export async function compromiseOwnKey(api: GuardedApi, key: OwnRef, reason: CompromiseReason = 'disclosure'): Promise<APIResponse> {
    await ownKey(api, key, 'keys.compromiseOwnKey');
    return api.patch(`/api/v1/keys/${key.uuid}/compromise`, { data: { reason } });
}

/** `PATCH /v1/keys/{uuid}/destroy` (no body: every item) on an own key; the raw response (422 from ACTIVE). */
export async function destroyOwnKey(api: GuardedApi, key: OwnRef): Promise<APIResponse> {
    await ownKey(api, key, 'keys.destroyOwnKey');
    return api.patch(`/api/v1/keys/${key.uuid}/destroy`);
}

/**
 * `PUT /v1/keys/{uuid}/usages {usage}` on an own key WITHOUT `uuids`: core applies the list to EVERY item, and the per-item
 * type rule (CryptographyUtil: a public item never SIGN / DECRYPT, a private one never VERIFY / ENCRYPT) refuses any mixed set
 * with 422 "Usages of some key items could not be updated …" — use it only for a set legal on both items (e.g. `[]`).
 * Per-item updates go through `updateOwnKeyItemUsages`. The raw response.
 */
async function updateOwnKeyUsages(api: GuardedApi, key: OwnRef, usages: readonly Usage[]): Promise<APIResponse> {
    await ownKey(api, key, 'keys.updateOwnKeyUsages');
    return api.put(`/api/v1/keys/${key.uuid}/usages`, { data: { usage: [...usages] } });
}

/**
 * `PUT /v1/keys/items/usages { uuids: [item], usage }` — the per-item usage update (CryptographicKeyWriter.updateUsage):
 * private item sign / decrypt, public item verify / encrypt. The raw response.
 */
export function updateOwnKeyItemUsages(api: GuardedApi, itemUuid: string, usages: readonly Usage[]): Promise<APIResponse> {
    // The item is an own `keyItems` line (recorded by createOwnKey); the guard types the bulk route `keyItems`.
    return api.put('/api/v1/keys/items/usages', { data: { uuids: [itemUuid], usage: [...usages] } });
}

/**
 * Hard delete of an OWN key inside a test (`DELETE /v1/keys/{uuid}`: remote destroy first, no state guard) and its
 * `deleted` ledger line: the software provider and core slow down and refuse past ~14 keys on one token (software-cryptography-provider#137), so a spec
 * that makes several keys deletes them at the end of each test. Absence is proven by the detail 404 (polled).
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
