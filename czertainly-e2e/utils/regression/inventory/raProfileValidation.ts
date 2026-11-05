/**
 * raProfileValidation — RA-profile helpers of the ra-profile-required-attribute API spec.
 *
 * Finds the authority whose RA-profile schema has a required attribute (read-only), builds the missing and empty
 * attribute arms, and has the texts core answers for them. Create and validate probes: an accepted create is in the
 * ledger before the probe returns.
 */
import type { APIRequestContext } from '@playwright/test';
import { requestVersion } from '../attributeVersion';
import { assertGuarded } from '../guard/types';
import type { GuardedApi } from '../guard/types';
import { readJsonOk, send, readAnswer } from './searchApi';
import { toRequestAttribute, requiredCustomAttributes } from '../customAttributes';
import { runName } from '../ledger/runState';
import { hasRunFamilyPrefix } from '../run/runId';
import { probeCollectionCreate } from '../ownCrud';
import { ApiAnswer } from '../apiReads';
import { JsonObject } from '../json';
import { objectOf } from '../json';

/** The label core prints in "Required attribute <label> not found." (the definition's properties.label, else label, else name). */
export const labelOf = (def: JsonObject): string => String(objectOf(def?.properties).label ?? def?.label ?? def?.name ?? '');

// ------------------------------------------------------------------ RA profile with a required attribute (API-GEN-28)

/** The attribute versions the request side knows: a definition's version (2 / 'v2' / 3 / 'v3') as a request attribute `version`. */
export { requestVersion };

/** "Required attribute <label> not found." (AttributeDefinitionUtils:388): the attribute is not in the request. */
export const requiredAttributeNotFoundText = (label: string): string => `Required attribute ${label} not found.`;

/** "Value of required attribute <label> not set." (AttributeDefinitionUtils:397): the attribute is listed without content. */
export const requiredAttributeNotSetText = (label: string): string => `Value of required attribute ${label} not set.`;

/** The base attributes without the target attribute: the required one is MISSING from the request. */
export const missingAttributeCase = (base: readonly JsonObject[], def: JsonObject): JsonObject[] => base.filter((a) => a?.name !== def.name);

/** The base attributes with the target listed WITHOUT content: the required one is EMPTY. */
export const emptyAttributeCase = (base: readonly JsonObject[], def: JsonObject): JsonObject[] => [
    ...missingAttributeCase(base, def),
    { version: requestVersion(def), uuid: def.uuid, name: def.name, contentType: String(def.contentType).toLowerCase() },
];

/**
 * "Content for required Data attribute <name> is not provided." (AttributeEngine): core's own text for a v3 authority, the attribute is not
 * in the request.
 */
const engineAttributeNotProvidedText = (name: string): string => `Content for required Data attribute ${name} is not provided.`;

/**
 * "Attribute is required and no content is sent" (AttributeEngine; a pipe and the attribute dump follow): core's own text for a v3
 * authority, the attribute is listed without content.
 */
const ENGINE_ATTRIBUTE_NO_CONTENT_TEXT = 'Attribute is required and no content is sent';

/**
 * The connector interface version an authority is bound to: v3 is validated by core's attribute engine, v1 / v2 relay the connector's text.
 */
export type AuthorityInterface = 'v2' | 'v3';

/**
 * The interface of an authority row of `GET /v1/authorities` (`connectorInterface.version`; null for a legacy connector, which relays like
 * v2).
 */
export const authorityInterfaceOf = (row: JsonObject): AuthorityInterface => (String(objectOf(row?.connectorInterface).version ?? '').toLowerCase() === 'v3' ? 'v3' : 'v2');

/**
 * The oracle of a required-attribute refusal by the authority's interface: `text` is the message that must be present and
 * `names` the attribute reference that message must carry (the label for the connector's text, the attribute name for core's).
 */
export function requiredAttributeOracle(iface: AuthorityInterface, def: JsonObject, arm: 'missing' | 'empty'): { text: string; names: string } {
    if (iface === 'v3') {
        const name = String(def?.name ?? '');
        return { text: arm === 'missing' ? engineAttributeNotProvidedText(name) : ENGINE_ATTRIBUTE_NO_CONTENT_TEXT, names: name };
    }
    const label = labelOf(def);
    return { text: arm === 'missing' ? requiredAttributeNotFoundText(label) : requiredAttributeNotSetText(label), names: label };
}

export interface RaAuthority {
    uuid: string;
    connectorName: string;
    /** The connector interface the authority is bound to, read from the authority list. */
    connectorInterface: AuthorityInterface;
    /** The required data attributes of the authority's RA-profile schema. */
    required: JsonObject[];
}

/**
 * The first CONNECTED pre-existing authority (by name) whose RA-profile attribute schema
 * (`GET /v1/authorities/{uuid}/attributes/raProfile`, read-only) holds a required data attribute, or the named reason there
 * is none (never creates an authority). At most `max` authorities are read.
 */
export async function authorityWithRequiredAttribute(api: APIRequestContext, max = 8): Promise<{ ok: RaAuthority; skip?: undefined } | { ok?: undefined; skip: string }> {
    const rows = readJsonOk<JsonObject[]>(await readAnswer(api, '/api/v1/authorities'), 'GET /v1/authorities');
    const candidates = (Array.isArray(rows) ? rows : [])
        .filter((a) => typeof a?.uuid === 'string' && a.status === 'connected' && !hasRunFamilyPrefix(String(a.name)))
        .sort((a, b) => (String(a.name) < String(b.name) ? -1 : String(a.name) > String(b.name) ? 1 : 0));
    const reasons: string[] = [];
    for (const a of candidates.slice(0, max)) {
        const read = await readAnswer(api, `/api/v1/authorities/${a.uuid}/attributes/raProfile`);
        const connectorName = String(a.connectorName ?? '?');
        if (read.status !== 200 || !Array.isArray(read.json)) {
            reasons.push(`${connectorName}: the RA-profile attribute read answered ${read.status}`);
            continue;
        }
        const required = (read.json as JsonObject[]).filter((d) => (!d.type || d.type === 'data') && objectOf(d.properties).required === true);
        if (required.length) return { ok: { uuid: String(a.uuid), connectorName, connectorInterface: authorityInterfaceOf(a), required } };
        reasons.push(`${connectorName}: no required RA-profile attribute`);
    }
    return { skip: `no connected pre-existing authority whose RA-profile schema holds a required attribute (${candidates.length ? reasons.join('; ') : 'no connected authority'}); the suite never creates an authority` };
}

/**
 * Valid RA-profile attributes for an authority, COPIED read-only from an enabled pre-existing RA profile there (the first by
 * name), as request attributes; undefined when the authority has no such RA profile (the arms then start from nothing).
 */
export async function validRaAttributes(api: APIRequestContext, authorityUuid: string): Promise<JsonObject[] | undefined> {
    const all = readJsonOk<JsonObject[]>(await readAnswer(api, '/api/v1/raProfiles'), 'GET /v1/raProfiles');
    const source = (Array.isArray(all) ? all : [])
        .filter((r) => r?.authorityInstanceUuid === authorityUuid && r.enabled === true && !hasRunFamilyPrefix(String(r.name)))
        .sort((a, b) => (String(a.name) < String(b.name) ? -1 : String(a.name) > String(b.name) ? 1 : 0))[0];
    if (!source) return undefined;
    const detail = readJsonOk<JsonObject>(await readAnswer(api, `/api/v1/authorities/${authorityUuid}/raProfiles/${source.uuid}`), 'GET RA profile detail');
    const attributes = (Array.isArray(detail?.attributes) ? (detail.attributes as JsonObject[]) : []).filter((a) => !a.type || a.type === 'data').map(toRequestAttribute);
    return attributes.length ? attributes : undefined;
}

/**
 * A `POST /v1/authorities/{a}/raProfiles` body: the attributes under test plus the custom attributes the tier requires (core checks them
 * first).
 */
export async function raProfileBody(api: APIRequestContext, name: string, attributes: JsonObject[]): Promise<JsonObject> {
    return { name, description: 'API-GEN-28 required-attribute probe', attributes, customAttributes: await requiredCustomAttributes(api, 'raProfiles', runName('ca')) };
}

/**
 * `POST /v1/authorities/{authority}/raProfiles` (the authority is a scope parent); an accepted create is in the ledger before this returns.
 */
export async function probeRaProfile(api: GuardedApi, spec: string, authorityUuid: string, body: JsonObject, note = 'RA profile create probe'): Promise<ApiAnswer> {
    return probeCollectionCreate(api, spec, { type: 'raProfiles', path: `/api/v1/authorities/${authorityUuid}/raProfiles`, body, note, parents: { authority: authorityUuid } });
}

/** `POST /v1/authorities/{authority}/attributes/raProfile/validate` (a read-only validation POST): status and body never throw. */
export async function validateRaAttributes(api: GuardedApi, authorityUuid: string, attributes: JsonObject[]): Promise<ApiAnswer> {
    return send(assertGuarded(api, 'validateRaAttributes'), 'POST', `/api/v1/authorities/${authorityUuid}/attributes/raProfile/validate`, { data: attributes });
}
