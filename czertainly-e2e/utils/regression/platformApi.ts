/**
 * platformApi — the run's OWN credentials, authorities, vault instances, vault profiles, secrets and compliance
 * profiles (platform area, B3: REG-SEC-01…03, REG-COMP-03, REG-CONN-14), plus generic attribute filling and the
 * teardown handlers the registry expects from this module (runTeardown HANDLER_MODULES: entities, locations, secrets,
 * vaultProfiles, vaultInstances, complianceProfiles; `savedViews` / `oidEntries` belong to the inventory area and are
 * not here).
 *
 * Rules kept (Q1 / D1, R6, Q2): every mutation takes a `GuardedApi`; creates are recorded before any assertion with the
 * parents a later delete needs (`vault` of a vault profile, `entity` of a location); a pre-existing vault instance may
 * only be the PARENT of an own vault profile (accepted deviation R6-4, like an own RA profile under a pre-existing
 * authority); the content of a pre-existing secret is never read (`GET /v1/secrets/{id}/content` is a side-effect GET
 * the guard sends for own secrets only); connector attribute definitions are read live and filled by name / content
 * type, never hard-coded per tier.
 *
 * Business rules: platform-keys-connectors A4 r3, r15, r16 (secret model, ilm#83), r17 (compliance, ilm#70).
 */
import type { APIRequestContext, APIResponse } from '@playwright/test';
import { randomBytes } from 'crypto';
import { Logger } from '../Logger';
import type { AttributeDefinition } from './cryptoMatrix';
import type { GuardedApi } from './guardedApi';
import { requestVersion } from './attributeVersion';
import { assertOwnLive } from './ownObjects';
import { hasRunFamilyPrefix } from './runId';
import { apiJson, requiredCustomAttributes } from './regressionApi';
import { OwnRef, readState, recordCreated, Ref, regName, RUN_ID, updateState } from './regressionRun';
import type { TeardownHandler } from './runTeardown';
import { deleteVerified, removeComplianceProfile } from './teardownHandlers';

const logger = new Logger('PlatformApi');

type Json = Record<string, any>;

// ------------------------------------------------------------------ attributes

/**
 * Values for the REQUIRED custom attributes a tier defines on any resource (`GET /v1/attributes/custom/resources/{r}`);
 * the B1 helper covers four resources with a closed type, this one takes the resource code as a string (tokens,
 * tokenProfiles, keys, vaults, secrets, complianceProfiles, credentials, authorities, …). Delegates to the ONE shared filler (`regressionApi.requiredCustomAttributes`).
 */
export async function requiredCustomAttributesOf(api: APIRequestContext, resource: string, value: string): Promise<Json[]> {
    return requiredCustomAttributes(api, resource, value);
}

/**
 * Request attributes from a LIVE definition list (pure): `values` by attribute name win; otherwise a required DATA
 * attribute gets a value by content type (string / text → `fallback`, secret → `{secret: fallback}`, boolean → false,
 * integer → 1, a list → its first option); optional attributes without a value are left out; a required attribute of
 * a type the suite cannot fill throws (never a guess). `info` / `group` definitions are skipped.
 */
export function requestAttributesFrom(defs: AttributeDefinition[], values: Record<string, unknown> = {}, fallback = 'qa'): Json[] {
    const out: Json[] = [];
    for (const d of defs) {
        if (d.type && !/^data$/i.test(d.type)) continue;
        const type = String(d.contentType ?? 'string');
        const given = values[d.name];
        let content: Json[] | undefined;
        if (given !== undefined) {
            content = type === 'secret' && (typeof given === 'string') ? [{ data: { secret: given } }] : [{ data: given }];
        } else if (d.properties?.required) {
            if (d.properties.list && d.content?.length) content = [{ ...(d.content[0] as Json), contentType: (d.content[0] as Json).contentType ?? type }];
            else if (['string', 'text', 'codeblock'].includes(type)) content = [{ data: fallback }];
            else if (type === 'secret') content = [{ data: { secret: fallback } }];
            else if (type === 'boolean') content = [{ data: false }];
            else if (['integer', 'float'].includes(type)) content = [{ data: 1 }];
            else throw new Error(`required attribute ${d.name} has content type ${type}, which the suite cannot fill`);
        }
        if (content) out.push({ name: d.name, uuid: d.uuid, version: requestVersion(d as Json), contentType: type, content });
    }
    return out;
}

/** Response attribute → request attribute (data attributes only), for copying a pre-existing object's settings. */
export const toRequestAttributes = (attributes: Json[] | undefined): Json[] =>
    (attributes ?? []).filter((a) => !a.type || a.type === 'data').map((a) => ({ version: requestVersion(a), uuid: a.uuid, name: a.name, contentType: a.contentType, content: a.content }));

// ------------------------------------------------------------------ connectors (read-only)

export interface ConnectorInterface {
    uuid: string;
    code: string;
    version?: string;
}

/** The interfaces a v2 connector declares (`GET /v2/connectors/{uuid}` → `interfaces[]`), by code. */
export async function connectorInterfaces(api: APIRequestContext, connectorUuid: string): Promise<ConnectorInterface[]> {
    const detail = await apiJson<Json>(api, 'GET', `/api/v2/connectors/${connectorUuid}`);
    return ((detail.interfaces ?? []) as Json[]).map((i) => ({ uuid: String(i.uuid ?? i.interfaceUuid ?? ''), code: String(i.code ?? i.name ?? ''), version: i.version }));
}

/** The chart's registration name of the credential provider's v2 record: the default secret-interface connector (Sonnet F8). */
export const DEFAULT_SECRET_CONNECTOR = 'Common-Credential-Connector-v2';
/** The registered name differs between tiers by a space or a hyphen before `v2`. */
export const DEFAULT_SECRET_CONNECTOR_RE = /^Common-Credential-Connector[ -]v2$/i;

/**
 * The first connected connector whose v2 interfaces include a code matching `code` (e.g. /^secret/i): the one named by
 * `env[envName]`, else the credential provider v2 (`DEFAULT_SECRET_CONNECTOR`), else the first connected one with the interface.
 */
export async function findConnectorWithInterface(api: APIRequestContext, code: RegExp, env: NodeJS.ProcessEnv = process.env, envName?: string): Promise<{ uuid: string; name: string; interfaceUuid: string } | undefined> {
    const rows = await apiJson<Json[]>(api, 'GET', '/api/v1/connectors');
    const named = (envName ? env[envName] : undefined);
    // The provider is matched by what it IS, not by one display name (live run 3: "Common-Credential-Connector v2" with a space
    // missed the hyphenated default and the first connected connector with a secret interface won): the named one, the credential
    // provider v2 by either spelling, then any connector with a credentialProvider function group, then the other connected ones.
    const isCredentialProvider = (r: Json): boolean => (r.functionGroups ?? []).some((g: Json) => g.functionGroupCode === 'credentialProvider' || g.code === 'credentialProvider');
    const picked = new Set<string>();
    const ordered: Json[] = [];
    const take = (pred: (r: Json) => boolean): void => { for (const r of rows) if (pred(r) && !picked.has(String(r.uuid))) { picked.add(String(r.uuid)); ordered.push(r); } };
    if (named) take((r) => r.name === named);
    take((r) => DEFAULT_SECRET_CONNECTOR_RE.test(String(r.name)));
    take((r) => r.status === 'connected' && isCredentialProvider(r));
    take((r) => r.status === 'connected');
    for (const r of ordered) {
        const res = await api.get(`/api/v2/connectors/${r.uuid}`);
        if (!res.ok()) continue;
        const detail = (await res.json()) as Json;
        const iface = ((detail.interfaces ?? []) as Json[]).find((i) => code.test(String(i.code ?? i.name ?? '')));
        if (iface) return { uuid: String(r.uuid), name: String(r.name), interfaceUuid: String(iface.uuid ?? iface.interfaceUuid) };
    }
    return undefined;
}

/** The first connected v1 connector offering a credential kind (`credentialProvider` / `Basic`). */
export async function findCredentialConnector(api: APIRequestContext, kind = 'Basic', env: NodeJS.ProcessEnv = process.env): Promise<{ uuid: string; name: string } | undefined> {
    const rows = await apiJson<Json[]>(api, 'GET', '/api/v1/connectors');
    const wanted = env.REG_CREDENTIAL_CONNECTOR || 'Common-Credential-Connector';
    const ordered = [...rows.filter((r) => r.name === wanted), ...rows.filter((r) => r.name !== wanted)];
    const row = ordered.find((r) => r.status === 'connected'
        && (r.functionGroups ?? []).some((g: Json) => (g.functionGroupCode === 'credentialProvider' || g.code === 'credentialProvider') && (g.kinds ?? []).includes(kind)));
    return row ? { uuid: String(row.uuid), name: String(row.name) } : undefined;
}

// ------------------------------------------------------------------ credentials and authorities (REG-CONN-14)

/** The credential-provider attribute definitions of a kind (`GET /v1/connectors/{uuid}/attributes/credentialProvider/{kind}`). */
export const listCredentialAttributes = (api: APIRequestContext, connectorUuid: string, kind = 'Basic'): Promise<AttributeDefinition[]> =>
    apiJson<AttributeDefinition[]>(api, 'GET', `/api/v1/connectors/${connectorUuid}/attributes/credentialProvider/${kind}`);

/** `POST /v1/credentials`: an own Basic credential on the credential connector (username / password from the definitions by name). */
export async function createOwnBasicCredential(api: GuardedApi, connector: { uuid: string; name: string }, suffix: string, spec: string, login?: { username: string; password: string }): Promise<OwnRef> {
    const name = regName(suffix);
    // A throw-away login for an OWN credential: generated per call, never a tier login, never logged (Sonnet F11).
    login = login ?? { username: `qa-${Date.now().toString(36)}`, password: `Qa-${randomBytes(12).toString('base64url')}` };
    const defs = await listCredentialAttributes(api, connector.uuid, 'Basic');
    const values: Record<string, unknown> = {};
    for (const d of defs) {
        if (/user/i.test(d.name)) values[d.name] = login.username;
        if (/pass/i.test(d.name)) values[d.name] = login.password;
    }
    const created = await apiJson<Json>(api, 'POST', '/api/v1/credentials', {
        name,
        kind: 'Basic',
        connectorUuid: connector.uuid,
        attributes: requestAttributesFrom(defs, values, login.username),
        customAttributes: await requiredCustomAttributesOf(api, 'credentials', regName('ca')),
    });
    return recordCreated('credentials', { uuid: String(created.uuid), name }, spec, `own Basic credential on ${connector.name}`);
}

/** A connected pre-existing authority on a connector whose name matches (never a run object). */
export async function findAuthoritySource(api: APIRequestContext, connectorName: RegExp): Promise<Json | undefined> {
    const all = await apiJson<Json[]>(api, 'GET', '/api/v1/authorities');
    return all.find((a) => connectorName.test(String(a.connectorName)) && a.status === 'connected' && !/^qa-(reg|api)-/.test(String(a.name)));
}

/**
 * An own authority on the SAME connector as `source`, with the source's DATA attributes copied read-only (one GET of
 * its detail) and every credential-typed attribute replaced by the own credential: the own Basic credential is used
 * on an authority (REG-CONN-14) without any CA host written into the suite. The raw response is returned (a refused
 * creation is the connector's verdict: the caller records it and proves nothing was left behind).
 */
export async function createOwnAuthorityLike(api: GuardedApi, source: Json, credential: OwnRef, suffix: string, spec: string): Promise<{ name: string; response: APIResponse; ref?: OwnRef }> {
    const name = regName(suffix);
    const detail = await apiJson<Json>(api, 'GET', `/api/v1/authorities/${source.uuid}`);
    const attributes = toRequestAttributes(detail.attributes).map((a) =>
        a.contentType === 'credential' ? { ...a, content: [{ reference: credential.name, data: { uuid: credential.uuid, name: credential.name } }] } : a);
    const response = await api.post('/api/v1/authorities', {
        data: {
            name,
            connectorUuid: source.connectorUuid,
            kind: detail.kind ?? source.kind,
            attributes,
            customAttributes: await requiredCustomAttributesOf(api, 'authorities', regName('ca')),
        },
    });
    if (!response.ok()) return { name, response };
    const created = (await response.json()) as Json;
    return { name, response, ref: recordCreated('authorities', { uuid: String(created.uuid), name }, spec, `own authority like ${source.connectorName} with the own credential`) };
}

// ------------------------------------------------------------------ vaults and secrets (REG-SEC-01…03)

/** `GET /v1/vaults/{connectorUuid}/attributes` — the vault-instance form of a secret-interface connector. */
export const listVaultInstanceAttributes = (api: APIRequestContext, connectorUuid: string): Promise<AttributeDefinition[]> =>
    apiJson<AttributeDefinition[]>(api, 'GET', `/api/v1/vaults/${connectorUuid}/attributes`);

/** `POST /v1/vaults`: an own vault instance on the connector's secret interface (recorded as `vaultInstances`). */
export async function createOwnVaultInstance(api: GuardedApi, connector: { uuid: string; name: string; interfaceUuid: string }, suffix: string, spec: string, values: Record<string, unknown> = {}): Promise<OwnRef & { detail: Json }> {
    const name = regName(suffix);
    const defs = await listVaultInstanceAttributes(api, connector.uuid);
    // Live run 2: invented values (a fake URL, an unmatched credential type) are refused by the connector. Copy the data
    // attributes of a PRE-EXISTING vault instance of the same connector, read-only (two GETs, nothing on it changes), like
    // createRaProfileLike; without one (or when `values` are given) the definitions are filled by `requestAttributesFrom`.
    const copied = Object.keys(values).length ? undefined : await copiedVaultAttributes(api, connector.uuid);
    const created = await apiJson<Json>(api, 'POST', '/api/v1/vaults', {
        connectorUuid: connector.uuid,
        interfaceUuid: connector.interfaceUuid,
        name,
        description: `REG run ${RUN_ID}`,
        attributes: copied ?? requestAttributesFrom(defs, values),
        customAttributes: await requiredCustomAttributesOf(api, 'vaults', regName('ca')),
    });
    const ref = recordCreated('vaultInstances', { uuid: String(created.uuid), name }, spec, `own vault instance on ${connector.name}`);
    return { ...ref, detail: created };
}

/** The data attributes of the first pre-existing (not run-named) vault instance of a connector, as request attributes; undefined when none. */
export async function copiedVaultAttributes(api: APIRequestContext, connectorUuid: string): Promise<Json[] | undefined> {
    const rows = (await listVaultInstances(api)).filter((v) => !hasRunFamilyPrefix(String(v.name)));
    for (const row of rows.sort((a, b) => (String(a.name) < String(b.name) ? -1 : 1))) {
        const detail = await getVaultInstance(api, String(row.uuid));
        if (String(detail.connectorUuid ?? detail.connector?.uuid) !== connectorUuid) continue;
        const attributes = toRequestAttributes(detail.attributes);
        if (attributes.length) return attributes;
    }
    return undefined;
}

export const getVaultInstance = (api: APIRequestContext, uuid: string): Promise<Json> => apiJson<Json>(api, 'GET', `/api/v1/vaults/${uuid}`);

/** The vault instances of the tier (`POST /v1/vaults/list`, a read POST): rows with uuid, name, connector fields. */
export async function listVaultInstances(api: APIRequestContext): Promise<Json[]> {
    const body = await apiJson<Json>(api, 'POST', '/api/v1/vaults/list', { itemsPerPage: 100, pageNumber: 1, filters: [] });
    return (body.vaults ?? body.items ?? body.vaultInstances ?? []) as Json[];
}

export const listVaultProfileAttributes = (api: APIRequestContext, vaultUuid: string): Promise<AttributeDefinition[]> =>
    apiJson<AttributeDefinition[]>(api, 'GET', `/api/v1/vaults/${vaultUuid}/vaultProfiles/attributes`);

/**
 * `POST /v1/vaults/{vault}/vaultProfiles`: an own vault profile (recorded as `vaultProfiles` with parent `vault`). The
 * vault may be own or pre-existing (R6-4: a create under a pre-existing parent; the parent is not changed).
 */
export async function createOwnVaultProfile(api: GuardedApi, vault: Pick<Ref, 'uuid' | 'name'>, suffix: string, spec: string, values: Record<string, unknown> = {}): Promise<OwnRef & { detail: Json }> {
    const name = regName(suffix);
    const defs = await listVaultProfileAttributes(api, vault.uuid);
    const created = await apiJson<Json>(api, 'POST', `/api/v1/vaults/${vault.uuid}/vaultProfiles`, {
        name,
        description: `REG run ${RUN_ID}`,
        attributes: requestAttributesFrom(defs, values),
        customAttributes: await requiredCustomAttributesOf(api, 'vaultProfiles', regName('ca')),
    });
    const ref = recordCreated('vaultProfiles', { uuid: String(created.uuid), name }, spec, `own vault profile under vault ${vault.name}`, { vault: vault.uuid });
    return { ...ref, detail: created };
}

export const vaultProfileUrl = (vault: Pick<Ref, 'uuid'>, profile: Pick<Ref, 'uuid'>): string => `/api/v1/vaults/${vault.uuid}/vaultProfiles/${profile.uuid}`;

export async function enableOwnVaultProfile(api: GuardedApi, vault: Pick<Ref, 'uuid'>, profile: OwnRef): Promise<APIResponse> {
    await assertOwnLive(api, 'vaultProfiles', profile, 'platformApi.enableOwnVaultProfile');
    return api.patch(`${vaultProfileUrl(vault, profile)}/enable`);
}

export async function disableOwnVaultProfile(api: GuardedApi, vault: Pick<Ref, 'uuid'>, profile: OwnRef): Promise<APIResponse> {
    await assertOwnLive(api, 'vaultProfiles', profile, 'platformApi.disableOwnVaultProfile');
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
export function secretAttributesFor(defs: AttributeDefinition[], type: SecretType, value: string, username = 'qa'): Json[] {
    const values: Record<string, unknown> = {};
    for (const d of defs) {
        if (String(d.contentType) === 'secret') values[d.name] = value;
        else if (type === 'basicAuth' && /user/i.test(d.name)) values[d.name] = username;
    }
    return requestAttributesFrom(defs, values, value);
}

/** The `secret` of core's SecretRequestDto: generic / apiKey / jwtToken / secretKey → `{ type, content }`; basicAuth → `{ type, username, password }`. */
export function secretContentFor(type: SecretType, value: string, username = 'qa'): Json {
    return type === 'basicAuth' ? { type, username, password: value } : { type, content: value };
}

/** `POST …/vaultProfiles/{p}/secrets`: an own secret of `type` holding `value` (recorded as `secrets`); the detail. */
export async function createOwnSecret(api: GuardedApi, vault: Pick<Ref, 'uuid'>, profile: OwnRef, suffix: string, type: SecretType, value: string, spec: string): Promise<OwnRef & { detail: Json }> {
    const name = regName(suffix);
    const defs = await listSecretAttributes(api, vault, profile, type);
    const created = await apiJson<Json>(api, 'POST', `${vaultProfileUrl(vault, profile)}/secrets`, {
        // Core's SecretRequestDto (SecretManagementController.createSecret), NOT the connector's DTO: `secret` is mandatory and polymorphic on `type`.
        name,
        description: `REG run ${RUN_ID}`,
        secret: secretContentFor(type, value),
        attributes: secretAttributesFor(defs, type, value),
        customAttributes: [],
    });
    const ref = recordCreated('secrets', { uuid: String(created.uuid), name }, spec, `own ${type} secret`, { vaultProfile: profile.uuid });
    return { ...ref, detail: created };
}

export const getSecret = (api: APIRequestContext, uuid: string): Promise<Json> => apiJson<Json>(api, 'GET', `/api/v1/secrets/${uuid}`);
/**
 * A secret is created INACTIVE and activated by an asynchronous action once the vault connector wrote it (core `createSecretAction`; FAILED on
 * an error): polls `GET /v1/secrets/{uuid}` until `state` is `want` (live run 4, REG-SEC-03). Throws with the detail on `failed` or at the timeout.
 * `enabled` is a separate action and is not waited for.
 */
export async function waitForSecretState(api: APIRequestContext, uuid: string, want: string, timeoutMs = 60_000, intervalMs = 1_000): Promise<Json> {
    const deadline = Date.now() + timeoutMs;
    let detail: Json = {};
    for (;;) {
        detail = await getSecret(api, uuid);
        const state = String(detail.state ?? '').toLowerCase();
        if (state === want.toLowerCase()) return detail;
        if (state === 'failed') throw new Error(`secret ${uuid} is failed while waiting for ${want}: ${JSON.stringify(detail).slice(0, 300)}`);
        if (Date.now() >= deadline) throw new Error(`secret ${uuid} is still ${state || '?'} after ${timeoutMs} ms (wanted ${want}): ${JSON.stringify(detail).slice(0, 300)}`);
        await new Promise((resolve) => setTimeout(resolve, intervalMs));
    }
}

export const getSecretVersions = (api: APIRequestContext, uuid: string): Promise<Json[]> => apiJson<Json[]>(api, 'GET', `/api/v1/secrets/${uuid}/versions`);

/** `GET /v1/secrets/{uuid}/content` (a side-effect GET: own secrets only; the guard refuses a pre-existing one). */
export async function readOwnSecretContent(api: GuardedApi, secret: OwnRef): Promise<Json> {
    await assertOwnLive(api, 'secrets', secret, 'platformApi.readOwnSecretContent');
    return apiJson<Json>(api, 'GET', `/api/v1/secrets/${secret.uuid}/content`);
}

/** Every string value in a JSON document (for "the value never appears in list / detail responses"). */
export function stringValues(doc: unknown, out: string[] = []): string[] {
    if (typeof doc === 'string') out.push(doc);
    else if (Array.isArray(doc)) doc.forEach((v) => stringValues(v, out));
    else if (doc && typeof doc === 'object') Object.values(doc as Json).forEach((v) => stringValues(v, out));
    return out;
}

// ------------------------------------------------------------------ compliance (REG-COMP-03)

/** `POST /v2/complianceProfiles`: an own compliance profile without rules (recorded as `complianceProfiles`). */
export async function createOwnComplianceProfile(api: GuardedApi, suffix: string, spec: string): Promise<OwnRef> {
    const name = regName(suffix);
    const created = await apiJson<Json>(api, 'POST', '/api/v2/complianceProfiles', {
        name,
        description: `REG run ${RUN_ID}`,
        customAttributes: await requiredCustomAttributesOf(api, 'complianceProfiles', regName('ca')),
    });
    return recordCreated('complianceProfiles', { uuid: String(created.uuid), name }, spec, 'own compliance profile');
}

/** The provider rules offered for a resource (`GET /v2/complianceProfiles/rules`), optionally narrowed by connector. */
export async function listProviderRules(api: APIRequestContext, query: { connectorUuid?: string; kind?: string; resource?: string } = {}): Promise<Json[]> {
    const q = Object.entries(query).filter(([, v]) => v).map(([k, v]) => `${k}=${encodeURIComponent(String(v))}`).join('&');
    return apiJson<Json[]>(api, 'GET', `/api/v2/complianceProfiles/rules${q ? `?${q}` : ''}`);
}

/**
 * `PATCH /v2/complianceProfiles/{own}/rules`: add (or remove) one provider rule with its attributes. `ruleUuid` names a
 * compliance PROVIDER rule (a catalogue entry): waived on an own profile by the guard (platform G-2, ROUTE_FIELD_WAIVERS).
 * The raw response.
 */
export async function patchOwnComplianceRule(api: GuardedApi, profile: OwnRef, rule: { ruleUuid: string; connectorUuid: string; kind: string }, attributes: Json[], removal = false): Promise<APIResponse> {
    await assertOwnLive(api, 'complianceProfiles', profile, 'platformApi.patchOwnComplianceRule');
    return api.patch(`/api/v2/complianceProfiles/${profile.uuid}/rules`, { data: { removal, ruleUuid: rule.ruleUuid, connectorUuid: rule.connectorUuid, kind: rule.kind, attributes } });
}

/** `PATCH /v2/complianceProfiles/{own}/associations/{resource}/{own object}` (an own RA profile). */
export async function associateOwnComplianceProfile(api: GuardedApi, profile: OwnRef, resource: 'raProfiles', object: OwnRef): Promise<APIResponse> {
    await assertOwnLive(api, 'complianceProfiles', profile, 'platformApi.associateOwnComplianceProfile');
    return api.patch(`/api/v2/complianceProfiles/${profile.uuid}/associations/${resource}/${object.uuid}`);
}

/** `POST /v2/compliance/certificates/{own certificate}` (re-evaluate one own object), then its `GET` result. */
export async function checkOwnCertificateCompliance(api: GuardedApi, certificate: OwnRef): Promise<Json> {
    await assertOwnLive(api, 'certificates', certificate, 'platformApi.checkOwnCertificateCompliance');
    const res = await api.post(`/api/v2/compliance/certificates/${certificate.uuid}`);
    if (!res.ok()) throw new Error(`POST /v2/compliance/certificates/{uuid} answered ${res.status()} ${(await res.text()).slice(0, 300)}`);
    return apiJson<Json>(api, 'GET', `/api/v2/compliance/certificates/${certificate.uuid}`);
}

/** The overall status code of a compliance result document (`status` / `complianceStatus`), lower case. */
export const overallComplianceStatus = (result: Json): string | undefined => {
    const s = result?.status ?? result?.complianceStatus ?? result?.overallStatus;
    return typeof s === 'string' ? s.toLowerCase() : undefined;
};

/** P-COMP (A4 r17): nok if any rule is nok, na if no rule applies, else ok — the expected overall status of rule results. */
export function expectedOverallStatus(ruleStatuses: readonly string[]): 'ok' | 'nok' | 'na' {
    const s = ruleStatuses.map((x) => x.toLowerCase());
    if (s.some((x) => x === 'nok')) return 'nok';
    if (s.length === 0 || s.every((x) => x === 'na')) return 'na';
    return 'ok';
}

// ------------------------------------------------------------------ ensure chains (RunState)

/** The run's vault instance (own when the tier has a secret-interface connector; recorded; idempotent per run). */
export async function ensureOwnVaultInstance(api: GuardedApi, spec: string, env: NodeJS.ProcessEnv = process.env): Promise<OwnRef | { skip: string }> {
    const state = readState();
    if (state.vaultInstance) return state.vaultInstance;
    const connector = await findConnectorWithInterface(api, /^secret/i, env, 'REG_SECRET_CONNECTOR');
    if (!connector) return { skip: 'no connected connector with a secret interface is registered on this tier (REG_SECRET_CONNECTOR)' };
    let vault: OwnRef & { detail: Json };
    try {
        vault = await createOwnVaultInstance(api, connector, `vault-${Date.now().toString(36)}`, spec);
    } catch (e) {
        // A refusal of the create (connector / core validation of the tier's vault settings) is an environment gate, never red:
        // the caller falls back to a pre-existing vault instance (R6-4) or skips with this reason.
        return { skip: `own vault instance refused on ${connector.name}: ${String(e instanceof Error ? e.message : e).slice(0, 200)}` };
    }
    const ref: OwnRef = { uuid: vault.uuid, name: vault.name, kind: 'own' };
    updateState({ vaultInstance: ref });
    return ref;
}

/** The run's vault profile under the run's vault (or, R6-4, under the first pre-existing vault when the run has none). */
export async function ensureOwnVaultProfile(api: GuardedApi, spec: string): Promise<{ vault: Ref; profile: OwnRef } | { skip: string }> {
    const state = readState();
    let vault: Ref | undefined = state.vaultInstance;
    if (!vault) {
        const own = await ensureOwnVaultInstance(api, spec);
        if (!('skip' in own)) vault = own;
        else {
            const existing = (await listVaultInstances(api))[0];
            if (!existing) return { skip: `${own.skip}; and no pre-existing vault instance to create the profile under` };
            vault = { uuid: String(existing.uuid), name: String(existing.name) };
            logger.info('vault profile goes under a pre-existing vault instance (R6-4: create under a pre-existing parent)');
        }
    }
    if (state.vaultProfile) return { vault, profile: state.vaultProfile };
    const profile = await createOwnVaultProfile(api, vault, `vp-${Date.now().toString(36)}`, spec);
    const ref: OwnRef = { uuid: profile.uuid, name: profile.name, kind: 'own' };
    updateState({ vaultProfile: ref });
    return { vault, profile: ref };
}

// ------------------------------------------------------------------ teardown handlers (registry module `platformApi`)

const parent = (line: { parents?: Record<string, string | string[]> }, key: string): string | undefined => {
    const v = line.parents?.[key];
    return Array.isArray(v) ? v[0] : v;
};

export const teardownHandlers: Record<string, TeardownHandler> = {
    secrets: {
        action: 'delete (DELETE /secrets/{uuid}), absence proven by GET /secrets/{uuid}',
        async remove(ctx, line) {
            await deleteVerified(ctx, { uuid: line.uuid, what: `secret ${line.uuid}`, detailUrl: `/api/v1/secrets/${line.uuid}` });
        },
    },
    vaultProfiles: {
        action: 'delete (DELETE /vaults/{vault}/vaultProfiles/{uuid}), absence proven by the same detail URL',
        async remove(ctx, line) {
            const vault = parent(line, 'vault') ?? ctx.live?.vaultInstanceUuid ?? ctx.live?.vaultUuid;
            if (!vault) throw new Error(`vault profile ${line.uuid}: no vault known (ledger parents or detail)`);
            await deleteVerified(ctx, { uuid: line.uuid, what: `vault profile ${line.uuid}`, detailUrl: `/api/v1/vaults/${vault}/vaultProfiles/${line.uuid}` });
        },
    },
    vaultInstances: {
        action: 'delete (DELETE /vaults/{uuid}), absence proven by GET /vaults/{uuid}',
        async remove(ctx, line) {
            await deleteVerified(ctx, { uuid: line.uuid, what: `vault instance ${line.uuid}`, detailUrl: `/api/v1/vaults/${line.uuid}` });
        },
    },
    complianceProfiles: {
        action: 'read associations, remove the own RA profiles\' associations (DELETE /v2/complianceProfiles/{uuid}/associations/raProfiles/{ra}), DELETE /v1/complianceProfiles/{uuid}; on a refusal DELETE /v2/complianceProfiles/force [uuid] (BulkActionMessageDto list checked); absence by GET /v1/complianceProfiles/{uuid}',
        async remove(ctx, line) {
            await removeComplianceProfile(ctx, line.uuid);
        },
    },
    locations: {
        action: 'delete (DELETE /entities/{entity}/locations/{uuid}), absence proven by the same detail URL',
        async remove(ctx, line) {
            const entity = parent(line, 'entity') ?? ctx.live?.entityInstanceUuid;
            if (!entity) throw new Error(`location ${line.uuid}: no entity known (ledger parents or detail)`);
            await deleteVerified(ctx, { uuid: line.uuid, what: `location ${line.uuid}`, detailUrl: `/api/v1/entities/${entity}/locations/${line.uuid}` });
        },
    },
    entities: {
        action: 'delete (DELETE /entities/{uuid}), absence proven by GET /entities/{uuid}',
        async remove(ctx, line) {
            await deleteVerified(ctx, { uuid: line.uuid, what: `entity ${line.uuid}`, detailUrl: `/api/v1/entities/${line.uuid}` });
        },
    },
};
