import { JsonObject } from '../json';
import { objectOf } from '../json';
/**
 * The RA-profile attribute schema of an authority, read as data: the required, writable attributes it declares, the
 * order authorities are tried in (the run's own first, then connected ones), and the lazy choice of the first authority
 * whose schema has a required attribute. Pure apart from the schema reader the caller passes.
 */

/** A required, writable data attribute of an authority's RA-profile schema (`GET /v1/authorities/{uuid}/attributes/raProfile`). */
export interface RequiredAttribute {
    name: string;
    label: string;
    contentType: string;
    /** The attribute offers a list / callback: the form renders a Select. */
    select: boolean;
}

/**
 * The required attributes a RA-profile schema declares (pure): data attributes with `properties.required`, not read-only,
 * visible. v2 / v3 attributes alike (`properties` carries the flags in both). The label falls back to the name.
 */
export function requiredRaProfileAttributes(schema: JsonObject[] | undefined): RequiredAttribute[] {
    return (schema ?? [])
        .filter((a) => (!a.type || a.type === 'data') && objectOf(a.properties).required === true && objectOf(a.properties).readOnly !== true && objectOf(a.properties).visible !== false)
        .map((a) => ({
            name: String(a.name),
            label: String(objectOf(a.properties).label ?? a.name),
            contentType: String(a.contentType ?? 'string'),
            select: objectOf(a.properties).list === true || (Array.isArray(a.content) && a.content.length > 0) || !!a.attributeCallback,
        }));
}

export interface AuthorityChoice {
    uuid: string;
    name: string;
    required: RequiredAttribute[];
}

/**
 * The order authorities are tried in (pure): the run's own authority first when it is given, then every CONNECTED one in
 * list order. A disconnected authority is never chosen (its connector cannot answer the schema).
 */
export function authorityCandidates(authorities: Array<{ uuid: string; name: string; status?: string }>, ownAuthorityUuid?: string): Array<{ uuid: string; name: string }> {
    return [...authorities.filter((a) => a.uuid === ownAuthorityUuid), ...authorities.filter((a) => a.uuid !== ownAuthorityUuid && a.status === 'connected')].map((a) => ({ uuid: a.uuid, name: a.name }));
}

/**
 * Which authority to open the form with: the first candidate whose RA-profile schema (read through `schemaOf`, read-only; a
 * schema that cannot be read is `undefined`) declares a required attribute. Undefined when none qualifies. Schemas are read
 * lazily, one authority at a time, so a long list costs nothing once an authority qualifies.
 */
export async function chooseAuthorityWithRequiredAttribute(
    authorities: Array<{ uuid: string; name: string; status?: string }>,
    schemaOf: (authorityUuid: string) => Promise<JsonObject[] | undefined>,
    ownAuthorityUuid?: string,
): Promise<AuthorityChoice | undefined> {
    for (const a of authorityCandidates(authorities, ownAuthorityUuid)) {
        const required = requiredRaProfileAttributes(await schemaOf(a.uuid));
        if (required.length) return { uuid: a.uuid, name: a.name, required };
    }
    return undefined;
}
