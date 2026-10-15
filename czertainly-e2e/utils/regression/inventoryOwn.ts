/**
 * inventoryOwn — create and change the run's OWN inventory objects (certificates, groups, custom attribute definitions),
 * for the seeds and the inventory-api specs. A separate module from regressionApi.ts (shared by six area agents); the
 * rules are the same (decision Q1 / D1, utils/regression/regressionApi.ts header):
 * - every helper that sends anything but a GET takes a `GuardedApi` (the `api` fixture): the guard judges every request
 *   (own uuids only, typed body fields: `groupUuids` -> own groups, `ownerUuid` -> own users);
 * - every create records the object in the ledger right after the call, BEFORE anything is asserted;
 * - every change calls `assertOwnLive` first (ledger line of this run + live run-prefixed name) on top of the guard.
 *
 * Uploads are SYNCHRONOUS (`POST /v1/certificates/upload` answers the uuid) so the seed's `created` order follows the
 * upload order and the default listing order (created descending) is reproducible (phase-03 §2.1 SEED-A).
 */
import type { GuardedApi } from './guardedApi';
import { requestVersion } from './attributeVersion';
import { apiJson, apiJsonWithDate, recordDerivedKeyOf, requiredCustomAttributes } from './regressionApi';
import { assertOwnLive } from './ownObjects';
import { createdAfterFrom, OwnRef, recordCreated, RUN_ID } from './regressionRun';
import type { BuiltCertificate } from './inventoryPki';
import { Probe, send } from './inventoryApi';

type Json = Record<string, any>;

/** The content types the seeds use for custom attributes (interfaces AttributeContentType codes). */
export type AttributeKind = 'string' | 'integer' | 'date' | 'boolean';

export interface AttributeDefinition {
    /** Run-prefixed name (`regName(...)`): identifies the definition in the catalogue as `<name>|<CONTENT_TYPE>`. */
    name: string;
    label: string;
    contentType: AttributeKind;
    /** A list attribute with predefined options (`pick`). */
    options?: string[];
    multiSelect?: boolean;
}

/**
 * `POST /v1/attributes/custom` for resource `certificates`, NEVER required (phase-03 §7: a required attribute would break
 * other users' forms), visible and writable; recorded in the ledger before anything else happens. Returns the ref and
 * the definition's uuid (= the ref's uuid).
 */
export async function createOwnAttribute(api: GuardedApi, spec: string, def: AttributeDefinition, note = 'seed custom attribute (not required)'): Promise<OwnRef> {
    const body: Json = {
        name: def.name,
        label: def.label,
        description: `REG run ${RUN_ID}: inventory seed`,
        contentType: def.contentType,
        required: false,
        visible: true,
        readOnly: false,
        list: !!def.options,
        multiSelect: !!def.options && def.multiSelect !== false,
        extensibleList: false,
        resources: ['certificates'],
        ...(def.options ? { content: def.options.map((data) => ({ reference: data, data })) } : {}),
    };
    const created = await apiJson<Json>(api, 'POST', '/api/v1/attributes/custom', body);
    return recordCreated('customAttributes', { uuid: String(created.uuid), name: def.name }, spec, note);
}

/** The REQUIRED custom attributes a tier defines on a resource, filled: the ONE shared filler (`regressionApi.requiredCustomAttributes`; no logic here). */
export async function requiredAttributeValues(api: GuardedApi, resource: 'users' | 'roles' | 'raProfiles' | 'certificates' | 'groups', value: string): Promise<Json[]> {
    return requiredCustomAttributes(api, resource, value);
}

/** `POST /v1/groups` for a run-prefixed name (any required custom attribute filled), recorded before the caller asserts anything. */
export async function createOwnGroup(api: GuardedApi, spec: string, name: string, fields: { description?: string; email?: string } = {}, note = 'seed group'): Promise<OwnRef> {
    const created = await apiJson<Json>(api, 'POST', '/api/v1/groups', {
        name,
        description: fields.description ?? `REG run ${RUN_ID}`,
        ...(fields.email ? { email: fields.email } : {}),
        customAttributes: await requiredAttributeValues(api, 'groups', name),
    });
    return recordCreated('groups', { uuid: String(created.uuid), name }, spec, note);
}

/** One custom attribute value of an upload / update request (`{ uuid, name, contentType, content: [{ data }] }`). */
export interface AttributeValue {
    uuid: string;
    name: string;
    contentType: string;
    data: unknown[];
}

/** `RequestAttribute` is polymorphic on `version` (v2 default, items without contentType): custom attributes are v3, every item carries its contentType (same rules as `requiredAttributeItems`). */
export const attributeRequest = (v: AttributeValue): Json => ({
    version: requestVersion(undefined, 'v3'),
    uuid: v.uuid,
    name: v.name,
    contentType: v.contentType,
    content: v.data.map((data) => ({ data, contentType: v.contentType })),
});

export interface UploadedCertificate {
    ref: OwnRef;
    /** The server's clock at the answer (Date header), for `createdAfter` of derived objects. */
    serverAt?: Date;
}

/**
 * Upload one built certificate synchronously, record it (type `certificates`, name = its common name) and its derived key
 * (`certKey_<CN>`, with the server-clock `createdAfter`), and return it. Required custom attributes of the tier are
 * filled, the seed's own attribute values travel in the same request.
 */
export async function uploadBuilt(api: GuardedApi, spec: string, built: Pick<BuiltCertificate, 'pem' | 'commonName'>, values: AttributeValue[] = [], note = 'seed certificate (upload)'): Promise<UploadedCertificate> {
    const required = await requiredAttributeValues(api, 'certificates', built.commonName);
    const { body, serverAt, elapsedMs } = await apiJsonWithDate<Json>(api, 'POST', '/api/v1/certificates/upload', {
        certificate: Buffer.from(built.pem).toString('base64'),
        customAttributes: [...required, ...values.map(attributeRequest)],
    });
    const ref = recordCreated('certificates', { uuid: String(body.uuid), name: built.commonName }, spec, note);
    await recordDerivedKeyOf(api, ref.uuid, serverAt ? createdAfterFrom(serverAt, elapsedMs) : undefined, spec);
    return { ref, serverAt };
}

/** `GET /v1/certificates/{uuid}` (the detail; reads need no guard). */
export async function readCertificate(api: GuardedApi, uuid: string): Promise<Json> {
    return apiJson<Json>(api, 'GET', `/api/v1/certificates/${uuid}`);
}

export interface CertificatePatch {
    groupUuids?: string[];
    ownerUuid?: string;
    trustedCa?: boolean;
}

/**
 * `PATCH /v1/certificates/{uuid}` on an OWN certificate (groups / owner / trusted-CA mark; `groupUuids` replaces the set:
 * rules §10.2 r6). The answer's status and body are returned (a negative caller asserts them); a 2xx is not asserted here.
 */
export async function patchOwnCertificate(api: GuardedApi, cert: OwnRef, body: CertificatePatch | Json): Promise<Probe> {
    await assertOwnLive(api, 'certificates', cert, 'patchOwnCertificate');
    return send(api, 'PATCH', `/api/v1/certificates/${cert.uuid}`, { data: body });
}

/** The same, requiring 204 (a seed step that must work). */
export async function patchOwnCertificateOk(api: GuardedApi, cert: OwnRef, body: CertificatePatch | Json): Promise<void> {
    const p = await patchOwnCertificate(api, cert, body);
    if (p.status !== 204 && p.status !== 200) throw new Error(`PATCH certificate ${cert.uuid} ${JSON.stringify(Object.keys(body))} answered ${p.status} ${p.text.slice(0, 300)}`);
}

/** `PATCH /v1/certificates/{uuid}/archive` or `/unarchive` on an OWN certificate: status and body returned. */
export async function setArchivedOwn(api: GuardedApi, cert: OwnRef, archive: boolean): Promise<Probe> {
    await assertOwnLive(api, 'certificates', cert, 'setArchivedOwn');
    return send(api, 'PATCH', `/api/v1/certificates/${cert.uuid}/${archive ? 'archive' : 'unarchive'}`);
}

/** `PATCH /v1/certificates/archive` / `unarchive` with a list of OWN uuids (the bulk route; the guard types the list). */
export async function setArchivedOwnBulk(api: GuardedApi, certs: OwnRef[], archive: boolean): Promise<Probe> {
    for (const c of certs) await assertOwnLive(api, 'certificates', c, 'setArchivedOwnBulk');
    return send(api, 'PATCH', `/api/v1/certificates/${archive ? 'archive' : 'unarchive'}`, { data: certs.map((c) => c.uuid) });
}

/** The certificate history (`GET /v1/certificates/{uuid}/history`): events newest first as the API answers. */
export async function readHistory(api: GuardedApi, uuid: string): Promise<Json[]> {
    return apiJson<Json[]>(api, 'GET', `/api/v1/certificates/${uuid}/history`);
}

/** `GET /v1/statistics` with an optional `includeArchived` flag: status and body returned. */
export async function readStatistics(api: GuardedApi, includeArchived?: boolean): Promise<Probe> {
    return send(api, 'GET', '/api/v1/statistics', includeArchived === undefined ? {} : { params: { includeArchived } });
}

/** Names of own objects for a seed set: `<run>-<tag>-<stamp>-`. */
export const seedPrefix = (regName: (suffix: string) => string, tag: string, stamp: string): string => regName(`${tag}-${stamp}-`);
