/**
 * workflowFixtures — the own objects the workflow and discovery rows need around their triggers.
 *
 * WHAT: the own objects the workflow and discovery rows need around their triggers: pre-registered and revoked
 *       certificates, the object updates that put a certificate into a group or give it a custom attribute value, and the
 *       read of a certificate detail. The creators themselves (groups, custom attributes, RA profiles, issued certificates) live
 *       in `ownGroups`, `customAttributes`, `ownRaProfiles` and `ownCertificates`.
 *
 *       RA profile per row: an event association on the RUN RA profile would fire for every certificate other specs issue on it, so
 *       each association row gets its OWN RA profile (`createOwnRaProfile`). Every helper takes a `GuardedApi`, records what it
 *       creates in the ledger before the caller asserts, and calls `assertOwnLive` before it changes an object.
 * WHY: A trigger test needs a certificate in a known state and group, and an event association on the run RA profile would fire for every
 * other spec.
 * HOW: Every helper takes a `GuardedApi`, records what it creates before the caller asserts, and runs `assertOwnLive` before it changes an
 * object; each association row gets its own RA profile.
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
import { uniqueSuffix } from '../text';
import { ApiAnswer } from '../apiReads';
import type { CertificateDetail } from '../apiReads';

// ------------------------------------------------------------------ certificates

export interface Registered {
    status: number;
    text: string;
    ref?: OwnCertificate;
}

/**
 * Pre-registers a placeholder certificate with an authorization secret on an own RA profile (`POST …/certificates/register`):
 * it fires `Certificate registered` and makes no connector call when the authority has no registration support, so it is the
 * cheap driver of firing counts (REG-WFL-15). The answer is returned: a 4xx on the first call
 * is a deploy gate (the authority cannot pre-register) the caller turns into a skip with the text.
 */
export async function registerPlaceholder(api: GuardedApi, spec: string, ra: OwnRaProfile, suffix: string, opts: { ownerUuid?: string; groupUuids?: string[] } = {}): Promise<Registered> {
    const commonName = ownCommonName(suffix);
    const sent = await sendJson(api, 'POST', `/api/v2/operations/authorities/${ra.authorityUuid}/raProfiles/${ra.uuid}/certificates/register`, {
        subjectDn: `CN=${commonName}`,
        authorizationSecret: `s${Math.random().toString(36).slice(2, 12)}${uniqueSuffix()}`,
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

/**
 * Revokes an own, issued certificate (`POST …/revoke`) and waits until it is revoked; the status of the call is returned.
 * (lifecycle/certificateOperations `revokeOwnCertificate` sends the call only and returns the raw answer.)
 */
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
 * `PATCH /v1/certificates/{own}`: groups and owner of an OWN certificate (the guard types each uuid). The update DTO
 * (`CertificateUpdateObjectsDto`) has NO custom attributes: core ignores unknown fields, so a custom attribute is set with
 * `setOwnCustomAttribute`.
 */
export async function updateOwnCertificate(api: GuardedApi, cert: OwnRef, objects: CertificateObjects): Promise<ApiAnswer> {
    await assertOwnLive(api, 'certificates', cert, 'updateOwnCertificate');
    return sendJson(api, 'PATCH', `/api/v1/certificates/${cert.uuid}`, objects);
}

/**
 * `PATCH /v1/attributes/custom/resources/certificates/objects/{certificate}/{attribute}` with the content list of the value
 * (`updateAttributeContentForResource`): both the certificate and the custom attribute must be OWN (the guard types both uuids).
 */
export async function setOwnCustomAttribute(api: GuardedApi, cert: OwnRef, attr: OwnCustomAttribute, value: unknown): Promise<ApiAnswer> {
    await assertOwnLive(api, 'certificates', cert, 'setOwnCustomAttribute (certificate)');
    await assertOwnLive(api, 'customAttributes', attr, 'setOwnCustomAttribute (attribute)');
    return sendJson(api, 'PATCH', `/api/v1/attributes/custom/resources/certificates/objects/${cert.uuid}/${attr.uuid}`, [{ data: value }]);
}

/** The detail of a certificate (read-only): groups, owner, custom attributes, state. */
export async function getCertificateDetail(api: GuardedApi, uuid: string): Promise<CertificateDetail> {
    const sent = await sendJson(api, 'GET', `/api/v1/certificates/${uuid}`);
    if (sent.status !== 200) throw new Error(`GET certificate ${uuid} answered ${sent.status}`);
    return sent.json as CertificateDetail;
}

/** The issue options of an event row's certificate: the CN as the only SAN, the tier's required custom attributes filled. */
export const eventCertificate = (suffix: string): IssueOptions => ({ suffix, sans: { ip: [] }, fillRequiredAttributes: true, note: 'issued on an own RA profile (event driver)' });

/** An own certificate in an own group, owned by an own user (event driver for the status-changed notification rows). */
export async function issueOwnCertificateInGroup(api: GuardedApi, ra: OwnRaProfile, spec: string, group: OwnRef, owner: OwnRef | undefined, suffix: string): Promise<OwnCertificate> {
    const cert = await issueOwnCertificate(api, ra, spec, eventCertificate(suffix));
    const sent = await updateOwnCertificate(api, cert, { groupUuids: [group.uuid], ...(owner ? { ownerUuid: owner.uuid } : {}) });
    if (!isOk(sent)) throw new Error(`PATCH certificate → ${sent.status} ${sent.text.slice(0, 300)}`);
    return cert;
}
