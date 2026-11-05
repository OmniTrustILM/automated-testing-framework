/**
 * tokens — the run's own cryptography connector lookup, tokens and token profiles.
 *
 * Finds the software cryptography connector of an interface version, creates own tokens and token profiles, enables, disables
 * and changes their usages, and holds the pure builders of the token request attributes. Keys, operations and the ensure chain
 * all start from these.
 *
 * Every mutation takes a GuardedApi and an own reference, records the create in the ledger right after it, and reads the live
 * attribute definitions instead of hard-coded ids.
 */

import type { APIRequestContext } from '@playwright/test';
import { Logger } from '../../Logger';
import { connectorVersion } from './connectorApi';
import { AttributeDefinition, PROFILE_USAGES, Provider, SCP_ATTR, Usage } from './cryptoAlgorithmCases';
import type { GuardedApi } from '../guard/types';
import { assertOwnLive } from '../ledger/ownership';
import { apiJson } from '../apiReads';
import { requestAttributesFrom, requiredCustomAttributes } from '../customAttributes';
import { OwnRef, Ref } from '../ledger/ledger';
import { runName, runId, ownName } from '../ledger/runState';
import { isJsonObject, JsonObject } from '../json';
import { uniqueSuffix } from '../text';
import { createOwn } from '../ownCrud';
import { settings } from '../run/settings';

const logger = new Logger('Tokens');


export interface CryptoConnector {
    uuid: string;
    name: string;
    version: 1 | 2;
}

/** The registration name the suite looks for first (`REG_CRYPTO_CONNECTOR_V2` / `_V1` override; chart defaults). */
const DEFAULT_CRYPTO_CONNECTOR: Readonly<Record<1 | 2, string>> = { 2: 'Software-Cryptography-Provider-v2', 1: 'Software-Cryptography-Provider' };

/**
 * The software cryptography connector of the wanted interface version: the connector named by the environment (or
 * the chart default), else the first `connected` connector whose function groups include `cryptographyProvider` and
 * whose v2 detail reports that version. Undefined when the tier has none (the caller skips with a named reason).
 */
export async function findCryptoConnector(api: APIRequestContext, version: 1 | 2 = 2, env: NodeJS.ProcessEnv = process.env): Promise<CryptoConnector | undefined> {
    const wanted = settings(env).cryptoConnector(version) || DEFAULT_CRYPTO_CONNECTOR[version];
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


/** The provider-side token name derived from the ILM name: a letter first, then letters, digits and single underscores. */
export function tokenAlias(name: string): string {
    const body = name.replace(/[^A-Za-z0-9]+/g, '_').replace(/^_+|_+$/g, '');
    return /^[A-Za-z]/.test(body) ? body : `t_${body}`;
}

/** `GET /v1/tokens/{connectorUuid}/attributes[?kind=]` (the token form schema of the connector; a v2 record takes no kind). */
async function listTokenAttributes(api: APIRequestContext, connector: CryptoConnector, kind?: string): Promise<AttributeDefinition[]> {
    const q = kind ? `?kind=${encodeURIComponent(kind)}` : '';
    return apiJson<AttributeDefinition[]>(api, 'GET', `/api/v1/tokens/${connector.uuid}/attributes${q}`);
}

export const uuidOf = (defs: AttributeDefinition[], attr: { name: string; uuid: string }): string => defs.find((d) => d.name === attr.name)?.uuid ?? attr.uuid;

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
export const activationCode = (): string => `Qa${runId().replace(/[^0-9a-z]/g, '')}${uniqueSuffix()}`;

export interface TokenOptions {
    /** The crypto connector the token is created on. */
    connector: CryptoConnector;
    /** `SOFT` on a v1 record; omitted on a v2 record (the v2 request carries no kind). */
    kind?: string;
    /** The activation code the token is created with (default: a generated one); a v1 token needs the same code again to be activated. */
    code?: string;
}

/**
 * `POST /v1/tokens` for an own token on the connector (recorded as `tokens` before anything else). The v2 request
 * carries `name`, `connectorUuid` and the connector attributes and no `kind`.
 */
export async function createOwnToken(api: GuardedApi, spec: string, suffix: string, o: TokenOptions): Promise<OwnRef> {
    const name = ownName(suffix);
    const defs = await listTokenAttributes(api, o.connector, o.kind);
    const { answer: _answer, ...ref } = await createOwn(api, spec, {
        type: 'tokens',
        path: '/api/v1/tokens',
        name,
        note: `own token on ${o.connector.name}`,
        body: {
            description: `REG run ${runId()}`,
            connectorUuid: o.connector.uuid,
            ...(o.kind ? { kind: o.kind } : {}),
            attributes: tokenRequestAttributes(defs, tokenAlias(name), o.code ?? activationCode()),
            customAttributes: await requiredCustomAttributes(api, 'tokens', runName('ca')),
        },
    });
    logger.info(`token ${name} created on ${o.connector.name}`);
    return ref;
}

/** `GET /v1/tokens/{uuid}` (a side-effect GET: it persists the connector-reported status — own tokens only). */
export const getOwnToken = (api: APIRequestContext, token: OwnRef): Promise<JsonObject> => apiJson<JsonObject>(api, 'GET', `/api/v1/tokens/${token.uuid}`);

/** `PATCH /v1/tokens/{uuid}`: reload the status from the connector (own token). */
export async function reloadOwnToken(api: GuardedApi, token: OwnRef): Promise<JsonObject> {
    await assertOwnLive(api, 'tokens', token, 'tokens.reloadOwnToken');
    return apiJson<JsonObject>(api, 'PATCH', `/api/v1/tokens/${token.uuid}`);
}

/** The activation request attributes of a v1 token (pure): the live activation definitions, the token code filled with the creation code. */
export function activationAttributesFor(defs: AttributeDefinition[], code: string): JsonObject[] {
    return requestAttributesFrom(defs, { [SCP_ATTR.tokenCode.name]: code }, code);
}

/** `PATCH /v1/tokens/{uuid}/activate` on an own v1 token with the code it was created with (the definitions are read live first). */
export async function activateOwnToken(api: GuardedApi, token: OwnRef, code: string): Promise<void> {
    await assertOwnLive(api, 'tokens', token, 'tokens.activateOwnToken');
    const defs = await apiJson<AttributeDefinition[]>(api, 'GET', `/api/v1/tokens/${token.uuid}/activate/attributes`);
    await apiJson(api, 'PATCH', `/api/v1/tokens/${token.uuid}/activate`, activationAttributesFor(defs, code));
}

export const V2_TOKEN_STATUSES: readonly string[] = ['Connected', 'Disconnected', 'Warning', 'Unknown'];
export const V1_ONLY_TOKEN_STATUSES: readonly string[] = ['Activated', 'Deactivated'];

/** The status code of a token detail (`status.status`), e.g. `Connected`. */
export function tokenStatusOf(detail: JsonObject): string | undefined {
    const status = detail?.status;
    const code = isJsonObject(status) ? status.status : status;
    return typeof code === 'string' ? code : undefined;
}


export interface ProfileOptions {
    /** The own token the profile belongs to. */
    token: OwnRef;
    usages?: readonly Usage[];
    enabled?: boolean;
    description?: string;
}

/** `POST /v1/tokens/{token}/tokenProfiles` (own token, recorded as `tokenProfiles` with parent `token`). */
export async function createOwnTokenProfile(api: GuardedApi, spec: string, suffix: string, o: ProfileOptions): Promise<OwnRef> {
    const { answer: _answer, ...ref } = await createOwn(api, spec, {
        type: 'tokenProfiles',
        path: `/api/v1/tokens/${o.token.uuid}/tokenProfiles`,
        name: ownName(suffix),
        note: 'own token profile',
        parents: { token: o.token.uuid },
        body: {
            description: o.description ?? `REG run ${runId()}`,
            attributes: [],
            customAttributes: await requiredCustomAttributes(api, 'tokenProfiles', runName('ca')),
            enabled: o.enabled ?? false,
            usage: [...(o.usages ?? PROFILE_USAGES)],
        },
    });
    return ref;
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
    await assertOwnLive(api, 'tokenProfiles', profile, 'tokens.enableOwnTokenProfile');
    await apiJson(api, 'PATCH', `${profileUrl(token, profile)}/enable`);
}

export async function disableOwnTokenProfile(api: GuardedApi, token: OwnRef, profile: OwnRef): Promise<void> {
    await assertOwnLive(api, 'tokenProfiles', profile, 'tokens.disableOwnTokenProfile');
    await apiJson(api, 'PATCH', `${profileUrl(token, profile)}/disable`);
}

/** `PUT …/usages` on an own profile (JSONB round trip). */
export async function updateOwnTokenProfileUsages(api: GuardedApi, token: OwnRef, profile: OwnRef, usages: readonly Usage[]): Promise<void> {
    await assertOwnLive(api, 'tokenProfiles', profile, 'tokens.updateOwnTokenProfileUsages');
    await apiJson(api, 'PUT', `${profileUrl(token, profile)}/usages`, { usage: [...usages] });
}
