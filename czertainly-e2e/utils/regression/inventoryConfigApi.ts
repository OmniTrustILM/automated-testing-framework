/**
 * inventoryConfigApi — credential, group, own-certificate and RA-profile-probe helpers of the configuration-resources
 * pack (ilm#424 batches B2 / B3: API-GEN-17 credentials, secrets and immutability, API-GEN-18 credential validation
 * matrix, API-GEN-19 groups, API-GEN-20 group assignment, API-GEN-28 RA profile required attribute, API leg).
 *
 * Why this module exists: `apiJson` throws on every non-2xx answer, and these specs need the STATUS and the raw BODY of
 * refusals (spec-authoring hard rule 8). `send` (inventoryApi.ts) never throws on a status; the helpers here wrap it for the
 * create / change calls of the pack and keep the ledger rule: every object a call CREATED is recorded in the ledger right
 * after the call and BEFORE any assertion, also when a refusal was expected (an accidental 2xx must not leak).
 *
 * Safety (decision Q1, deny by default): every function that can send a non-GET takes a `GuardedApi` (the `api`
 * fixture); nothing here goes around the guard. What the pack sends, and why the guard lets it through:
 *   - `POST /v1/credentials`, `POST /v1/groups`, `POST /v1/certificates/upload`, `POST /v1/authorities/{a}/raProfiles`:
 *     allow-listed creates (guardedApi POST_CREATE); `connectorUuid` is a waived REFERENCE field, the authority is a scope
 *     parent; the attribute subtrees are not scanned for uuids;
 *   - `PUT /v1/credentials/{own}`, `PATCH /v1/credentials/{own}/enable|disable`, `PUT /v1/groups/{own}`, `PATCH
 *     /v1/certificates/{own}` (`groupUuids` -> own groups, `ownerUuid` -> own users, probe uuids for the unknown arms),
 *     `PATCH /v1/certificates/{own}/archive`: own-uuid mutations;
 *   - `DELETE /v1/credentials`, `DELETE /v1/groups` with `[own, probe]`: bulk routes with an explicit own-uuid list.
 * The pure parts (attribute builders, history parser, secret scan, authority arms) are unit-tested without an environment
 * (tests/unit/inventory-config-pure.spec.ts); the wire (every request shape through the guard, on a loopback fake core)
 * in tests/unit/inventory-config-wire.spec.ts.
 *
 * Secrets: the password a test sends is `randomSecret()` (node:crypto, per call), never a literal; `containsSecret` finds
 * it in the text of a body.
 */
import type { APIRequestContext } from '@playwright/test';
import * as crypto from 'crypto';
import { requestVersion } from './attributeVersion';
import { describeHealth, findConnector, healthByVersion, requiredConnectors } from './connectorApi';
import { requireGuarded } from './guardedApi';
import type { GuardedApi } from './guardedApi';
import { okJson, readProbe, send } from './inventoryApi';
import type { Json, Probe } from './inventoryApi';
import { ownership } from './ownObjects';
import { selfSignedPem } from './pki';
import { apiJsonWithDate, recordDerivedKeyOf, requiredCustomAttributes, toRequestAttribute } from './regressionApi';
import { createdAfterFrom, recordCreated, regName } from './regressionRun';
import type { OwnRef } from './regressionRun';
import { hasRunFamilyPrefix } from './runId';

// ------------------------------------------------------------------ names and secrets

let stampSeq = 0;

/**
 * A short unique stamp for names (`--repeat-each` safe): time in base 36, a per-process counter (two calls in one millisecond
 * differ) and 4 random hex digits (two processes in one millisecond differ).
 */
export const stamp = (): string => `${Date.now().toString(36)}${(stampSeq++ % 1296).toString(36).padStart(2, '0')}${crypto.randomBytes(2).toString('hex')}`;

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

/** The label core prints in "Required attribute <label> not found." (the definition's properties.label, else label, else name). */
export const labelOf = (def: Json): string => String(def?.properties?.label ?? def?.label ?? def?.name ?? '');

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

// ------------------------------------------------------------------ required custom attributes (credentials, groups)

/**
 * Values for the REQUIRED custom attributes a tier defines on `credentials` / `groups` (a create or edit without them
 * answers 422 on such a tier, and core checks them BEFORE the connector, so a negative row that does not supply them
 * would be refused for another reason). Delegates to regressionApi `requiredCustomAttributes` (the ONE filler).
 */
export async function requiredCustomFor(api: APIRequestContext, resource: 'credentials' | 'groups', value: string): Promise<Json[]> {
    return requiredCustomAttributes(api, resource, value);
}

// ------------------------------------------------------------------ list reads by exact name

/** The rows of a list endpoint whose `name` is exactly `name` (the list answers every object; a non-200 or a non-array throws). */
export async function rowsNamed(api: APIRequestContext, listUrl: '/api/v1/credentials' | '/api/v1/groups' | '/api/v1/raProfiles', name: string): Promise<Json[]> {
    const rows = okJson<Json[]>(await readProbe(api, listUrl), `GET ${listUrl}`);
    if (!Array.isArray(rows)) throw new Error(`GET ${listUrl} did not answer a list`);
    return rows.filter((r) => r?.name === name);
}

/** The row of a list endpoint with this uuid, or undefined. */
export async function rowOf(api: APIRequestContext, listUrl: '/api/v1/credentials' | '/api/v1/groups', uuid: string): Promise<Json | undefined> {
    const rows = okJson<Json[]>(await readProbe(api, listUrl), `GET ${listUrl}`);
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
        if (typeof r.uuid === 'string' && !ownership({ uuid: r.uuid }).own) recordCreated(type, { uuid: r.uuid, name }, spec, note, parents);
    }
    return rows;
}

/** The own object kinds the pack deletes as the behaviour under test. */
export type DeletableKind = 'credentials' | 'groups';

/** `DELETE /v1/credentials|groups/{own}` (204 expected): status and body never throw. */
export async function deleteOwnObject(api: GuardedApi, kind: DeletableKind, uuid: string): Promise<Probe> {
    return send(requireGuarded(api, 'deleteOwnObject'), 'DELETE', `/api/v1/${kind}/${uuid}`);
}

/** Bulk `DELETE /v1/credentials|groups` with an explicit uuid list (own uuids and probe uuids); unknown ones are skipped by core. */
export async function bulkDeleteObjects(api: GuardedApi, kind: DeletableKind, uuids: string[]): Promise<Probe> {
    return send(requireGuarded(api, 'bulkDeleteObjects'), 'DELETE', `/api/v1/${kind}`, { data: uuids });
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

async function createAttempt(api: GuardedApi, url: string, type: string, body: Json, spec: string, note: string, parents?: Record<string, string>): Promise<CreateAttempt> {
    const probe = await send(requireGuarded(api, `inventoryConfigApi POST ${type}`), 'POST', url, { data: body });
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
    const name = regName(`${opts.suffix ?? 'cred'}-${stamp()}`);
    const username = opts.username ?? regName(`cu-${stamp()}`);
    const password = opts.password ?? randomSecret();
    const body = credentialBody(c, name, basicAttributes(c, { username, password }), await requiredCustomFor(api, 'credentials', regName('ca')));
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
    return send(requireGuarded(api, 'putCredential'), 'PUT', `/api/v1/credentials/${uuid}`, { data: { attributes, customAttributes, ...over } });
}

/** `PATCH /v1/credentials/{own}/enable|disable`. */
export async function setCredentialEnabled(api: GuardedApi, uuid: string, enabled: boolean): Promise<Probe> {
    return send(requireGuarded(api, 'setCredentialEnabled'), 'PATCH', `/api/v1/credentials/${uuid}/${enabled ? 'enable' : 'disable'}`);
}

// ------------------------------------------------------------------ groups

export interface GroupFields {
    description?: string | null;
    email?: string | null;
    customAttributes?: Json[];
}

/** A `POST /v1/groups` body (`name` may be anything: the negative rows send blank, null and whitespace). */
export const groupBody = (name: unknown, fields: GroupFields = {}): Json => ({ name, ...fields });

/** `POST /v1/groups` with any body; the status never throws, an accepted create is in the ledger before this returns. */
export async function createGroupProbe(api: GuardedApi, body: Json, spec: string, note = 'group create probe'): Promise<CreateAttempt> {
    return createAttempt(api, '/api/v1/groups', 'groups', body, spec, note);
}

/** A NEW own group (201 required; ledger first; any required custom attribute of the tier filled). */
export async function ownGroup(api: GuardedApi, spec: string, fields: GroupFields = {}, opts: { suffix?: string; note?: string } = {}): Promise<OwnRef & { description?: string | null; email?: string | null }> {
    const name = regName(`${opts.suffix ?? 'grp'}-${stamp()}`);
    const customAttributes = [...(await requiredCustomFor(api, 'groups', regName('ca'))), ...(fields.customAttributes ?? [])];
    const { probe, own } = await createGroupProbe(api, groupBody(name, { ...fields, customAttributes }), spec, opts.note ?? 'own group (API prerequisite)');
    if (probe.status !== 201 || !own) throw new Error(`creating the own group answered ${probe.status} ${probe.text.slice(0, 300)}`);
    return { ...own, description: fields.description, email: fields.email };
}

/** `PUT /v1/groups/{own}` (the body is whatever the row sends: the `name` is ignored by core, omitted members are cleared). */
export async function putGroup(api: GuardedApi, uuid: string, body: Json): Promise<Probe> {
    return send(requireGuarded(api, 'putGroup'), 'PUT', `/api/v1/groups/${uuid}`, { data: body });
}

/** `GET /v1/groups/{uuid}` (status and body never throw). */
export const readGroup = (api: APIRequestContext, uuid: string): Promise<Probe> => readProbe(api, `/api/v1/groups/${uuid}`);

export interface OwnAttribute {
    ref: OwnRef;
    name: string;
    uuid: string;
}

/** An own, NOT required string custom attribute on groups (the "omitted custom attributes lose their content" rows); ledger first. */
export async function ownGroupAttribute(api: GuardedApi, spec: string): Promise<OwnAttribute> {
    const name = regName(`grp-attr-${stamp()}`);
    const probe = await send(requireGuarded(api, 'ownGroupAttribute'), 'POST', '/api/v1/attributes/custom', {
        data: {
            name, label: `Group attribute ${stamp()}`, description: 'own, not required (API-GEN-19)', contentType: 'string', required: false,
            visible: true, readOnly: false, list: false, multiSelect: false, resources: ['groups'],
        },
    });
    const uuid = createdUuid(probe);
    const ref = uuid ? recordCreated('customAttributes', { uuid, name }, spec, 'own custom attribute on groups, not required') : undefined;
    if (!ref || !uuid) throw new Error(`creating the own custom attribute answered ${probe.status} ${probe.text.slice(0, 300)}`);
    return { ref, name, uuid };
}

/** The request attribute that sets a string custom attribute to `value`. */
export const customValue = (a: Pick<OwnAttribute, 'uuid' | 'name'>, value: string): Json => ({ uuid: a.uuid, name: a.name, contentType: 'string', content: [{ data: value }] });

/** The data values a response attribute (custom or data) holds, in order; [] when it is missing or has no content. */
export const valuesOf = (detail: Json | undefined, key: 'customAttributes' | 'attributes', name: string): unknown[] => {
    const list = Array.isArray(detail?.[key]) ? (detail![key] as Json[]) : [];
    const attribute = list.find((a) => a?.name === name);
    return (Array.isArray(attribute?.content) ? (attribute!.content as Json[]) : []).map((c) => c?.data);
};

// ------------------------------------------------------------------ own certificates, groups on certificates, history

export interface OwnCertificate extends OwnRef {
    commonName: string;
}

/**
 * A NEW own self-signed certificate (RSA-2048, 30 days) uploaded through `POST /v1/certificates/upload`: ledger right after
 * the call (before any other read), then the key the platform linked to it as a DERIVED ledger object with a server-clock
 * `createdAfter` (recordDerivedKeyOf). Any required custom attribute of certificates is filled.
 */
export async function ownCertificate(api: GuardedApi, spec: string, suffix = 'cert'): Promise<OwnCertificate> {
    const commonName = regName(`${suffix}-${stamp()}`);
    const { pem } = selfSignedPem(commonName);
    const customAttributes = await requiredCustomAttributes(api, 'certificates', regName('ca'));
    const { body, serverAt, elapsedMs } = await apiJsonWithDate<Json>(api, 'POST', '/api/v1/certificates/upload', { certificate: Buffer.from(pem).toString('base64'), customAttributes });
    const own = recordCreated('certificates', { uuid: body.uuid, name: commonName }, spec, 'own self-signed upload (API prerequisite)');
    await recordDerivedKeyOf(api, body.uuid, serverAt ? createdAfterFrom(serverAt, elapsedMs) : undefined, spec);
    return { ...own, commonName };
}

/** `GET /v1/certificates/{uuid}` as JSON (a non-200 throws). */
export async function certificateDetail(api: APIRequestContext, uuid: string): Promise<Json> {
    return okJson<Json>(await readProbe(api, `/api/v1/certificates/${uuid}`), `GET certificate ${uuid}`);
}

/** The uuids of the groups of a certificate detail, sorted. */
export const groupUuidsOf = (detail: Json): string[] => (Array.isArray(detail.groups) ? (detail.groups as Json[]).map((g) => String(g.uuid)).sort() : []);

/** `PATCH /v1/certificates/{own}` with any body (`groupUuids`, `ownerUuid`, or `{}`); status and body never throw. */
export async function patchCertificate(api: GuardedApi, uuid: string, body: Json): Promise<Probe> {
    return send(requireGuarded(api, 'patchCertificate'), 'PATCH', `/api/v1/certificates/${uuid}`, { data: body });
}

/** Sets the groups of an own certificate and requires 204 (a prerequisite step, not the behaviour under test). */
export async function setGroups(api: GuardedApi, certificateUuid: string, groupUuids: string[]): Promise<void> {
    const p = await patchCertificate(api, certificateUuid, { groupUuids });
    if (p.status !== 204) throw new Error(`setting the groups answered ${p.status} ${p.text.slice(0, 300)}`);
}

/** `PATCH /v1/certificates/{own}/archive`; requires 204 (the archived certificate is the precondition of its row). */
export async function archiveOwnCertificate(api: GuardedApi, uuid: string): Promise<void> {
    const p = await send(requireGuarded(api, 'archiveOwnCertificate'), 'PATCH', `/api/v1/certificates/${uuid}/archive`);
    if (p.status !== 204) throw new Error(`archiving the own certificate answered ${p.status} ${p.text.slice(0, 300)}`);
}

/** `GET /v1/certificates/{uuid}/history` (a non-200 throws). */
export async function certificateHistory(api: APIRequestContext, uuid: string): Promise<Json[]> {
    const events = okJson<Json[]>(await readProbe(api, `/api/v1/certificates/${uuid}/history`), `GET certificate history ${uuid}`);
    if (!Array.isArray(events)) throw new Error('the certificate history is not a list');
    return events;
}

/** The event code of a group change in the history (CertificateEvent.UPDATE_GROUP code). */
export const GROUP_EVENT = 'Update Group';

export interface GroupChange {
    /** The group names before and after, sorted; 'undefined' (no group) is the empty list. */
    from: string[];
    to: string[];
}

/**
 * The text core writes into the history for a group change (CertificateServiceImpl.updateCertificateGroups): `<old> -> <new>`,
 * each side the group names joined with ", " in no defined order, or `undefined` when there is none. Names are compared as
 * sorted sets. A message without " -> " is not a group change.
 */
export function parseGroupChange(message: string): GroupChange | undefined {
    const i = message.indexOf(' -> ');
    if (i < 0) return undefined;
    const side = (s: string): string[] => (s === 'undefined' ? [] : s.split(', ').filter(Boolean).sort());
    return { from: side(message.slice(0, i)), to: side(message.slice(i + 4)) };
}

/** The group changes in a history, as `from -> to` pairs (successful `Update Group` events only), in the order given. */
export function groupChanges(events: Json[]): GroupChange[] {
    return events
        .filter((e) => e?.event === GROUP_EVENT && e?.status === 'SUCCESS' && typeof e?.message === 'string')
        .map((e) => parseGroupChange(String(e.message)))
        .filter((c): c is GroupChange => !!c);
}

/** A group change as one comparable string (`a, b -> c`, `undefined` for none), names sorted. */
export const changeKey = (c: GroupChange): string => `${c.from.length ? c.from.join(', ') : 'undefined'} -> ${c.to.length ? c.to.join(', ') : 'undefined'}`;

/** How many `Update Group` events a certificate's history holds. */
export const groupEventCount = (events: Json[]): number => events.filter((e) => e?.event === GROUP_EVENT).length;

// ------------------------------------------------------------------ connectors without the credential function group

/**
 * A pre-existing connector that has function groups but not `credentialProvider` (API-GEN-18 [connector-no-credential-group]),
 * the first by name; undefined when there is none. Reads `GET /v1/connectors` only; run-family names are skipped.
 */
export async function connectorWithoutCredentialGroup(api: APIRequestContext): Promise<{ uuid: string; name: string } | undefined> {
    const rows = okJson<Json[]>(await readProbe(api, '/api/v1/connectors'), 'GET /v1/connectors');
    const sorted = (Array.isArray(rows) ? rows : []).filter((r) => typeof r?.uuid === 'string' && !hasRunFamilyPrefix(String(r.name))).sort((a, b) => (String(a.name) < String(b.name) ? -1 : 1));
    const hit = sorted.find((r) => Array.isArray(r.functionGroups) && r.functionGroups.length > 0 && !r.functionGroups.some((g: Json) => g?.functionGroupCode === 'credentialProvider'));
    return hit ? { uuid: String(hit.uuid), name: String(hit.name) } : undefined;
}

// ------------------------------------------------------------------ RA profile with a required attribute (API-GEN-28)

/** The attribute versions the request side knows: a definition's version (2 / 'v2' / 3 / 'v3') as a request attribute `version`. */
export { requestVersion };

/** "Required attribute <label> not found." (AttributeDefinitionUtils:388): the attribute is not in the request. */
export const requiredNotFound = (label: string): string => `Required attribute ${label} not found.`;

/** "Value of required attribute <label> not set." (AttributeDefinitionUtils:397): the attribute is listed without content. */
export const requiredNotSet = (label: string): string => `Value of required attribute ${label} not set.`;

/** The base attributes without the target attribute: the required one is MISSING from the request. */
export const missingArm = (base: readonly Json[], def: Json): Json[] => base.filter((a) => a?.name !== def.name);

/** The base attributes with the target listed WITHOUT content: the required one is EMPTY. */
export const emptyArm = (base: readonly Json[], def: Json): Json[] => [
    ...missingArm(base, def),
    { version: requestVersion(def), uuid: def.uuid, name: def.name, contentType: String(def.contentType).toLowerCase() },
];

export interface RaAuthority {
    uuid: string;
    connectorName: string;
    /** The required data attributes of the authority's RA-profile schema. */
    required: Json[];
}

/**
 * The first CONNECTED pre-existing authority (by name) whose RA-profile attribute schema
 * (`GET /v1/authorities/{uuid}/attributes/raProfile`, read-only) holds a required data attribute, or the named reason there
 * is none (never creates an authority). At most `max` authorities are read.
 */
export async function authorityWithRequiredAttribute(api: APIRequestContext, max = 8): Promise<{ ok: RaAuthority; skip?: undefined } | { ok?: undefined; skip: string }> {
    const rows = okJson<Json[]>(await readProbe(api, '/api/v1/authorities'), 'GET /v1/authorities');
    const candidates = (Array.isArray(rows) ? rows : [])
        .filter((a) => typeof a?.uuid === 'string' && a.status === 'connected' && !hasRunFamilyPrefix(String(a.name)))
        .sort((a, b) => (String(a.name) < String(b.name) ? -1 : String(a.name) > String(b.name) ? 1 : 0));
    const reasons: string[] = [];
    for (const a of candidates.slice(0, max)) {
        const read = await readProbe(api, `/api/v1/authorities/${a.uuid}/attributes/raProfile`);
        const connectorName = String(a.connectorName ?? '?');
        if (read.status !== 200 || !Array.isArray(read.json)) {
            reasons.push(`${connectorName}: the RA-profile attribute read answered ${read.status}`);
            continue;
        }
        const required = (read.json as Json[]).filter((d) => (!d.type || d.type === 'data') && d.properties?.required === true);
        if (required.length) return { ok: { uuid: String(a.uuid), connectorName, required } };
        reasons.push(`${connectorName}: no required RA-profile attribute`);
    }
    return { skip: `no connected pre-existing authority whose RA-profile schema holds a required attribute (${candidates.length ? reasons.join('; ') : 'no connected authority'}); the suite never creates an authority` };
}

/**
 * Valid RA-profile attributes for an authority, COPIED read-only from an enabled pre-existing RA profile there (the first by
 * name), as request attributes; undefined when the authority has no such RA profile (the arms then start from nothing).
 */
export async function validRaAttributes(api: APIRequestContext, authorityUuid: string): Promise<Json[] | undefined> {
    const all = okJson<Json[]>(await readProbe(api, '/api/v1/raProfiles'), 'GET /v1/raProfiles');
    const source = (Array.isArray(all) ? all : [])
        .filter((r) => r?.authorityInstanceUuid === authorityUuid && r.enabled === true && !hasRunFamilyPrefix(String(r.name)))
        .sort((a, b) => (String(a.name) < String(b.name) ? -1 : String(a.name) > String(b.name) ? 1 : 0))[0];
    if (!source) return undefined;
    const detail = okJson<Json>(await readProbe(api, `/api/v1/authorities/${authorityUuid}/raProfiles/${source.uuid}`), 'GET RA profile detail');
    const attributes = (Array.isArray(detail?.attributes) ? (detail.attributes as Json[]) : []).filter((a) => !a.type || a.type === 'data').map(toRequestAttribute);
    return attributes.length ? attributes : undefined;
}

/** A `POST /v1/authorities/{a}/raProfiles` body: the attributes under test plus the custom attributes the tier requires (core checks them first). */
export async function raProfileBody(api: APIRequestContext, name: string, attributes: Json[]): Promise<Json> {
    return { name, description: 'API-GEN-28 required-attribute probe', attributes, customAttributes: await requiredCustomAttributes(api, 'raProfiles', regName('ca')) };
}

/** `POST /v1/authorities/{authority}/raProfiles` (the authority is a scope parent); an accepted create is in the ledger before this returns. */
export async function createRaProfileProbe(api: GuardedApi, authorityUuid: string, body: Json, spec: string, note = 'RA profile create probe'): Promise<CreateAttempt> {
    return createAttempt(api, `/api/v1/authorities/${authorityUuid}/raProfiles`, 'raProfiles', body, spec, note, { authority: authorityUuid });
}

/** `POST /v1/authorities/{authority}/attributes/raProfile/validate` (a read-only validation POST): status and body never throw. */
export async function validateRaAttributes(api: GuardedApi, authorityUuid: string, attributes: Json[]): Promise<Probe> {
    return send(requireGuarded(api, 'validateRaAttributes'), 'POST', `/api/v1/authorities/${authorityUuid}/attributes/raProfile/validate`, { data: attributes });
}
