/**
 * RA-profile helpers of the ra-profile-required-attribute API spec: the authority whose RA-profile schema has a required
 * attribute (read-only), the missing / empty attribute arms, the texts core answers for them, and the create and
 * validate probes (an accepted create is in the ledger before this returns).
 */
import type { APIRequestContext } from '@playwright/test';
import { requestVersion } from '../attributeVersion';
import { assertGuarded } from '../guard/types';
import type { GuardedApi } from '../guard/types';
import { readJsonOk, readProbe, send } from './searchApi';
import type { Json, Probe } from './searchApi';
import { toRequestAttribute, requiredCustomAttributes } from '../customAttributes';
import { runName } from '../ledger/runState';
import { hasRunFamilyPrefix } from '../run/runId';
import { CreateAttempt, createAttempt } from './credentialsApi';

/** The label core prints in "Required attribute <label> not found." (the definition's properties.label, else label, else name). */
export const labelOf = (def: Json): string => String(def?.properties?.label ?? def?.label ?? def?.name ?? '');

// ------------------------------------------------------------------ RA profile with a required attribute (API-GEN-28)

/** The attribute versions the request side knows: a definition's version (2 / 'v2' / 3 / 'v3') as a request attribute `version`. */
export { requestVersion };

/** "Required attribute <label> not found." (AttributeDefinitionUtils:388): the attribute is not in the request. */
export const requiredAttributeNotFoundText = (label: string): string => `Required attribute ${label} not found.`;

/** "Value of required attribute <label> not set." (AttributeDefinitionUtils:397): the attribute is listed without content. */
export const requiredAttributeNotSetText = (label: string): string => `Value of required attribute ${label} not set.`;

/** The base attributes without the target attribute: the required one is MISSING from the request. */
export const missingAttributeCase = (base: readonly Json[], def: Json): Json[] => base.filter((a) => a?.name !== def.name);

/** The base attributes with the target listed WITHOUT content: the required one is EMPTY. */
export const emptyAttributeCase = (base: readonly Json[], def: Json): Json[] => [
    ...missingAttributeCase(base, def),
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
    const rows = readJsonOk<Json[]>(await readProbe(api, '/api/v1/authorities'), 'GET /v1/authorities');
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
    const all = readJsonOk<Json[]>(await readProbe(api, '/api/v1/raProfiles'), 'GET /v1/raProfiles');
    const source = (Array.isArray(all) ? all : [])
        .filter((r) => r?.authorityInstanceUuid === authorityUuid && r.enabled === true && !hasRunFamilyPrefix(String(r.name)))
        .sort((a, b) => (String(a.name) < String(b.name) ? -1 : String(a.name) > String(b.name) ? 1 : 0))[0];
    if (!source) return undefined;
    const detail = readJsonOk<Json>(await readProbe(api, `/api/v1/authorities/${authorityUuid}/raProfiles/${source.uuid}`), 'GET RA profile detail');
    const attributes = (Array.isArray(detail?.attributes) ? (detail.attributes as Json[]) : []).filter((a) => !a.type || a.type === 'data').map(toRequestAttribute);
    return attributes.length ? attributes : undefined;
}

/** A `POST /v1/authorities/{a}/raProfiles` body: the attributes under test plus the custom attributes the tier requires (core checks them first). */
export async function raProfileBody(api: APIRequestContext, name: string, attributes: Json[]): Promise<Json> {
    return { name, description: 'API-GEN-28 required-attribute probe', attributes, customAttributes: await requiredCustomAttributes(api, 'raProfiles', runName('ca')) };
}

/** `POST /v1/authorities/{authority}/raProfiles` (the authority is a scope parent); an accepted create is in the ledger before this returns. */
export async function createRaProfileProbe(api: GuardedApi, authorityUuid: string, body: Json, spec: string, note = 'RA profile create probe'): Promise<CreateAttempt> {
    return createAttempt(api, `/api/v1/authorities/${authorityUuid}/raProfiles`, 'raProfiles', body, spec, note, { authority: authorityUuid });
}

/** `POST /v1/authorities/{authority}/attributes/raProfile/validate` (a read-only validation POST): status and body never throw. */
export async function validateRaAttributes(api: GuardedApi, authorityUuid: string, attributes: Json[]): Promise<Probe> {
    return send(assertGuarded(api, 'validateRaAttributes'), 'POST', `/api/v1/authorities/${authorityUuid}/attributes/raProfile/validate`, { data: attributes });
}
