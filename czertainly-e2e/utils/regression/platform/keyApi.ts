/**
 * keyApi — the run's own tokens, token profiles and keys on the software cryptography provider, their lifecycle
 * (enable, disable, compromise, destroy, usages) and the item operations (sign, verify, encrypt, decrypt, export,
 * import). Every mutation takes a `GuardedApi`; creates and key items are recorded right after the create; nothing here
 * deletes in bulk (the run-end teardown removes own keys before profiles and tokens).
 */
import type { APIRequestContext, APIResponse } from '@playwright/test';
import { Logger } from '../../Logger';
import { connectorVersion, listConnectors } from './connectorApi';
import { AttributeDefinition, AttributeOption, Family, FAMILIES, PROFILE_USAGES, Provider, SCP_ATTR, SignVariant, specAttributeOf, Usage, pickSignatureOption } from './cryptoAlgorithmCases';
import type { GuardedApi } from '../guard/types';
import { assertOwnLive } from '../ledger/ownership';
import { apiJson } from '../apiReads';
import { requiredCustomAttributes } from '../customAttributes';
import { pollUntil } from '../wait';
import { KeyRef, OwnRef, recordCreated, recordDeleted, Ref } from '../ledger/ledger';
import { readRunState, runName, runId, updateRunState } from '../ledger/runState';
import { isJsonObject, JsonObject } from '../json';

const logger = new Logger('KeyApi');

// ------------------------------------------------------------------ the cryptography connector of the run

export interface CryptoConnector {
    uuid: string;
    name: string;
    version: 1 | 2;
}

/** The registration name the suite looks for first (`REG_CRYPTO_CONNECTOR_V2` / `_V1` override; chart defaults). */
export const DEFAULT_CRYPTO_CONNECTOR: Readonly<Record<1 | 2, string>> = { 2: 'Software-Cryptography-Provider-v2', 1: 'Software-Cryptography-Provider' };

/**
 * The software cryptography connector of the wanted interface version: the connector named by the environment (or
 * the chart default), else the first `connected` connector whose function groups include `cryptographyProvider` and
 * whose v2 detail reports that version. Undefined when the tier has none (the caller skips with a named reason).
 */
export async function findCryptoConnector(api: APIRequestContext, version: 1 | 2 = 2, env: NodeJS.ProcessEnv = process.env): Promise<CryptoConnector | undefined> {
    const wanted = env[`REG_CRYPTO_CONNECTOR_V${version}`] || DEFAULT_CRYPTO_CONNECTOR[version];
    const rows = await apiJson<JsonObject[]>(api, 'GET', '/api/v1/connectors');
    const candidates = [
        ...rows.filter((r) => r.name === wanted),
        ...rows.filter((r) => r.name !== wanted && r.status === 'connected'
            && ((r.functionGroups ?? []) as JsonObject[]).some((g) => g.functionGroupCode === 'cryptographyProvider' || g.code === 'cryptographyProvider')),
    ];
    for (const c of candidates) {
        const v = await connectorVersion(api, String(c.uuid));
        if (v.version === version) return { uuid: String(c.uuid), name: String(c.name), version };
    }
    return undefined;
}

/** `scp-v2` / `scp-v1` for the matrix tables. */
export const providerOf = (connector: CryptoConnector): Provider => (connector.version === 2 ? 'scp-v2' : 'scp-v1');

// ------------------------------------------------------------------ tokens

/** The provider-side token name derived from the ILM name: a letter first, then letters, digits and single underscores. */
export function tokenAlias(name: string): string {
    const body = name.replace(/[^A-Za-z0-9]+/g, '_').replace(/^_+|_+$/g, '');
    return /^[A-Za-z]/.test(body) ? body : `t_${body}`;
}

/** `GET /v1/tokens/{connectorUuid}/attributes[?kind=]` (the token form schema of the connector; a v2 record takes no kind). */
export async function listTokenAttributes(api: APIRequestContext, connector: CryptoConnector, kind?: string): Promise<AttributeDefinition[]> {
    const q = kind ? `?kind=${encodeURIComponent(kind)}` : '';
    return apiJson<AttributeDefinition[]>(api, 'GET', `/api/v1/tokens/${connector.uuid}/attributes${q}`);
}

const uuidOf = (defs: AttributeDefinition[], attr: { name: string; uuid: string }): string => defs.find((d) => d.name === attr.name)?.uuid ?? attr.uuid;

/**
 * The request attributes of a NEW software token (`data_createTokenAction` = new, the provider-side name, the
 * activation code; plus `data_options` = new when the provider already holds tokens and asks "new or existing").
 * Pure: the live definition list decides whether `data_options` is sent.
 */
export function tokenRequestAttributes(defs: AttributeDefinition[], alias: string, code: string): JsonObject[] {
    const out: JsonObject[] = [];
    if (defs.some((d) => d.name === SCP_ATTR.tokenOptions.name)) {
        out.push({ name: SCP_ATTR.tokenOptions.name, uuid: uuidOf(defs, SCP_ATTR.tokenOptions), version: 'v2', contentType: 'string', content: [{ reference: 'Create new Token', data: 'new' }] });
    }
    out.push(
        { name: SCP_ATTR.createTokenAction.name, uuid: uuidOf(defs, SCP_ATTR.createTokenAction), version: 'v2', contentType: 'string', content: [{ reference: 'new', data: 'new' }] },
        { name: SCP_ATTR.newTokenName.name, uuid: uuidOf(defs, SCP_ATTR.newTokenName), version: 'v2', contentType: 'string', content: [{ data: alias }] },
        { name: SCP_ATTR.tokenCode.name, uuid: uuidOf(defs, SCP_ATTR.tokenCode), version: 'v2', contentType: 'secret', content: [{ data: { secret: code } }] },
    );
    return out;
}

/** A throw-away activation code (never logged; the provider needs one even on v2 where no activation step exists). */
export const activationCode = (): string => `Qa${runId().replace(/[^0-9a-z]/g, '')}${Date.now().toString(36)}`;

export interface TokenOptions {
    /** `SOFT` on a v1 record; omitted on a v2 record (the v2 request carries no kind). */
    kind?: string;
}

/**
 * `POST /v1/tokens` for an own token on the connector (recorded as `tokens` before anything else). The v2 request
 * carries `name`, `connectorUuid` and the connector attributes and no `kind` (API-KEY-01).
 */
export async function createOwnToken(api: GuardedApi, connector: CryptoConnector, suffix: string, spec: string, opts: TokenOptions = {}): Promise<OwnRef> {
    const name = runName(suffix);
    const defs = await listTokenAttributes(api, connector, opts.kind);
    const body: JsonObject = {
        name,
        description: `REG run ${runId()}`,
        connectorUuid: connector.uuid,
        ...(opts.kind ? { kind: opts.kind } : {}),
        attributes: tokenRequestAttributes(defs, tokenAlias(name), activationCode()),
        customAttributes: await requiredCustomAttributes(api, 'tokens', runName('ca')),
    };
    const created = await apiJson<JsonObject>(api, 'POST', '/api/v1/tokens', body);
    const ref = recordCreated('tokens', { uuid: String(created.uuid), name }, spec, `own token on ${connector.name}`);
    logger.info(`token ${name} created on ${connector.name}`);
    return ref;
}

/** `GET /v1/tokens/{uuid}` (a side-effect GET: it persists the connector-reported status — own tokens only). */
export const getOwnToken = (api: APIRequestContext, token: OwnRef): Promise<JsonObject> => apiJson<JsonObject>(api, 'GET', `/api/v1/tokens/${token.uuid}`);

/** `PATCH /v1/tokens/{uuid}`: reload the status from the connector (own token). */
export async function reloadOwnToken(api: GuardedApi, token: OwnRef): Promise<JsonObject> {
    await assertOwnLive(api, 'tokens', token, 'keyApi.reloadOwnToken');
    return apiJson<JsonObject>(api, 'PATCH', `/api/v1/tokens/${token.uuid}`);
}

export const V2_TOKEN_STATUSES: readonly string[] = ['Connected', 'Disconnected', 'Warning', 'Unknown'];
export const V1_ONLY_TOKEN_STATUSES: readonly string[] = ['Activated', 'Deactivated'];

/** The status code of a token detail (`status.status`), e.g. `Connected`. */
export function tokenStatusOf(detail: JsonObject): string | undefined {
    const status = detail?.status;
    const code = isJsonObject(status) ? status.status : status;
    return typeof code === 'string' ? code : undefined;
}

// ------------------------------------------------------------------ token profiles

export interface ProfileOptions {
    usages?: readonly Usage[];
    enabled?: boolean;
    description?: string;
}

/** `POST /v1/tokens/{token}/tokenProfiles` (own token, recorded as `tokenProfiles` with parent `token`). */
export async function createOwnTokenProfile(api: GuardedApi, token: OwnRef, suffix: string, spec: string, opts: ProfileOptions = {}): Promise<OwnRef> {
    const name = runName(suffix);
    const created = await apiJson<JsonObject>(api, 'POST', `/api/v1/tokens/${token.uuid}/tokenProfiles`, {
        name,
        description: opts.description ?? `REG run ${runId()}`,
        attributes: [],
        customAttributes: await requiredCustomAttributes(api, 'tokenProfiles', runName('ca')),
        enabled: opts.enabled ?? false,
        usage: [...(opts.usages ?? PROFILE_USAGES)],
    });
    return recordCreated('tokenProfiles', { uuid: String(created.uuid), name }, spec, 'own token profile', { token: token.uuid });
}

export const profileUrl = (token: Pick<Ref, 'uuid'>, profile: Pick<Ref, 'uuid'>): string => `/api/v1/tokens/${token.uuid}/tokenProfiles/${profile.uuid}`;

/** A token profile detail: the fields the tests read. */
export interface TokenProfileDetail extends JsonObject {
    enabled?: boolean;
    usages?: string[];
}

export const getTokenProfile = (api: APIRequestContext, token: Pick<Ref, 'uuid'>, profile: Pick<Ref, 'uuid'>): Promise<TokenProfileDetail> =>
    apiJson<TokenProfileDetail>(api, 'GET', profileUrl(token, profile));

/** `PATCH …/enable` on an own profile (idempotent). */
export async function enableOwnTokenProfile(api: GuardedApi, token: OwnRef, profile: OwnRef): Promise<void> {
    await assertOwnLive(api, 'tokenProfiles', profile, 'keyApi.enableOwnTokenProfile');
    await apiJson(api, 'PATCH', `${profileUrl(token, profile)}/enable`);
}

export async function disableOwnTokenProfile(api: GuardedApi, token: OwnRef, profile: OwnRef): Promise<void> {
    await assertOwnLive(api, 'tokenProfiles', profile, 'keyApi.disableOwnTokenProfile');
    await apiJson(api, 'PATCH', `${profileUrl(token, profile)}/disable`);
}

/** `PUT …/usages` on an own profile (JSONB round trip). */
export async function updateOwnTokenProfileUsages(api: GuardedApi, token: OwnRef, profile: OwnRef, usages: readonly Usage[]): Promise<void> {
    await assertOwnLive(api, 'tokenProfiles', profile, 'keyApi.updateOwnTokenProfileUsages');
    await apiJson(api, 'PUT', `${profileUrl(token, profile)}/usages`, { usage: [...usages] });
}

// ------------------------------------------------------------------ keys

export type KeyRequestType = 'keyPair' | 'secret';

/** `GET /v1/tokens/{t}/tokenProfiles/{p}/keys/{type}/attributes`: the LIVE create-key definitions (API-KEY-09). */
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
    /** Override the size / curve / level content (the negatives of API-KEY-11: RSA 2047, an unknown curve, …). */
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
export async function createOwnKey(api: GuardedApi, chain: Pick<KeyChain, 'token' | 'tokenProfile'>, suffix: string, spec: string, opts: KeyOptions = {}): Promise<KeyRef & { detail: JsonObject }> {
    const name = opts.name ?? runName(suffix);
    const defs = await listCreateKeyAttributes(api, chain.token, chain.tokenProfile, opts.type ?? 'keyPair');
    const body = keyCreateBody(defs, name, opts, await requiredCustomAttributes(api, 'keys', runName('ca')));
    const created = await apiJson<KeyDetail>(api, 'POST', `${profileUrl(chain.token, chain.tokenProfile)}/keys/${opts.type ?? 'keyPair'}`, body);
    const ref = recordCreated('keys', { uuid: String(created.uuid), name }, spec, `own ${FAMILIES[opts.family ?? 'rsa-2048'].label} key`, { token: chain.token.uuid, tokenProfile: chain.tokenProfile.uuid });
    recordKeyItems(created, name, spec);
    return { ...ref, keyItems: keyItemsOf(created), detail: created };
}

/**
 * Every item of a key detail as a `keyItems` ledger line: parent `key`, the KEY's
 * run-prefixed name (`KeyItemDetailDto extends NameAndUuidDto`: the live read `GET /v1/keys/{key}/items/{item}` answers it).
 * The item routes (sign / verify / encrypt / decrypt, export, `PUT /v1/keys/items/usages`) are typed by these lines; the
 * teardown treats them as gone with their key (`goneWith`). Idempotent per uuid within the ledger of this process.
 */
export function recordKeyItems(detail: JsonObject, keyName: string, spec: string): string[] {
    const uuids: string[] = [];
    for (const item of (detail?.items ?? []) as JsonObject[]) {
        if (!item?.uuid) continue;
        recordCreated('keyItems', { uuid: String(item.uuid), name: keyName }, spec, `${String(item.type)} item of key ${String(detail.uuid)}`, { key: String(detail.uuid) });
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

// ------------------------------------------------------------------ lifecycle on the whole key

async function ownKey(api: GuardedApi, key: OwnRef, helper: string): Promise<void> {
    await assertOwnLive(api, 'keys', key, helper);
}

export async function enableOwnKey(api: GuardedApi, key: OwnRef): Promise<void> {
    await ownKey(api, key, 'keyApi.enableOwnKey');
    await apiJson(api, 'PATCH', `/api/v1/keys/${key.uuid}/enable`);
}

export async function disableOwnKey(api: GuardedApi, key: OwnRef): Promise<void> {
    await ownKey(api, key, 'keyApi.disableOwnKey');
    await apiJson(api, 'PATCH', `/api/v1/keys/${key.uuid}/disable`);
}

export type CompromiseReason = 'disclosure' | 'modification' | 'substitution' | 'use_of_sensitive_data';

/** `PATCH /v1/keys/{uuid}/compromise {reason}` on an own key; returns the raw response (a second compromise is 422). */
export async function compromiseOwnKey(api: GuardedApi, key: OwnRef, reason: CompromiseReason = 'disclosure'): Promise<APIResponse> {
    await ownKey(api, key, 'keyApi.compromiseOwnKey');
    return api.patch(`/api/v1/keys/${key.uuid}/compromise`, { data: { reason } });
}

/** `PATCH /v1/keys/{uuid}/destroy` (no body: every item) on an own key; the raw response (422 from ACTIVE). */
export async function destroyOwnKey(api: GuardedApi, key: OwnRef): Promise<APIResponse> {
    await ownKey(api, key, 'keyApi.destroyOwnKey');
    return api.patch(`/api/v1/keys/${key.uuid}/destroy`);
}

/**
 * `PUT /v1/keys/{uuid}/usages {usage}` on an own key WITHOUT `uuids`: core applies the list to EVERY item, and the per-item
 * type rule (CryptographyUtil: a public item never SIGN / DECRYPT, a private one never VERIFY / ENCRYPT) refuses any mixed set
 * with 422 "Usages of some key items could not be updated …" — use it only for a set legal on both items (e.g. `[]`).
 * Per-item updates go through `updateOwnKeyItemUsages`. The raw response.
 */
export async function updateOwnKeyUsages(api: GuardedApi, key: OwnRef, usages: readonly Usage[]): Promise<APIResponse> {
    await ownKey(api, key, 'keyApi.updateOwnKeyUsages');
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
    await ownKey(api, key, 'keyApi.deleteOwnKey');
    const res = await api.delete(`/api/v1/keys/${key.uuid}`);
    if (!res.ok() && res.status() !== 404) throw new Error(`DELETE /v1/keys/${key.uuid} answered ${res.status()} ${(await res.text()).slice(0, 300)}`);
    const gone = await pollUntil(
        async () => (await api.get(`/api/v1/keys/${key.uuid}`)).status() === 404,
        (absent) => absent,
        { attempts: 10, timeoutMs: Number.POSITIVE_INFINITY, intervalMs: 1_000, tolerateErrors: 0, onTimeout: 'return' },
    );
    if (gone) {
        recordDeleted('keys', key, spec, 'deleted at the end of the test (key cap per token)');
        return;
    }
    throw new Error(`key ${key.uuid}: the delete was answered but the detail still answers; not deleted`);
}

// ------------------------------------------------------------------ item operations (guard request pending)

export interface ItemRef {
    tokenUuid: string;
    tokenProfileUuid: string;
    keyUuid: string;
    itemUuid: string;
}

export const operationUrl = (item: ItemRef, op: 'sign' | 'verify' | 'encrypt' | 'decrypt'): string =>
    `/api/v1/operations/tokens/${item.tokenUuid}/tokenProfiles/${item.tokenProfileUuid}/keys/${item.keyUuid}/items/${item.itemUuid}/${op}`;

/** The private (sign / decrypt) or public (verify / encrypt) item of a chain's key as an ItemRef. */
export function itemRef(chain: KeyChain, kind: 'private' | 'public', key: KeyRef = chain.key): ItemRef {
    const itemUuid = kind === 'private' ? key.keyItems?.privateUuid : key.keyItems?.publicUuid;
    if (!itemUuid) throw new Error(`key ${key.uuid} has no ${kind} item uuid`);
    return { tokenUuid: chain.token.uuid, tokenProfileUuid: chain.tokenProfile.uuid, keyUuid: key.uuid, itemUuid };
}

/** `GET …/sign/attributes` (the v2 `signatureAlgorithm` option list, API-KEY-15). */
export const listSignAttributes = (api: APIRequestContext, item: ItemRef): Promise<AttributeDefinition[]> =>
    apiJson<AttributeDefinition[]>(api, 'GET', `${operationUrl(item, 'sign')}/attributes`);

export const listEncryptAttributes = (api: APIRequestContext, item: ItemRef): Promise<AttributeDefinition[]> =>
    apiJson<AttributeDefinition[]>(api, 'GET', `${operationUrl(item, 'encrypt')}/attributes`);

/** The signature attribute(s) of a variant from the live sign definitions (undefined when not offered). */
export function signatureAttributesFor(defs: AttributeDefinition[], variant: SignVariant): JsonObject[] | undefined {
    const def = defs.find((d) => /signatureAlgorithm/i.test(d.name)) ?? defs[0];
    if (!def) return [];
    const option = pickSignatureOption((def.content ?? []) as AttributeOption[], variant);
    if (!option) return undefined;
    return [{ name: def.name, uuid: def.uuid, version: 'v2', contentType: def.contentType ?? 'string', content: [option] }];
}

/** `POST …/sign` on the PRIVATE item: `{ signatureAttributes, data: [{ data: <base64> }] }`; the raw response. */
export function signWithItem(api: GuardedApi, item: ItemRef, dataBase64: string, signatureAttributes: JsonObject[]): Promise<APIResponse> {
    return api.post(operationUrl(item, 'sign'), { data: { signatureAttributes, data: [{ data: dataBase64 }] } });
}

/** `POST …/verify` on the PUBLIC item: `{ signatureAttributes, signatures: [{ data }], data: [{ data }] }`; the raw response. */
export function verifyWithItem(api: GuardedApi, item: ItemRef, dataBase64: string, signatureBase64: string, signatureAttributes: JsonObject[]): Promise<APIResponse> {
    return api.post(operationUrl(item, 'verify'), { data: { signatureAttributes, signatures: [{ data: signatureBase64 }], data: [{ data: dataBase64 }] } });
}

/** `POST …/encrypt` on the PUBLIC item / `…/decrypt` on the PRIVATE item: `{ cipherAttributes, cipherData: [{ data }] }`. */
export function cipherWithItem(api: GuardedApi, item: ItemRef, op: 'encrypt' | 'decrypt', dataBase64: string, cipherAttributes: JsonObject[]): Promise<APIResponse> {
    return api.post(operationUrl(item, op), { data: { cipherAttributes, cipherData: [{ data: dataBase64 }] } });
}

/** The first entry of a response list when it is an object (`signatures[0]`, `verifications[0]`, …). */
const firstOf = (list: unknown): JsonObject | undefined => (Array.isArray(list) && isJsonObject(list[0]) ? list[0] : undefined);
const stringOrUndefined = (value: unknown): string | undefined => (typeof value === 'string' ? value : undefined);

/** The first signature (base64) of a sign response, or undefined. */
export const signatureOf = (body: JsonObject): string | undefined => stringOrUndefined(firstOf(body?.signatures)?.data);
/** The first verification result of a verify response. */
export function verificationOf(body: JsonObject): boolean | undefined {
    const result = firstOf(body?.verifications)?.result;
    return typeof result === 'boolean' ? result : undefined;
}
/** The first cipher output of an encrypt / decrypt response. */
export const cipherOutputOf = (body: JsonObject): string | undefined => stringOrUndefined(firstOf(body?.encryptedData ?? body?.decryptedData)?.data);

/** `POST /v1/keys/{k}/items/{i}/export { passphrase }`: 200 `application/octet-stream`; the raw response. */
export function exportKeyItem(api: GuardedApi, keyUuid: string, itemUuid: string, passphrase: string): Promise<APIResponse> {
    return api.post(`/api/v1/keys/${keyUuid}/items/${itemUuid}/export`, { data: { passphrase, exportAttributes: [] } });
}

/** `PATCH /v1/keys/{k}/items/{i}/export/disable` (EXPORT_DISABLED). */
export function disableKeyItemExport(api: GuardedApi, keyUuid: string, itemUuid: string): Promise<APIResponse> {
    return api.patch(`/api/v1/keys/${keyUuid}/items/${itemUuid}/export/disable`);
}

export interface ImportRequest {
    name: string;
    /** The PEM / DER material as the import attributes expect it (read the live `…/import/attributes` first). */
    importAttributes: JsonObject[];
    inputPassphrase?: string;
    exportable?: boolean;
}

/** `GET …/keys/{type}/import/attributes` (SCP v2 only; a v1 or PKCS#11 profile refuses the import). */
export const listImportKeyAttributes = (api: APIRequestContext, chain: Pick<KeyChain, 'token' | 'tokenProfile'>, type: KeyRequestType = 'keyPair'): Promise<AttributeDefinition[]> =>
    apiJson<AttributeDefinition[]>(api, 'GET', `${profileUrl(chain.token, chain.tokenProfile)}/keys/${type}/import/attributes`);

/** `POST …/keys/{type}/import` into an own profile (own path targets; the material travels in `importAttributes`); the raw response. */
export function importKey(api: GuardedApi, chain: Pick<KeyChain, 'token' | 'tokenProfile'>, req: ImportRequest, type: KeyRequestType = 'keyPair'): Promise<APIResponse> {
    return api.post(`${profileUrl(chain.token, chain.tokenProfile)}/keys/${type}/import`, {
        data: {
            name: req.name,
            description: `REG run ${runId()} import`,
            ...(req.inputPassphrase ? { inputPassphrase: req.inputPassphrase } : {}),
            exportable: req.exportable ?? false,
            importAttributes: req.importAttributes,
            customAttributes: [],
            groupUuids: [],
        },
    });
}

// ------------------------------------------------------------------ ensure:key-chain (Appendix A)

export interface ChainOptions {
    family?: Family;
    suffix?: string;
    /** Interface version of the token (2 default; 1 when asked). */
    version?: 1 | 2;
    usages?: readonly Usage[];
    /** Enable the key right after creation (the chain's default key is ACTIVE + enabled, Appendix A). */
    enableKey?: boolean;
}

/**
 * The run's token → enabled profile → key (own objects, recorded; idempotent per run through RunState `token`,
 * `tokenProfile`, `key`; a second call with another family or suffix adds one more key on the same token and profile).
 * Returns undefined (no throw) when the tier has no cryptography connector of the version: the caller skips.
 */
export async function ensureKeyChain(api: GuardedApi, spec: string, opts: ChainOptions = {}): Promise<KeyChain | { skip: string }> {
    const version = opts.version ?? 2;
    const connector = await findCryptoConnector(api, version);
    if (!connector) return { skip: `no connected software cryptography connector of interface v${version} is registered on this tier (REG_CRYPTO_CONNECTOR_V${version})` };
    const state = readRunState();
    let token = state.token;
    let tokenProfile = state.tokenProfile;
    if (!token || !tokenProfile) {
        token = await createOwnToken(api, connector, `tok-${Date.now().toString(36)}`, spec);
        tokenProfile = await createOwnTokenProfile(api, token, `tp-${Date.now().toString(36)}`, spec, { usages: opts.usages ?? PROFILE_USAGES, enabled: false });
        await enableOwnTokenProfile(api, token, tokenProfile);
        updateRunState({ token, tokenProfile });
    }
    const family = opts.family ?? 'rsa-2048';
    const wantsDefault = !opts.suffix && family === 'rsa-2048';
    let key = wantsDefault ? state.key : undefined;
    if (!key) {
        const made = await createOwnKey(api, { token, tokenProfile }, opts.suffix ?? `key-${family}-${Date.now().toString(36)}`, spec, { family });
        key = { uuid: made.uuid, name: made.name, kind: 'own', keyItems: made.keyItems };
        if (opts.enableKey ?? true) await enableOwnKey(api, key);
        if (wantsDefault) updateRunState({ key });
    }
    return { connector, provider: providerOf(connector), token, tokenProfile, key };
}

export const isSkip = <T>(r: T | { skip: string }): r is { skip: string } => typeof (r as { skip?: unknown }).skip === 'string';

// No teardown handler here: the ONE shared `keys` handler of teardownHandlers.ts removes own token keys and
// `keyItems` go with their key (`goneWith`).
