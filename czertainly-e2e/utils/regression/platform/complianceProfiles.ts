/**
 * complianceProfiles — an own compliance profile, its provider rules and its association with an own RA profile, the
 * compliance check of an own certificate, and the expected overall status of rule results (nok wins, na when no rule
 * applies). Every create is recorded; every change is sent for own objects only (`assertOwnLive`).
 */
import type { APIRequestContext, APIResponse } from '@playwright/test';
import type { GuardedApi } from '../guard/types';
import { assertOwnLive } from '../ledger/ownership';
import { apiJson } from '../apiReads';
import { requiredCustomAttributes } from '../customAttributes';
import { OwnRef } from '../ledger/ledger';
import { createOwn } from '../ownCrud';
import { ownName, runName, runId } from '../ledger/runState';
import type { JsonObject } from '../json';

/** `POST /v2/complianceProfiles`: an own compliance profile without rules (recorded as `complianceProfiles`). */
export async function createOwnComplianceProfile(api: GuardedApi, spec: string, suffix: string): Promise<OwnRef> {
    const { answer: _answer, ...ref } = await createOwn(api, spec, {
        type: 'complianceProfiles',
        path: '/api/v2/complianceProfiles',
        name: ownName(suffix),
        note: 'own compliance profile',
        body: { description: `REG run ${runId()}`, customAttributes: await requiredCustomAttributes(api, 'complianceProfiles', runName('ca')) },
    });
    return ref;
}

/** The provider rules offered for a resource (`GET /v2/complianceProfiles/rules`), optionally narrowed by connector. */
export async function listProviderRules(api: APIRequestContext, query: { connectorUuid?: string; kind?: string; resource?: string } = {}): Promise<JsonObject[]> {
    const q = Object.entries(query).filter(([, v]) => v).map(([k, v]) => `${k}=${encodeURIComponent(String(v))}`).join('&');
    return apiJson<JsonObject[]>(api, 'GET', `/api/v2/complianceProfiles/rules${q ? `?${q}` : ''}`);
}

/**
 * `PATCH /v2/complianceProfiles/{own}/rules`: add (or remove) one provider rule with its attributes. `ruleUuid` names a
 * compliance PROVIDER rule (a catalogue entry): waived on an own profile by the guard (ROUTE_FIELD_WAIVERS).
 * The raw response.
 */
export async function patchOwnComplianceRule(api: GuardedApi, profile: OwnRef, rule: { ruleUuid: string; connectorUuid: string; kind: string }, attributes: JsonObject[], removal = false): Promise<APIResponse> {
    await assertOwnLive(api, 'complianceProfiles', profile, 'complianceProfiles.patchOwnComplianceRule');
    return api.patch(`/api/v2/complianceProfiles/${profile.uuid}/rules`, { data: { removal, ruleUuid: rule.ruleUuid, connectorUuid: rule.connectorUuid, kind: rule.kind, attributes } });
}

/** `PATCH /v2/complianceProfiles/{own}/associations/{resource}/{own object}` (an own RA profile). */
export async function associateOwnComplianceProfile(api: GuardedApi, profile: OwnRef, resource: 'raProfiles', object: OwnRef): Promise<APIResponse> {
    await assertOwnLive(api, 'complianceProfiles', profile, 'complianceProfiles.associateOwnComplianceProfile');
    return api.patch(`/api/v2/complianceProfiles/${profile.uuid}/associations/${resource}/${object.uuid}`);
}

/** `POST /v2/compliance/certificates/{own certificate}` (re-evaluate one own object), then its `GET` result. */
export async function checkOwnCertificateCompliance(api: GuardedApi, certificate: OwnRef): Promise<JsonObject> {
    await assertOwnLive(api, 'certificates', certificate, 'complianceProfiles.checkOwnCertificateCompliance');
    const res = await api.post(`/api/v2/compliance/certificates/${certificate.uuid}`);
    if (!res.ok()) throw new Error(`POST /v2/compliance/certificates/{uuid} answered ${res.status()} ${(await res.text()).slice(0, 300)}`);
    return apiJson<JsonObject>(api, 'GET', `/api/v2/compliance/certificates/${certificate.uuid}`);
}

/** The overall status code of a compliance result document (`status` / `complianceStatus`), lower case. */
export const overallComplianceStatus = (result: JsonObject): string | undefined => {
    const s = result?.status ?? result?.complianceStatus ?? result?.overallStatus;
    return typeof s === 'string' ? s.toLowerCase() : undefined;
};

/** The overall compliance rule: nok if any rule is nok, na if no rule applies, else ok — the expected overall status of rule results. */
export function expectedOverallStatus(ruleStatuses: readonly string[]): 'ok' | 'nok' | 'na' {
    const s = ruleStatuses.map((x) => x.toLowerCase());
    if (s.some((x) => x === 'nok')) return 'nok';
    if (s.length === 0 || s.every((x) => x === 'na')) return 'na';
    return 'ok';
}
