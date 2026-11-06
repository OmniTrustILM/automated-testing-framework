import { JsonObject } from '../json';
import { objectOf } from '../json';
/**
 * raProfileSchema — the RA-profile attribute schema of an authority read as data: required writable attributes, the order authorities are
 * tried in, and the lazy choice of the first with a required attribute.
 */

export interface RequiredAttribute {
    name: string;
    label: string;
    contentType: string;
    select: boolean;
}

/**
 * The required attributes of a RA-profile schema (pure): data attributes
 * with `properties.required`, not read-only, visible; v2 and v3 alike.
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

/** The order authorities are tried in (pure): the run's own first, then every CONNECTED one; a disconnected one is never chosen. */
export function authorityCandidates(authorities: Array<{ uuid: string; name: string; status?: string }>, ownAuthorityUuid?: string): Array<{ uuid: string; name: string }> {
    return [...authorities.filter((a) => a.uuid === ownAuthorityUuid), ...authorities.filter((a) => a.uuid !== ownAuthorityUuid && a.status === 'connected')].map((a) => ({ uuid: a.uuid, name: a.name }));
}

/**
 * The first candidate whose schema (read lazily through `schemaOf`, read-only;
 * unreadable = undefined) declares a required attribute, or undefined.
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
