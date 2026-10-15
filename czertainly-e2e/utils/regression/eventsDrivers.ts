/**
 * eventsDrivers — the own objects the workflow and discovery rows need around their triggers (events-discovery area):
 * groups, custom attributes, a dedicated RA profile per row, certificates (issued, pre-registered, revoked) and the object
 * updates that put a certificate into a group.
 *
 * Why a separate module (the lifecycle and inventory areas build their own `lifecycle.ts` / `inventorySeed.ts`): the merge
 * step folds the duplicates; nothing here is imported by another area. Every helper takes a `GuardedApi`, records what it
 * creates in the ledger before the caller asserts, and calls `assertOwnLive` before it changes an object (decision Q1).
 *
 * RA profile per row: an event association on the RUN RA profile would fire for every certificate other specs issue on it, so
 * each association row gets its OWN RA profile (`createOwnRaProfile`: attributes copied read-only from an enabled RA profile
 * of the first healthy CA, created under the pre-existing authority, enabled). No healthy CA → `RaProfileSourceMissing`
 * (the caller skips with the named deploy gate; a skip is never coverage).
 */
import { waitForCertificateState } from '../certificateUtils';
import { GuardedApi } from './guardedApi';
import { assertOwnLive } from './ownObjects';
import { csrWithSan } from './pki';
import {
    createRaProfileLike, enableOwnRaProfile, issueWithCsr, pickHealthyAuthority, RaProfileSourceMissing, recordDerivedKeyOf, serverCreatedAfter, requiredCustomAttributes,
} from './regressionApi';
import { OwnRef, recordCreated, RUN_ID } from './regressionRun';
import { isOk, Sent, sendJson, wfName } from './workflowApi';

type Json = Record<string, any>;

// ------------------------------------------------------------------ required custom attributes of any resource

/**
 * Values for the REQUIRED custom attributes a tier defines on a resource (a create without them answers 422): string-like
 * types get `value`, numbers 1, booleans true, dates today, a list its first option; any other required type throws (a
 * setup the suite cannot fill). Now the ONE shared helper `regressionApi.requiredCustomAttributes` (version v3 + contentType on every item; `time` / `datetime` filled).
 */
export const requiredAttributesFor = (api: GuardedApi, resource: string, value: string): Promise<Json[]> => requiredCustomAttributes(api, resource, value);

// ------------------------------------------------------------------ groups and custom attributes

/** A new own group (`POST /v1/groups`, create list), recorded; `email` is the group's contact address (`@example.test` only). */
export async function createOwnGroup(api: GuardedApi, spec: string, suffix: string, opts: { email?: string } = {}): Promise<OwnRef> {
    const name = wfName(suffix);
    const sent = await sendJson(api, 'POST', '/api/v1/groups', {
        name,
        description: `REG run ${RUN_ID}`,
        ...(opts.email ? { email: opts.email } : {}),
        customAttributes: await requiredAttributesFor(api, 'groups', wfName('ca')),
    });
    if (!isOk(sent) || typeof sent.json?.uuid !== 'string') throw new Error(`POST /v1/groups → ${sent.status} ${sent.text.slice(0, 300)}`);
    return recordCreated('groups', { uuid: sent.json.uuid, name }, spec, 'own group (event scope / Set field target)');
}

export interface OwnCustomAttribute extends OwnRef {
    /** The attribute name (the `name|contentType` field identifier part). */
    attributeName: string;
    contentType: string;
}

/**
 * An own custom attribute definition (NOT required: a required one would break other users' forms, Phase 3 §7) on the
 * given resources, recorded. The definition name is the ledger name.
 */
export async function createOwnCustomAttribute(api: GuardedApi, spec: string, o: { suffix: string; resources?: string[]; contentType?: string }): Promise<OwnCustomAttribute> {
    const name = wfName(o.suffix);
    const contentType = o.contentType ?? 'string';
    const sent = await sendJson(api, 'POST', '/api/v1/attributes/custom', {
        name,
        label: name,
        description: `REG run ${RUN_ID}`,
        contentType,
        required: false,
        visible: true,
        readOnly: false,
        list: false,
        multiSelect: false,
        resources: o.resources ?? ['certificates'],
    });
    if (!isOk(sent) || typeof sent.json?.uuid !== 'string') throw new Error(`POST /v1/attributes/custom → ${sent.status} ${sent.text.slice(0, 300)}`);
    const ref = recordCreated('customAttributes', { uuid: sent.json.uuid, name }, spec, 'own custom attribute (never required)');
    return { ...ref, attributeName: name, contentType };
}

/** A request custom attribute of a definition: `{ uuid, name, contentType, content: [{ data }] }`. */
export const customValue = (attr: OwnCustomAttribute, value: unknown): Json => ({ uuid: attr.uuid, name: attr.attributeName, contentType: attr.contentType, content: [{ data: value }] });

// ------------------------------------------------------------------ an own RA profile per row

export type OwnRa = OwnRef & { authorityUuid: string };

/**
 * A NEW own RA profile (a clone of an enabled RA profile of the first healthy CA, enabled) for one row: event associations
 * and triggers hang on it alone. Throws RaProfileSourceMissing when no CA qualifies (the caller skips with its reason).
 */
export async function createOwnRaProfile(api: GuardedApi, spec: string, suffix: string): Promise<OwnRa> {
    const pick = await pickHealthyAuthority(api);
    if ('skip' in pick) throw new RaProfileSourceMissing(pick.skip);
    const ref = await createRaProfileLike(api, pick, wfName(suffix));
    const own = recordCreated('raProfiles', ref, spec, `own RA profile of an event row; attributes copied read-only from an enabled RA profile on ${pick.connectorName}`, { authority: pick.authorityUuid });
    await enableOwnRaProfile(api, pick.authorityUuid, own);
    return { ...own, authorityUuid: pick.authorityUuid };
}

/** `createOwnRaProfile` with the deploy gate as a skip: `skip` is called with the reason when no CA qualifies. */
export async function createOwnRaProfileOrSkip(api: GuardedApi, spec: string, suffix: string, skip: (reason: string) => void): Promise<OwnRa> {
    try {
        return await createOwnRaProfile(api, spec, suffix);
    } catch (e) {
        if (e instanceof RaProfileSourceMissing) skip(e.reason);
        throw e;
    }
}

// ------------------------------------------------------------------ certificates

export interface OwnCertificate extends OwnRef {
    commonName: string;
}

/**
 * Issues an own certificate on an own RA profile (v2 issue with an external CSR), records it (and its platform-linked key as a
 * derived object) right after the create, and waits until it is issued (fail-fast, 180 s: the plan's issuance budget).
 */
export async function issueOwnCertificate(api: GuardedApi, spec: string, ra: OwnRa, suffix: string, opts: { wait?: boolean } = {}): Promise<OwnCertificate> {
    const commonName = `${wfName(suffix)}.example.test`;
    const csr = csrWithSan(commonName, [commonName]);
    const startedAfter = await serverCreatedAfter(api);
    const issued = await issueWithCsr(api, ra.authorityUuid, ra.uuid, csr.derBase64);
    const ref = recordCreated('certificates', { uuid: issued.uuid, name: commonName }, spec, 'issued on an own RA profile (event driver)', { raProfile: ra.uuid, authority: ra.authorityUuid });
    if (opts.wait !== false) {
        await waitForCertificateState(api, ref.uuid, 'issued', 180_000);
        await recordDerivedKeyOf(api, ref.uuid, issued.createdAfter ?? startedAfter, spec);
    }
    return { ...ref, commonName };
}

export interface Registered {
    status: number;
    text: string;
    ref?: OwnCertificate;
}

/**
 * Pre-registers a placeholder certificate with an authorization secret on an own RA profile (`POST …/certificates/register`):
 * it fires `Certificate registered` and makes no connector call when the authority has no registration support (cert-
 * lifecycle PR-5), so it is the cheap driver of firing counts (REG-WFL-15). The answer is returned: a 4xx on the first call
 * is a deploy gate (the authority cannot pre-register) the caller turns into a skip with the text.
 */
export async function registerPlaceholder(api: GuardedApi, spec: string, ra: OwnRa, suffix: string, opts: { ownerUuid?: string; groupUuids?: string[] } = {}): Promise<Registered> {
    const commonName = `${wfName(suffix)}.example.test`;
    const sent = await sendJson(api, 'POST', `/api/v2/operations/authorities/${ra.authorityUuid}/raProfiles/${ra.uuid}/certificates/register`, {
        subjectDn: `CN=${commonName}`,
        authorizationSecret: `s${Math.random().toString(36).slice(2, 12)}${Date.now().toString(36)}`,
        attributes: [],
        customAttributes: await requiredAttributesFor(api, 'certificates', wfName('ca')),
        ...(opts.ownerUuid ? { ownerUuid: opts.ownerUuid } : {}),
        ...(opts.groupUuids ? { groupUuids: opts.groupUuids } : {}),
    });
    if (isOk(sent) && typeof sent.json?.uuid === 'string') {
        const ref = recordCreated('certificates', { uuid: sent.json.uuid, name: commonName }, spec, 'pre-registered placeholder (challenge-protected, no CA call)', { raProfile: ra.uuid, authority: ra.authorityUuid });
        return { status: sent.status, text: sent.text, ref: { ...ref, commonName } };
    }
    return { status: sent.status, text: sent.text };
}

/** Revokes an own, issued certificate (`POST …/revoke`) and waits until it is revoked. The status of the call is returned. */
export async function revokeOwnCertificate(api: GuardedApi, ra: OwnRa, cert: OwnRef, reason = 'keyCompromise'): Promise<Sent> {
    await assertOwnLive(api, 'certificates', cert, 'revokeOwnCertificate');
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
export async function updateOwnCertificate(api: GuardedApi, cert: OwnRef, objects: CertificateObjects): Promise<Sent> {
    await assertOwnLive(api, 'certificates', cert, 'updateOwnCertificate');
    return sendJson(api, 'PATCH', `/api/v1/certificates/${cert.uuid}`, objects);
}

/**
 * `PATCH /v1/attributes/custom/resources/certificates/objects/{certificate}/{attribute}` with the content list of the value
 * (`updateAttributeContentForResource`): both the certificate and the custom attribute must be OWN (the guard types both uuids).
 */
export async function setOwnCustomAttribute(api: GuardedApi, cert: OwnRef, attr: OwnCustomAttribute, value: unknown): Promise<Sent> {
    await assertOwnLive(api, 'certificates', cert, 'setOwnCustomAttribute (certificate)');
    await assertOwnLive(api, 'customAttributes', attr, 'setOwnCustomAttribute (attribute)');
    return sendJson(api, 'PATCH', `/api/v1/attributes/custom/resources/certificates/objects/${cert.uuid}/${attr.uuid}`, [{ data: value }]);
}

/** The detail of a certificate (read-only): groups, owner, custom attributes, state. */
export async function getCertificateDetail(api: GuardedApi, uuid: string): Promise<Json> {
    const sent = await sendJson(api, 'GET', `/api/v1/certificates/${uuid}`);
    if (sent.status !== 200) throw new Error(`GET certificate ${uuid} answered ${sent.status}`);
    return sent.json as Json;
}

/** The uuids of the groups of a certificate detail (`groups: [{ uuid, name }]`). */
export const groupUuidsOf = (detail: Json): string[] => ((detail.groups ?? []) as Json[]).map((g) => String(g.uuid)).sort();

/** The text of an own custom attribute on a certificate detail, or undefined (`customAttributes: [{ name, content: [{ data }] }]`). */
export function customAttributeValue(detail: Json, name: string): unknown {
    const a = ((detail.customAttributes ?? []) as Json[]).find((x) => x.name === name);
    const item = a?.content?.[0];
    return item?.data;
}

/** A new own role with a contact e-mail (`@example.test` only; a role's e-mail is what an e-mail notification to a ROLE reaches). */
export async function createOwnRoleWithEmail(api: GuardedApi, spec: string, suffix: string, email: string): Promise<OwnRef> {
    const name = wfName(suffix);
    const sent = await sendJson(api, 'POST', '/api/v1/roles', {
        name,
        description: `REG run ${RUN_ID}`,
        email,
        customAttributes: await requiredAttributesFor(api, 'roles', wfName('ca')),
    });
    if (!isOk(sent) || typeof sent.json?.uuid !== 'string') throw new Error(`POST /v1/roles → ${sent.status} ${sent.text.slice(0, 300)}`);
    return recordCreated('roles', { uuid: sent.json.uuid, name }, spec, 'own role with a contact e-mail (notification recipient)');
}

/** An own certificate in an own group, owned by an own user (event driver for the status-changed notification rows). */
export async function issueOwnCertificateInGroup(api: GuardedApi, spec: string, ra: OwnRa, group: OwnRef, owner: OwnRef | undefined, suffix: string): Promise<OwnCertificate> {
    const cert = await issueOwnCertificate(api, spec, ra, suffix);
    const sent = await updateOwnCertificate(api, cert, { groupUuids: [group.uuid], ...(owner ? { ownerUuid: owner.uuid } : {}) });
    if (!isOk(sent)) throw new Error(`PATCH certificate → ${sent.status} ${sent.text.slice(0, 300)}`);
    return cert;
}
