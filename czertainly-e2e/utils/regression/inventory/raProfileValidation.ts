/**
 * raProfileValidation — RA-profile helpers of the required-attribute API spec: the missing and empty attribute arms, core's refusal texts
 * and create / validate probes (an accepted create is in the ledger first).
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

export const labelOf = (def: JsonObject): string => String(objectOf(def?.properties).label ?? def?.label ?? def?.name ?? '');


export { requestVersion };

export const requiredAttributeNotFoundText = (label: string): string => `Required attribute ${label} not found.`;

export const requiredAttributeNotSetText = (label: string): string => `Value of required attribute ${label} not set.`;

export const missingAttributeCase = (base: readonly JsonObject[], def: JsonObject): JsonObject[] => base.filter((a) => a?.name !== def.name);

export const emptyAttributeCase = (base: readonly JsonObject[], def: JsonObject): JsonObject[] => [
    ...missingAttributeCase(base, def),
    { version: requestVersion(def), uuid: def.uuid, name: def.name, contentType: String(def.contentType).toLowerCase() },
];

/** Core's own text for a v3 authority: the attribute is not in the request. */
const engineAttributeNotProvidedText = (name: string): string => `Content for required Data attribute ${name} is not provided.`;

/** Core's own text for a v3 authority: the attribute is listed without content. */
const ENGINE_ATTRIBUTE_NO_CONTENT_TEXT = 'Attribute is required and no content is sent';

/** The connector interface of an authority: v3 is validated by core's attribute engine, v1 / v2 relay the connector's text. */
export type AuthorityInterface = 'v2' | 'v3';

/** The interface of an authority row (`connectorInterface.version`; null for a legacy connector, which relays like v2). */
export const authorityInterfaceOf = (row: JsonObject): AuthorityInterface => (String(objectOf(row?.connectorInterface).version ?? '').toLowerCase() === 'v3' ? 'v3' : 'v2');

/** The oracle of a required-attribute refusal: the message that must be present and the attribute reference it must carry. */
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
    connectorInterface: AuthorityInterface;
    required: JsonObject[];
}

/**
 * The first connected pre-existing authority (by name) whose RA-profile schema has a required data attribute, or the reason there is none;
 * read-only, at most `max` authorities.
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

/** Valid RA-profile attributes copied read-only from the first enabled pre-existing RA profile of the authority; undefined when it has none. */
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

/** A `POST /v1/authorities/{a}/raProfiles` body: the attributes under test plus the tier's required custom attributes. */
export async function raProfileBody(api: APIRequestContext, name: string, attributes: JsonObject[]): Promise<JsonObject> {
    return { name, description: 'API-GEN-28 required-attribute probe', attributes, customAttributes: await requiredCustomAttributes(api, 'raProfiles', runName('ca')) };
}

/** `POST /v1/authorities/{authority}/raProfiles`; an accepted create is in the ledger before this returns. */
export async function probeRaProfile(api: GuardedApi, spec: string, authorityUuid: string, body: JsonObject, note = 'RA profile create probe'): Promise<ApiAnswer> {
    return probeCollectionCreate(api, spec, { type: 'raProfiles', path: `/api/v1/authorities/${authorityUuid}/raProfiles`, body, note, parents: { authority: authorityUuid } });
}

export async function validateRaAttributes(api: GuardedApi, authorityUuid: string, attributes: JsonObject[]): Promise<ApiAnswer> {
    return send(assertGuarded(api, 'validateRaAttributes'), 'POST', `/api/v1/authorities/${authorityUuid}/attributes/raProfile/validate`, { data: attributes });
}
