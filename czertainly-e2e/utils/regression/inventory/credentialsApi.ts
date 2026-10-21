/**
 * Credential helpers of the configuration-resources API specs (credential-secrets, credential-validation): the Basic
 * attribute builders, own credentials, create probes that record an accepted create in the ledger before any assertion,
 * and the secret scan. Every call that can send a non-GET takes the guarded `api` fixture.
 * Secrets: a test password is `randomSecret()` (node:crypto, per call), never a literal.
 */
import type { APIRequestContext } from '@playwright/test';
import * as crypto from 'crypto';
import { describeHealth, findConnector, healthByVersion, requiredConnectors } from '../platform/connectorApi';
import { assertGuarded } from '../guard/types';
import type { GuardedApi } from '../guard/types';
import { readJsonOk, readProbe, send } from './searchApi';
import type { Json, Probe } from './searchApi';
import { checkOwnership } from '../ledger/ownership';
import { rowsNamed } from '../listReads';
import { requiredCustomAttributes } from '../customAttributes';
import { recordCreated } from '../ledger/ledger';
import { runName } from '../ledger/runState';
import { uniqueStamp } from '../text';
import type { OwnRef } from '../ledger/ledger';
import { hasRunFamilyPrefix } from '../run/runId';

// ------------------------------------------------------------------ names and secrets

/** A fresh random password for one credential (per call, never a literal secret). Alphabet `[A-Za-z0-9_-]`: no JSON escape applies. */
export const randomSecret = (): string => `qa-${crypto.randomBytes(12).toString('base64url')}`;

/** True when `secret` occurs in `text` (the whole raw text of a response body). An empty secret never counts. */
export const containsSecret = (text: string, secret: string): boolean => secret.length > 0 && text.includes(secret);

// ------------------------------------------------------------------ the credential connector and its Basic kind

export interface CredentialConnector {
    uuid: string;
    name: string;
    /** The Basic kind's `username` / `password` attribute definitions (read live from the connector through core). */
    usernameDef: Json;
    passwordDef: Json;
}

/** The registration name of the credential connector: REG_CREDENTIAL_CONNECTOR, else the credential entry of the required connectors. */
export function credentialConnectorName(env: NodeJS.ProcessEnv = process.env): string {
    const named = env.REG_CREDENTIAL_CONNECTOR?.trim();
    if (named) return named;
    return requiredConnectors(env).find((n) => /credential/i.test(n)) ?? 'Common-Credential-Connector';
}

/** The Basic definitions inside the connector's attribute list for kind Basic, or the reason they are not usable. */
export function basicDefinitions(list: unknown): { usernameDef: Json; passwordDef: Json } | { problem: string } {
    if (!Array.isArray(list)) return { problem: 'the Basic attribute list is not an array' };
    const defs = (list as Json[]).filter((a) => !a.type || a.type === 'data');
    const usernameDef = defs.find((a) => a.name === 'username');
    const passwordDef = defs.find((a) => a.name === 'password');
    if (!usernameDef || !passwordDef) return { problem: 'the Basic kind has no username / password data attributes' };
    if (typeof usernameDef.uuid !== 'string' || typeof passwordDef.uuid !== 'string') return { problem: 'a Basic attribute definition carries no uuid' };
    if (String(passwordDef.contentType).toLowerCase() !== 'secret') return { problem: `the Basic password attribute has content type ${String(passwordDef.contentType)}, not secret` };
    return { usernameDef, passwordDef };
}

/**
 * The credential connector, live and with its Basic definitions; `skip` names the reason when the tier cannot run the
 * credential rows (not registered, not healthy, no Basic kind). Reads only (GET through core: connector list, live health,
 * the connector's attribute definitions).
 */
export async function credentialSetup(api: APIRequestContext, env: NodeJS.ProcessEnv = process.env): Promise<{ ok: CredentialConnector; skip?: undefined } | { ok?: undefined; skip: string }> {
    const name = credentialConnectorName(env);
    const connector = await findConnector(api, name);
    if (!connector) return { skip: `connector ${name} is not registered on this tier (REG_CREDENTIAL_CONNECTOR names another one)` };
    const health = await healthByVersion(api, connector);
    if (!health.healthy) return { skip: `${describeHealth(health)} — environment blocker (the credential rows need a live connector)` };
    const read = await readProbe(api, `/api/v1/connectors/${connector.uuid}/attributes/credentialProvider/Basic`);
    if (read.status !== 200) return { skip: `${name}: the Basic attribute definitions read answered ${read.status}` };
    const defs = basicDefinitions(read.json);
    if ('problem' in defs) return { skip: `${name}: ${defs.problem}` };
    return { ok: { uuid: connector.uuid, name, ...defs } };
}

/**
 * The values of a Basic credential's attributes. `undefined` = the attribute is left out of the request; `null` = the
 * attribute is listed without content (core: "Value of required attribute <label> not set."); a string = its content
 * (the password as a secret `{ secret }`, the empty string included).
 */
export interface BasicValues {
    username?: string | null;
    password?: string | null;
}

/**
 * The request attributes of a Basic credential from the connector's definitions: `{ version, uuid, name, contentType,
 * content: [{ data }] }` (the current contract, NOT the legacy by-name shape). `withUuid: false` builds the by-name shape
 * that core#2512 reports (the credential row is saved before the attribute lookup fails).
 */
export function basicAttributes(c: Pick<CredentialConnector, 'usernameDef' | 'passwordDef'>, values: BasicValues, opts: { withUuid?: boolean } = {}): Json[] {
    const withUuid = opts.withUuid !== false;
    const one = (def: Json, value: string | null | undefined, wrap: (v: string) => unknown): Json[] => {
        if (value === undefined) return [];
        const attribute: Json = { version: 'v2', ...(withUuid ? { uuid: def.uuid } : {}), name: def.name, contentType: String(def.contentType).toLowerCase() };
        if (value !== null) attribute.content = [{ data: wrap(value) }];
        return [attribute];
    };
    return [...one(c.usernameDef, values.username, (v) => v), ...one(c.passwordDef, values.password, (v) => ({ secret: v }))];
}

/** A `POST /v1/credentials` body; `over` replaces or (with `undefined`) drops any member, `null` sends it as null. */
export function credentialBody(c: Pick<CredentialConnector, 'uuid'>, name: unknown, attributes: Json[], customAttributes: Json[], over: Json = {}): Json {
    return { name, connectorUuid: c.uuid, kind: 'Basic', attributes, customAttributes, ...over };
}

// ------------------------------------------------------------------ list reads by exact name

/** The row of a list endpoint with this uuid, or undefined. */
export async function findRowByUuid(api: APIRequestContext, listUrl: '/api/v1/credentials' | '/api/v1/groups', uuid: string): Promise<Json | undefined> {
    const rows = readJsonOk<Json[]>(await readProbe(api, listUrl), `GET ${listUrl}`);
    if (!Array.isArray(rows)) throw new Error(`GET ${listUrl} did not answer a list`);
    return rows.find((r) => r?.uuid === uuid);
}

/**
 * Ledger for an object a REFUSED create left behind (core#2512: the credential row is saved before the attribute lookup
 * fails): every row of the list whose name is exactly `name` (a unique run-prefixed name only this request used) that is not
 * in the ledger yet is recorded as this run's, so the run-end teardown removes it. Returns the rows found (recorded now or
 * before).
 */
export async function adoptByName(
    api: APIRequestContext, listUrl: '/api/v1/credentials' | '/api/v1/groups' | '/api/v1/raProfiles', type: 'credentials' | 'groups' | 'raProfiles',
    name: string, spec: string, note: string, parents?: Record<string, string>,
): Promise<Json[]> {
    const rows = await rowsNamed(api, listUrl, name);
    for (const r of rows) {
        if (typeof r.uuid === 'string' && !checkOwnership({ uuid: r.uuid }).own) recordCreated(type, { uuid: r.uuid, name }, spec, note, parents);
    }
    return rows;
}

/** The own object kinds the pack deletes as the behaviour under test. */
export type DeletableKind = 'credentials' | 'groups';

/** `DELETE /v1/credentials|groups/{own}` (204 expected): status and body never throw. */
export async function deleteOwnConfigObject(api: GuardedApi, kind: DeletableKind, uuid: string): Promise<Probe> {
    return send(assertGuarded(api, 'deleteOwnConfigObject'), 'DELETE', `/api/v1/${kind}/${uuid}`);
}

/** Bulk `DELETE /v1/credentials|groups` with an explicit uuid list (own uuids and probe uuids); unknown ones are skipped by core. */
export async function bulkDeleteObjects(api: GuardedApi, kind: DeletableKind, uuids: string[]): Promise<Probe> {
    return send(assertGuarded(api, 'bulkDeleteObjects'), 'DELETE', `/api/v1/${kind}`, { data: uuids });
}

/** `GET /v1/credentials|groups/{uuid}` (status and body never throw). */
export const readObject = (api: APIRequestContext, kind: DeletableKind, uuid: string): Promise<Probe> => readProbe(api, `/api/v1/${kind}/${uuid}`);

// ------------------------------------------------------------------ credentials

export interface CreateAttempt {
    probe: Probe;
    /** Present when the server created an object (2xx with a uuid): already in the ledger. */
    own?: OwnRef;
}

/** The uuid of a 2xx create answer (`{ "uuid": "<canonical>" }`), or undefined. */
export function createdUuid(p: Probe): string | undefined {
    const uuid = p.status >= 200 && p.status < 300 && p.json && typeof p.json === 'object' ? (p.json as Json).uuid : undefined;
    return typeof uuid === 'string' && /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(uuid) ? uuid : undefined;
}

export async function createAttempt(api: GuardedApi, url: string, type: string, body: Json, spec: string, note: string, parents?: Record<string, string>): Promise<CreateAttempt> {
    const probe = await send(assertGuarded(api, `credentialsApi POST ${type}`), 'POST', url, { data: body });
    const uuid = createdUuid(probe);
    // Ledger before assertion: an accepted create (also an accidental one) is the run's object. A name that is not a string
    // (a null / missing-name negative that was accepted) is recorded under a placeholder: it carries no run prefix, so the
    // run-end teardown reports it instead of deleting it.
    const own = uuid ? recordCreated(type, { uuid, name: typeof body.name === 'string' ? body.name : '(no name)' }, spec, note, parents) : undefined;
    return { probe, ...(own ? { own } : {}) };
}

/** `POST /v1/credentials` with any body; the status never throws, an accepted create is in the ledger before this returns. */
export async function createCredentialProbe(api: GuardedApi, body: Json, spec: string, note = 'credential create probe'): Promise<CreateAttempt> {
    return createAttempt(api, '/api/v1/credentials', 'credentials', body, spec, note);
}

export interface OwnCredential {
    ref: OwnRef;
    username: string;
    password: string;
    /** The raw text of the 201 answer (a secret must not be in it either). */
    createText: string;
}

/** A NEW own Basic credential (201 required; ledger first): run-prefixed unique name, a random username and password. */
export async function ownCredential(api: GuardedApi, c: CredentialConnector, spec: string, opts: { suffix?: string; username?: string; password?: string; note?: string } = {}): Promise<OwnCredential> {
    const name = runName(`${opts.suffix ?? 'cred'}-${uniqueStamp()}`);
    const username = opts.username ?? runName(`cu-${uniqueStamp()}`);
    const password = opts.password ?? randomSecret();
    const body = credentialBody(c, name, basicAttributes(c, { username, password }), await requiredCustomAttributes(api, 'credentials', runName('ca')));
    const { probe, own } = await createCredentialProbe(api, body, spec, opts.note ?? 'own Basic credential (API prerequisite)');
    if (probe.status !== 201 || !own) throw new Error(`creating the own credential answered ${probe.status} ${probe.text.slice(0, 300)}`);
    return { ref: own, username, password, createText: probe.text };
}

/** `GET /v1/credentials/{uuid}` (status and body never throw). */
export const readCredential = (api: APIRequestContext, uuid: string): Promise<Probe> => readProbe(api, `/api/v1/credentials/${uuid}`);

/** The attribute of a credential detail (or list row) by name, or undefined. */
export const attributeOf = (detail: Json | undefined, name: string): Json | undefined => (Array.isArray(detail?.attributes) ? (detail!.attributes as Json[]).find((a) => a?.name === name) : undefined);

/** Every content item of an attribute that carries a `data` member with a value (a masked secret has none). */
export const contentWithData = (attribute: Json | undefined): Json[] =>
    (Array.isArray(attribute?.content) ? (attribute!.content as Json[]) : []).filter((item) => item && item.data !== undefined && item.data !== null);

/** `PUT /v1/credentials/{own}` with attributes (and the custom attributes the tier requires); `over` adds members (e.g. an ignored `name`). */
export async function putCredential(api: GuardedApi, uuid: string, attributes: Json[], customAttributes: Json[], over: Json = {}): Promise<Probe> {
    return send(assertGuarded(api, 'putCredential'), 'PUT', `/api/v1/credentials/${uuid}`, { data: { attributes, customAttributes, ...over } });
}

/** `PATCH /v1/credentials/{own}/enable|disable`. */
export async function setCredentialEnabled(api: GuardedApi, uuid: string, enabled: boolean): Promise<Probe> {
    return send(assertGuarded(api, 'setCredentialEnabled'), 'PATCH', `/api/v1/credentials/${uuid}/${enabled ? 'enable' : 'disable'}`);
}

/** The data values a response attribute (custom or data) holds, in order; [] when it is missing or has no content. */
export const valuesOf = (detail: Json | undefined, key: 'customAttributes' | 'attributes', name: string): unknown[] => {
    const list = Array.isArray(detail?.[key]) ? (detail![key] as Json[]) : [];
    const attribute = list.find((a) => a?.name === name);
    return (Array.isArray(attribute?.content) ? (attribute!.content as Json[]) : []).map((c) => c?.data);
};

// ------------------------------------------------------------------ connectors without the credential function group

/**
 * A pre-existing connector that has function groups but not `credentialProvider` (API-GEN-18 [connector-no-credential-group]),
 * the first by name; undefined when there is none. Reads `GET /v1/connectors` only; run-family names are skipped.
 */
export async function connectorWithoutCredentialGroup(api: APIRequestContext): Promise<{ uuid: string; name: string } | undefined> {
    const rows = readJsonOk<Json[]>(await readProbe(api, '/api/v1/connectors'), 'GET /v1/connectors');
    const sorted = (Array.isArray(rows) ? rows : []).filter((r) => typeof r?.uuid === 'string' && !hasRunFamilyPrefix(String(r.name))).sort((a, b) => (String(a.name) < String(b.name) ? -1 : 1));
    const hit = sorted.find((r) => Array.isArray(r.functionGroups) && r.functionGroups.length > 0 && !r.functionGroups.some((g: Json) => g?.functionGroupCode === 'credentialProvider'));
    return hit ? { uuid: String(hit.uuid), name: String(hit.name) } : undefined;
}
