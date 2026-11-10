/**
 * seedOwnedObjects — creators of the run's own inventory objects for the seeds: uploads the seed certificates and changes groups, owner,
 * trusted-CA mark and archive; every upload is in the ledger before any
 * assertion and every change first checks the certificate is this run's.
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

type AttributeKind = 'string' | 'integer' | 'date' | 'boolean';

export interface AttributeDefinition {
    name: string;
    label: string;
    contentType: AttributeKind;
    options?: string[];
    multiSelect?: boolean;
}

export interface AttributeValue {
    uuid: string;
    name: string;
    contentType: string;
    data: unknown[];
    list?: boolean;
}

/** Custom attributes are v3: every item carries its contentType. */
export const attributeRequest = (v: AttributeValue): JsonObject => ({
    version: requestVersion(undefined, 'v3'),
    uuid: v.uuid,
    name: v.name,
    contentType: v.contentType,
        // The seed defines list items as `{ reference: data, data }`.
    content: v.data.map((data) => (v.list ? { reference: String(data), data, contentType: v.contentType } : { data, contentType: v.contentType })),
});

/**
 * Upload one built certificate synchronously and record it with its derived key; required custom attributes are filled and the seed's
 * values travel in the same request.
 */
export async function uploadBuilt(api: GuardedApi, spec: string, built: Pick<BuiltCertificate, 'pem' | 'commonName'>, values: AttributeValue[] = [], note = 'seed certificate (upload)'): Promise<OwnRef> {
    const required = await requiredCustomAttributes(api, 'certificates', built.commonName);
    return uploadOwnCertificate(api, built.pem, built.commonName, spec, note, [...required, ...values.map(attributeRequest)]);
}

export async function readCertificate(api: GuardedApi, uuid: string): Promise<JsonObject> {
    return apiJson<JsonObject>(api, 'GET', `/api/v1/certificates/${uuid}`);
}

export interface CertificatePatch {
    groupUuids?: string[];
    ownerUuid?: string;
    trustedCa?: boolean;
}

/** `PATCH /v1/certificates/{uuid}` on an OWN certificate (`groupUuids` replaces the set); status and body are returned. */
export async function patchOwnCertificate(api: GuardedApi, cert: OwnRef, body: CertificatePatch | JsonObject): Promise<ApiAnswer> {
    await assertOwnLive(api, 'certificates', cert, 'patchOwnCertificate');
    return send(api, 'PATCH', `/api/v1/certificates/${cert.uuid}`, { data: body });
}

export async function patchOwnCertificateOk(api: GuardedApi, cert: OwnRef, body: CertificatePatch | JsonObject): Promise<void> {
    const p = await patchOwnCertificate(api, cert, body);
    if (p.status !== 204 && p.status !== 200) throw new Error(`PATCH certificate ${cert.uuid} ${JSON.stringify(Object.keys(body))} answered ${p.status} ${p.text.slice(0, 300)}`);
}

export async function setArchivedOwn(api: GuardedApi, cert: OwnRef, archive: boolean): Promise<ApiAnswer> {
    await assertOwnLive(api, 'certificates', cert, 'setArchivedOwn');
    return send(api, 'PATCH', `/api/v1/certificates/${cert.uuid}/${archive ? 'archive' : 'unarchive'}`);
}

async function setArchivedOwnBulk(api: GuardedApi, certs: OwnRef[], archive: boolean): Promise<ApiAnswer> {
    for (const c of certs) await assertOwnLive(api, 'certificates', c, 'setArchivedOwnBulk');
    return send(api, 'PATCH', `/api/v1/certificates/${archive ? 'archive' : 'unarchive'}`, { data: certs.map((c) => c.uuid) });
}
