/**
 * workflowFixtures — the own objects the workflow and discovery rows need around their triggers; each association row gets its own RA
 * profile, since one on the RUN RA profile would fire for every certificate other specs issue.
 */
import { waitForCertificateState } from '../wait/certificateState';
import { GuardedApi } from '../guard/types';
import { assertOwnLive } from '../ledger/ownership';
import { IssueOptions, issueOwnCertificate, OwnCertificate } from '../ownCertificates';
import { OwnRaProfile } from '../ownRaProfiles';
import { requiredCustomAttributes, OwnCustomAttribute } from '../customAttributes';
import { OwnRef, recordCreated } from '../ledger/ledger';
import { isOk, sendJson } from './workflowRequests';
import { ownName, ownCommonName } from '../ledger/runState';
import { randomBytes } from 'crypto';
import { uniqueSuffix } from '../text';
import { ApiAnswer } from '../apiReads';
import type { CertificateDetail } from '../apiReads';


export interface Registered {
    status: number;
    text: string;
    ref?: OwnCertificate;
}

/**
 * Pre-registers a placeholder certificate on an own RA profile: the cheap driver of firing counts; a 4xx on the first call is a deploy gate
 * the caller turns into a skip.
 */
export async function registerPlaceholder(api: GuardedApi, spec: string, ra: OwnRaProfile, suffix: string, opts: { ownerUuid?: string; groupUuids?: string[] } = {}): Promise<Registered> {
    const commonName = ownCommonName(suffix);
    const sent = await sendJson(api, 'POST', `/api/v2/operations/authorities/${ra.authorityUuid}/raProfiles/${ra.uuid}/certificates/register`, {
        subjectDn: `CN=${commonName}`,
        authorizationSecret: `s${randomBytes(5).toString('hex')}${uniqueSuffix()}`,
        attributes: [],
        customAttributes: await requiredCustomAttributes(api, 'certificates', ownName('ca')),
        ...(opts.ownerUuid ? { ownerUuid: opts.ownerUuid } : {}),
        ...(opts.groupUuids ? { groupUuids: opts.groupUuids } : {}),
    });
    if (isOk(sent) && typeof sent.json?.uuid === 'string') {
        const ref = recordCreated('certificates', { uuid: sent.json.uuid, name: commonName }, { spec, note: 'pre-registered placeholder (challenge-protected, no CA call)', parents: { raProfile: ra.uuid, authority: ra.authorityUuid } });
        return { status: sent.status, text: sent.text, ref: { ...ref, cn: commonName } };
    }
    return { status: sent.status, text: sent.text };
}

/** Revokes an own, issued certificate and waits until it is revoked; returns the call's status. */
export async function revokeOwnCertificateAndWait(api: GuardedApi, ra: OwnRaProfile, cert: OwnRef, reason = 'keyCompromise'): Promise<ApiAnswer> {
    await assertOwnLive(api, 'certificates', cert, 'revokeOwnCertificateAndWait');
    const sent = await sendJson(api, 'POST', `/api/v2/operations/authorities/${ra.authorityUuid}/raProfiles/${ra.uuid}/certificates/${cert.uuid}/revoke`, { reason, attributes: [] });
    if (isOk(sent) || sent.status === 204) await waitForCertificateState(api, cert.uuid, 'revoked', 120_000);
    return sent;
}

export interface CertificateObjects {
    groupUuids?: string[];
    ownerUuid?: string;
}

/**
 * `PATCH /v1/certificates/{own}`: groups and owner of an OWN certificate; the update DTO has no custom attributes (core ignores unknown
 * fields), use `setOwnCustomAttribute`.
 */
export async function updateOwnCertificate(api: GuardedApi, cert: OwnRef, objects: CertificateObjects): Promise<ApiAnswer> {
    await assertOwnLive(api, 'certificates', cert, 'updateOwnCertificate');
    return sendJson(api, 'PATCH', `/api/v1/certificates/${cert.uuid}`, objects);
}

/** Sets a custom attribute value on a certificate; both must be OWN. */
export async function setOwnCustomAttribute(api: GuardedApi, cert: OwnRef, attr: OwnCustomAttribute, value: unknown): Promise<ApiAnswer> {
    await assertOwnLive(api, 'certificates', cert, 'setOwnCustomAttribute (certificate)');
    await assertOwnLive(api, 'customAttributes', attr, 'setOwnCustomAttribute (attribute)');
    return sendJson(api, 'PATCH', `/api/v1/attributes/custom/resources/certificates/objects/${cert.uuid}/${attr.uuid}`, [{ data: value }]);
}

export async function getCertificateDetail(api: GuardedApi, uuid: string): Promise<CertificateDetail> {
    const sent = await sendJson(api, 'GET', `/api/v1/certificates/${uuid}`);
    if (sent.status !== 200) throw new Error(`GET certificate ${uuid} answered ${sent.status}`);
    return sent.json as CertificateDetail;
}

export const eventCertificate = (suffix: string): IssueOptions => ({ suffix, sans: { ip: [] }, fillRequiredAttributes: true, note: 'issued on an own RA profile (event driver)' });

export async function issueOwnCertificateInGroup(api: GuardedApi, ra: OwnRaProfile, spec: string, group: OwnRef, owner: OwnRef | undefined, suffix: string): Promise<OwnCertificate> {
    const cert = await issueOwnCertificate(api, ra, spec, eventCertificate(suffix));
    const sent = await updateOwnCertificate(api, cert, { groupUuids: [group.uuid], ...(owner ? { ownerUuid: owner.uuid } : {}) });
    if (!isOk(sent)) throw new Error(`PATCH certificate → ${sent.status} ${sent.text.slice(0, 300)}`);
    return cert;
}
