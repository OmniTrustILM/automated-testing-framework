/**
 * seedOwnedObjects — creators of the run's own inventory objects.
 *
 * WHAT: Creates and changes the run's own inventory objects (certificates, groups, custom attribute definitions) for the
 *       seeds: every non-GET goes through the guarded `api`, every create is in the ledger before any assertion, and every
 *       change checks the object is this run's first. Uploads are synchronous, so `created` follows the upload order.
 * WHY: The seeds create certificates, groups and attributes that the run must own and remove.
 * HOW: Every non-GET goes through the guarded `api`, every create is recorded before any assertion, every change first checks the object is this run's; uploads are synchronous so `created` follows upload order.
 */
import type { GuardedApi } from '../guard/types';
import { requestVersion } from '../attributeVersion';
import { uploadOwnCertificate } from '../ownCertificates';
import { apiJson, ApiAnswer } from '../apiReads';
import { requiredCustomAttributes } from '../customAttributes';
import { assertOwnLive } from '../ledger/ownership';
import { OwnRef } from '../ledger/ledger';
import type { BuiltCertificate } from './seedCertificates';
import { send } from './searchApi';
import type { JsonObject } from '../json';

/** The content types the seeds use for custom attributes (interfaces AttributeContentType codes). */
type AttributeKind = 'string' | 'integer' | 'date' | 'boolean';

export interface AttributeDefinition {
    /** Run-prefixed name (`runName(...)`): identifies the definition in the catalogue as `<name>|<CONTENT_TYPE>`. */
    name: string;
    label: string;
    contentType: AttributeKind;
    /** A list attribute with predefined options (`pick`). */
    options?: string[];
    multiSelect?: boolean;
}

/** One custom attribute value of an upload / update request (`{ uuid, name, contentType, content: [{ data }] }`). */
export interface AttributeValue {
    uuid: string;
    name: string;
    contentType: string;
    data: unknown[];
    /** A predefined-list attribute: core accepts an item only when reference, data AND contentType equal a list item. */
    list?: boolean;
}

/** `RequestAttribute` is polymorphic on `version` (v2 default, items without contentType): custom attributes are v3, every item carries its contentType (same rules as `requiredAttributeItems`). */
export const attributeRequest = (v: AttributeValue): JsonObject => ({
    version: requestVersion(undefined, 'v3'),
    uuid: v.uuid,
    name: v.name,
    contentType: v.contentType,
    // The seed defines list items as `{ reference: data, data }`, so a list value carries the same reference.
    content: v.data.map((data) => (v.list ? { reference: String(data), data, contentType: v.contentType } : { data, contentType: v.contentType })),
});

/**
 * Upload one built certificate synchronously, record it (type `certificates`, name = its common name) and its derived key
 * (`certKey_<CN>`), and return its reference. Required custom attributes of the tier are filled, the seed's own attribute
 * values travel in the same request.
 */
export async function uploadBuilt(api: GuardedApi, spec: string, built: Pick<BuiltCertificate, 'pem' | 'commonName'>, values: AttributeValue[] = [], note = 'seed certificate (upload)'): Promise<OwnRef> {
    const required = await requiredCustomAttributes(api, 'certificates', built.commonName);
    return uploadOwnCertificate(api, built.pem, built.commonName, spec, note, [...required, ...values.map(attributeRequest)]);
}

/** `GET /v1/certificates/{uuid}` (the detail; reads need no guard). */
export async function readCertificate(api: GuardedApi, uuid: string): Promise<JsonObject> {
    return apiJson<JsonObject>(api, 'GET', `/api/v1/certificates/${uuid}`);
}

export interface CertificatePatch {
    groupUuids?: string[];
    ownerUuid?: string;
    trustedCa?: boolean;
}

/**
 * `PATCH /v1/certificates/{uuid}` on an OWN certificate (groups / owner / trusted-CA mark; `groupUuids` replaces the set). The answer's status and body are returned (a negative caller asserts them); a 2xx is not asserted here.
 */
export async function patchOwnCertificate(api: GuardedApi, cert: OwnRef, body: CertificatePatch | JsonObject): Promise<ApiAnswer> {
    await assertOwnLive(api, 'certificates', cert, 'patchOwnCertificate');
    return send(api, 'PATCH', `/api/v1/certificates/${cert.uuid}`, { data: body });
}

/** The same, requiring 204 (a seed step that must work). */
export async function patchOwnCertificateOk(api: GuardedApi, cert: OwnRef, body: CertificatePatch | JsonObject): Promise<void> {
    const p = await patchOwnCertificate(api, cert, body);
    if (p.status !== 204 && p.status !== 200) throw new Error(`PATCH certificate ${cert.uuid} ${JSON.stringify(Object.keys(body))} answered ${p.status} ${p.text.slice(0, 300)}`);
}

/** `PATCH /v1/certificates/{uuid}/archive` or `/unarchive` on an OWN certificate: status and body returned. */
export async function setArchivedOwn(api: GuardedApi, cert: OwnRef, archive: boolean): Promise<ApiAnswer> {
    await assertOwnLive(api, 'certificates', cert, 'setArchivedOwn');
    return send(api, 'PATCH', `/api/v1/certificates/${cert.uuid}/${archive ? 'archive' : 'unarchive'}`);
}

/** `PATCH /v1/certificates/archive` / `unarchive` with a list of OWN uuids (the bulk route; the guard types the list). */
async function setArchivedOwnBulk(api: GuardedApi, certs: OwnRef[], archive: boolean): Promise<ApiAnswer> {
    for (const c of certs) await assertOwnLive(api, 'certificates', c, 'setArchivedOwnBulk');
    return send(api, 'PATCH', `/api/v1/certificates/${archive ? 'archive' : 'unarchive'}`, { data: certs.map((c) => c.uuid) });
}
