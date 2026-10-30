/**
 * secretsAndVaults — the run's own vault instances, vault profiles and secrets (REG-SEC-01…03).
 *
 * Creates are recorded with the parents a later delete needs. Also here: the secret state wait, and the run's vault chain kept
 * in RunState. A pre-existing vault instance may only be the parent of an own vault profile; the content of a pre-existing
 * secret is never read.
 */
import type { APIRequestContext, APIResponse } from '@playwright/test';
import { Logger } from '../../Logger';
import type { AttributeDefinition } from './cryptoAlgorithmCases';
import { findConnectorWithInterface } from './connectorLookup';
import type { GuardedApi } from '../guard/types';
import { assertOwnLive } from '../ledger/ownership';
import { hasRunFamilyPrefix } from '../run/runId';
import { apiJson } from '../apiReads';
import { requestAttributesFrom, requiredCustomAttributes, toRequestAttributes } from '../customAttributes';
import type { OwnRef, Ref } from '../ledger/ledger';
import { createOwn } from '../ownCrud';
import { ownName, readRunState, runName, runId, updateRunState } from '../ledger/runState';
import { pollUntil } from '../wait';
import type { JsonObject } from '../json';

const logger = new Logger('SecretsAndVaults');

/** `GET /v1/vaults/{connectorUuid}/attributes` — the vault-instance form of a secret-interface connector. */
export const listVaultInstanceAttributes = (api: APIRequestContext, connectorUuid: string): Promise<AttributeDefinition[]> =>
    apiJson<AttributeDefinition[]>(api, 'GET', `/api/v1/vaults/${connectorUuid}/attributes`);

export interface VaultInstanceOptions {
    connector: { uuid: string; name: string; interfaceUuid: string };
    values?: Record<string, unknown>;
}

/** `POST /v1/vaults`: an own vault instance on the connector's secret interface (recorded as `vaultInstances`). */
export async function createOwnVaultInstance(api: GuardedApi, spec: string, suffix: string, o: VaultInstanceOptions): Promise<OwnRef & { detail: JsonObject }> {
    const { connector, values = {} } = o;
    const defs = await listVaultInstanceAttributes(api, connector.uuid);
    // Seen on a live tier: invented values (a fake URL, an unmatched credential type) are refused by the connector. Copy the data
    // attributes of a PRE-EXISTING vault instance of the same connector, read-only (two GETs, nothing on it changes), like
    // createOwnRaProfileLike; without one (or when `values` are given) the definitions are filled by `requestAttributesFrom`.
    const copied = Object.keys(values).length ? undefined : await copiedVaultAttributes(api, connector.uuid);
    const { answer, ...ref } = await createOwn(api, spec, {
        type: 'vaultInstances',
        path: '/api/v1/vaults',
        name: ownName(suffix),
        note: `own vault instance on ${connector.name}`,
        body: {
            connectorUuid: connector.uuid,
            interfaceUuid: connector.interfaceUuid,
            description: `REG run ${runId()}`,
            attributes: copied ?? requestAttributesFrom(defs, values),
            customAttributes: await requiredCustomAttributes(api, 'vaults', runName('ca')),
        },
    });
    return { ...ref, detail: answer.json };
}

/**
 * The data attributes of the first pre-existing (not run-named) vault instance of a connector, as request attributes; undefined when none.
 */
async function copiedVaultAttributes(api: APIRequestContext, connectorUuid: string): Promise<JsonObject[] | undefined> {
    const rows = (await listVaultInstances(api)).filter((v) => !hasRunFamilyPrefix(String(v.name)));
    for (const row of rows.sort((a, b) => (String(a.name) < String(b.name) ? -1 : 1))) {
        const detail = await getVaultInstance(api, String(row.uuid));
        if (String(detail.connectorUuid ?? (detail.connector as JsonObject | undefined)?.uuid) !== connectorUuid) continue;
        const attributes = toRequestAttributes(detail.attributes as JsonObject[] | undefined);
        if (attributes.length) return attributes;
    }
    return undefined;
}

export const getVaultInstance = (api: APIRequestContext, uuid: string): Promise<JsonObject> => apiJson<JsonObject>(api, 'GET', `/api/v1/vaults/${uuid}`);

/** The vault instances of the tier (`POST /v1/vaults/list`, a read POST): rows with uuid, name, connector fields. */
async function listVaultInstances(api: APIRequestContext): Promise<JsonObject[]> {
    const body = await apiJson<JsonObject>(api, 'POST', '/api/v1/vaults/list', { itemsPerPage: 100, pageNumber: 1, filters: [] });
    return (body.vaults ?? body.items ?? body.vaultInstances ?? []) as JsonObject[];
}

const listVaultProfileAttributes = (api: APIRequestContext, vaultUuid: string): Promise<AttributeDefinition[]> =>
    apiJson<AttributeDefinition[]>(api, 'GET', `/api/v1/vaults/${vaultUuid}/vaultProfiles/attributes`);

export interface VaultProfileOptions {
    /** The vault the profile goes under: own or pre-existing (a create under a pre-existing parent; the parent is not changed). */
    vault: Pick<Ref, 'uuid' | 'name'>;
    values?: Record<string, unknown>;
}

/** `POST /v1/vaults/{vault}/vaultProfiles`: an own vault profile (recorded as `vaultProfiles` with parent `vault`). */
export async function createOwnVaultProfile(api: GuardedApi, spec: string, suffix: string, o: VaultProfileOptions): Promise<OwnRef & { detail: JsonObject }> {
    const { vault, values = {} } = o;
    const defs = await listVaultProfileAttributes(api, vault.uuid);
    const { answer, ...ref } = await createOwn(api, spec, {
        type: 'vaultProfiles',
        path: `/api/v1/vaults/${vault.uuid}/vaultProfiles`,
        name: ownName(suffix),
        note: `own vault profile under vault ${vault.name}`,
        parents: { vault: vault.uuid },
        body: {
            description: `REG run ${runId()}`,
            attributes: requestAttributesFrom(defs, values),
            customAttributes: await requiredCustomAttributes(api, 'vaultProfiles', runName('ca')),
        },
    });
    return { ...ref, detail: answer.json };
}

const vaultProfileUrl = (vault: Pick<Ref, 'uuid'>, profile: Pick<Ref, 'uuid'>): string => `/api/v1/vaults/${vault.uuid}/vaultProfiles/${profile.uuid}`;

export async function enableOwnVaultProfile(api: GuardedApi, vault: Pick<Ref, 'uuid'>, profile: OwnRef): Promise<APIResponse> {
    await assertOwnLive(api, 'vaultProfiles', profile, 'secretsAndVaults.enableOwnVaultProfile');
    return api.patch(`${vaultProfileUrl(vault, profile)}/enable`);
}

export async function disableOwnVaultProfile(api: GuardedApi, vault: Pick<Ref, 'uuid'>, profile: OwnRef): Promise<APIResponse> {
    await assertOwnLive(api, 'vaultProfiles', profile, 'secretsAndVaults.disableOwnVaultProfile');
    return api.patch(`${vaultProfileUrl(vault, profile)}/disable`);
}

export type SecretType = 'generic' | 'apiKey' | 'basicAuth' | 'jwtToken' | 'privateKey' | 'secretKey' | 'keyStore' | 'keyValue';

/** `GET …/vaultProfiles/{p}/secrets/{type}/attributes` — the secret-type form (REG-SEC-02). */
export const listSecretAttributes = (api: APIRequestContext, vault: Pick<Ref, 'uuid'>, profile: Pick<Ref, 'uuid'>, type: SecretType): Promise<AttributeDefinition[]> =>
    apiJson<AttributeDefinition[]>(api, 'GET', `${vaultProfileUrl(vault, profile)}/secrets/${type}/attributes`);

/**
 * The secret attributes for a value (pure): every secret-typed data attribute gets `{secret: value}`; a basicAuth form
 * gets the username into its user-named string attribute; other required attributes are filled by type.
 */
export function secretAttributesFor(defs: AttributeDefinition[], type: SecretType, value: string, username = 'qa'): JsonObject[] {
    const values: Record<string, unknown> = {};
    for (const d of defs) {
        if (String(d.contentType) === 'secret') values[d.name] = value;
        else if (type === 'basicAuth' && /user/i.test(d.name)) values[d.name] = username;
    }
    return requestAttributesFrom(defs, values, value);
}

/**
 * The `secret` of core's SecretRequestDto: generic / apiKey / jwtToken / secretKey → `{ type, content }`; basicAuth → `{ type, username,
 * password }`.
 */
export function secretContentFor(type: SecretType, value: string, username = 'qa'): JsonObject {
    return type === 'basicAuth' ? { type, username, password: value } : { type, content: value };
}

export interface SecretOptions {
    vault: Pick<Ref, 'uuid'>;
    profile: OwnRef;
    type: SecretType;
    value: string;
}

/** `POST …/vaultProfiles/{p}/secrets`: an own secret of `type` holding `value` (recorded as `secrets`); the detail. */
export async function createOwnSecret(api: GuardedApi, spec: string, suffix: string, o: SecretOptions): Promise<OwnRef & { detail: JsonObject }> {
    const { vault, profile, type, value } = o;
    const defs = await listSecretAttributes(api, vault, profile, type);
    const { answer, ...ref } = await createOwn(api, spec, {
        type: 'secrets',
        path: `${vaultProfileUrl(vault, profile)}/secrets`,
        name: ownName(suffix),
        note: `own ${type} secret`,
        parents: { vaultProfile: profile.uuid },
        body: {
            // Core's SecretRequestDto (SecretManagementController.createSecret), NOT the connector's DTO: `secret` is mandatory and
            // polymorphic on `type`.
            description: `REG run ${runId()}`,
            secret: secretContentFor(type, value),
            attributes: secretAttributesFor(defs, type, value),
            customAttributes: [],
        },
    });
    return { ...ref, detail: answer.json };
}

const getSecret = (api: APIRequestContext, uuid: string): Promise<JsonObject> => apiJson<JsonObject>(api, 'GET', `/api/v1/secrets/${uuid}`);
/**
 * A secret is created INACTIVE and activated by an asynchronous action once the vault connector wrote it (core `createSecretAction`; FAILED
 * on an error): polls `GET /v1/secrets/{uuid}` until `state` is `want` (REG-SEC-03). Throws with the detail on `failed` or at the timeout.
 * `enabled` is a separate action and is not waited for.
 */
export async function waitForSecretState(api: APIRequestContext, uuid: string, want: string, timeoutMs = 60_000, intervalMs = 1_000): Promise<JsonObject> {
    const stateOf = (d: JsonObject): string => String(d.state ?? '').toLowerCase();
    const detail = await pollUntil(
        async () => {
            const d = await getSecret(api, uuid);
            if (stateOf(d) !== want.toLowerCase() && stateOf(d) === 'failed') throw new Error(`secret ${uuid} is failed while waiting for ${want}: ${JSON.stringify(d).slice(0, 300)}`);
            return d;
        },
        (d) => stateOf(d) === want.toLowerCase(),
        { timeoutMs, intervalMs, tolerateErrors: 0, onTimeout: 'return' },
    );
    if (stateOf(detail) !== want.toLowerCase()) throw new Error(`secret ${uuid} is still ${stateOf(detail) || '?'} after ${timeoutMs} ms (wanted ${want}): ${JSON.stringify(detail).slice(0, 300)}`);
    return detail;
}

export const getSecretVersions = (api: APIRequestContext, uuid: string): Promise<JsonObject[]> => apiJson<JsonObject[]>(api, 'GET', `/api/v1/secrets/${uuid}/versions`);

/**
 * Enables an own secret (`PATCH /v1/secrets/{uuid}/enable`), as the product requires before its content is read, and waits until the
 * detail shows `enabled`. Own secrets only: the live own-object check runs first. Throws with the answer on a refusal or a timeout.
 */
export async function enableOwnSecret(api: GuardedApi, secret: OwnRef, timeoutMs = 30_000, intervalMs = 500): Promise<JsonObject> {
    await assertOwnLive(api, 'secrets', secret, 'secretsAndVaults.enableOwnSecret');
    const answer = await api.patch(`/api/v1/secrets/${secret.uuid}/enable`);
    if (answer.status() >= 300) throw new Error(`enabling secret ${secret.uuid} answered ${answer.status()}: ${(await answer.text()).slice(0, 300)}`);
    const detail = await pollUntil(() => getSecret(api, secret.uuid), (d) => d.enabled === true, { timeoutMs, intervalMs, tolerateErrors: 0, onTimeout: 'return' });
    if (detail.enabled !== true) throw new Error(`secret ${secret.uuid} is still not enabled ${timeoutMs} ms after the enable answered ${answer.status()}: ${JSON.stringify(detail).slice(0, 300)}`);
    return detail;
}

/** `GET /v1/secrets/{uuid}/content` (a side-effect GET: own secrets only; the guard refuses a pre-existing one). */
export async function readOwnSecretContent(api: GuardedApi, secret: OwnRef): Promise<JsonObject> {
    await assertOwnLive(api, 'secrets', secret, 'secretsAndVaults.readOwnSecretContent');
    return apiJson<JsonObject>(api, 'GET', `/api/v1/secrets/${secret.uuid}/content`);
}

/** Every string value in a JSON document (for "the value never appears in list / detail responses"). */
export function stringValues(doc: unknown, out: string[] = []): string[] {
    if (typeof doc === 'string') out.push(doc);
    else if (Array.isArray(doc)) doc.forEach((v) => stringValues(v, out));
    else if (doc && typeof doc === 'object') Object.values(doc as JsonObject).forEach((v) => stringValues(v, out));
    return out;
}

/** The run's vault instance (own when the tier has a secret-interface connector; recorded; idempotent per run). */
async function ensureOwnVaultInstance(api: GuardedApi, spec: string, env: NodeJS.ProcessEnv = process.env): Promise<OwnRef | { skip: string }> {
    const state = readRunState();
    if (state.vaultInstance) return state.vaultInstance;
    const connector = await findConnectorWithInterface(api, /^secret/i, env);
    if (!connector) return { skip: 'no connected connector with a secret interface is registered on this tier (REG_SECRET_CONNECTOR)' };
    let vault: OwnRef & { detail: JsonObject };
    try {
        vault = await createOwnVaultInstance(api, spec, 'vault', { connector });
    } catch (e) {
        // A refusal of the create (connector / core validation of the tier's vault settings) is an environment gate, never red:
        // the caller falls back to a pre-existing vault instance or skips with this reason.
        return { skip: `own vault instance refused on ${connector.name}: ${String(e instanceof Error ? e.message : e).slice(0, 200)}` };
    }
    const ref: OwnRef = { uuid: vault.uuid, name: vault.name, kind: 'own' };
    updateRunState({ vaultInstance: ref });
    return ref;
}

/** The run's vault profile under the run's vault (or under the first pre-existing vault when the run has none). */
export async function ensureOwnVaultProfile(api: GuardedApi, spec: string): Promise<{ vault: Ref; profile: OwnRef } | { skip: string }> {
    const state = readRunState();
    let vault: Ref | undefined = state.vaultInstance;
    if (!vault) {
        const own = await ensureOwnVaultInstance(api, spec);
        if (!('skip' in own)) vault = own;
        else {
            const existing = (await listVaultInstances(api))[0];
            if (!existing) return { skip: `${own.skip}; and no pre-existing vault instance to create the profile under` };
            vault = { uuid: String(existing.uuid), name: String(existing.name) };
            logger.info('vault profile goes under a pre-existing vault instance (a create under a pre-existing parent)');
        }
    }
    if (state.vaultProfile) return { vault, profile: state.vaultProfile };
    const profile = await createOwnVaultProfile(api, spec, 'vp', { vault });
    const ref: OwnRef = { uuid: profile.uuid, name: profile.name, kind: 'own' };
    updateRunState({ vaultProfile: ref });
    return { vault, profile: ref };
}
