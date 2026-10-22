/**
 * customAttributes — everything about request attributes the helpers send: own custom attribute definitions, the request
 * item that sets one and the value read back from a detail; the ONE filler of the required custom attributes a tier
 * defines on a resource (`requiredCustomAttributes`); the response → request copies (`toRequestAttribute`,
 * `toRequestAttributes`) and the filler of a live connector definition list (`requestAttributesFrom`).
 */
import type { APIRequestContext } from '@playwright/test';
import { apiJson } from './apiReads';
import { requestVersion } from './attributeVersion';
import type { AttributeDefinition } from './platform/cryptoAlgorithmCases';
import { GuardedApi } from './guard/types';
import { createOwn } from './ownCrud';
import type { OwnRef } from './ledger/ledger';
import { runId, ownName } from './ledger/runState';
import type { JsonObject } from './json';
import { objectOf, rowsOf } from './json';

/** A required attribute of a type the suite cannot fill: a test that cannot proceed on this tier skips on THIS error and on no other. */
export class UnfillableAttributeError extends Error {
    constructor(message: string) {
        super(message);
        this.name = 'UnfillableAttributeError';
    }
}

export interface OwnCustomAttribute extends OwnRef {
    /** The attribute name (the `name|contentType` field identifier part). */
    attributeName: string;
    contentType: string;
}

export interface CustomAttributeOptions {
    /** The resources the definition applies to (default `certificates`). */
    resources?: string[];
    /** The content type code (default `string`). */
    contentType?: string;
    /** A list attribute with these predefined options (`{ reference: data, data }` each). */
    options?: string[];
    /** A list attribute accepts several values unless this is false. */
    multiSelect?: boolean;
    label?: string;
    description?: string;
    /** A planned name (the seed's isolation prefix); default `ownName(suffix)`. */
    name?: string;
    note?: string;
}

/**
 * An own custom attribute definition (NEVER required: a required one would break other users' forms) on the given
 * resources, visible and writable, recorded. The definition name is the ledger name.
 */
export async function createOwnCustomAttribute(api: GuardedApi, spec: string, suffix: string, o: CustomAttributeOptions = {}): Promise<OwnCustomAttribute> {
    const name = o.name ?? ownName(suffix);
    const contentType = o.contentType ?? 'string';
    const created = await createOwn(api, spec, {
        type: 'customAttributes',
        path: '/api/v1/attributes/custom',
        name,
        note: o.note ?? 'own custom attribute (never required)',
        body: {
            label: o.label ?? name,
            description: o.description ?? `REG run ${runId()}`,
            contentType,
            required: false,
            visible: true,
            readOnly: false,
            list: !!o.options,
            multiSelect: !!o.options && o.multiSelect !== false,
            ...(o.options ? { extensibleList: false, content: o.options.map((data) => ({ reference: data, data })) } : {}),
            resources: o.resources ?? ['certificates'],
        },
    });
    const { answer: _answer, ...ref } = created;
    return { ...ref, attributeName: name, contentType };
}

/**
 * A request custom attribute that sets `attr` to `value`: `{ uuid, name, contentType, content: [{ data }] }`. The content type
 * is the attribute's own when it carries one (`OwnCustomAttribute`), else `string`.
 */
export const customAttributeRequest = (attr: { uuid: string; name: string; contentType?: string }, value: unknown): JsonObject => ({
    uuid: attr.uuid,
    name: attr.name,
    contentType: attr.contentType ?? 'string',
    content: [{ data: value }],
});

/** The text of a custom attribute on a certificate detail, or undefined (`customAttributes: [{ name, content: [{ data }] }]`). */
export function customAttributeValue(detail: JsonObject, name: string): unknown {
    const a = ((detail.customAttributes ?? []) as JsonObject[]).find((x) => x.name === name);
    const item = rowsOf(a?.content)[0];
    return item?.data;
}

// ------------------------------------------------------------------ request attributes and the required-attribute filler

/** A response attribute (`ResponseAttribute` v2 / v3) as the request attribute that sets the same content. */
export function toRequestAttribute(a: JsonObject): JsonObject {
    return { version: requestVersion(a), uuid: a.uuid, name: a.name, contentType: a.contentType, content: a.content };
}

/**
 * Values for the REQUIRED custom attributes a tier defines on a resource (`GET /v1/attributes/custom/resources/{r}`):
 * a create without them answers 422 on such a tier. Optional attributes are left out. EVERY request attribute carries the
 * definition's `version` normalised by `requestVersion` (core sends a NUMBER, 3 / 2; v3 when the definition omits it: custom attributes are v3 in core) and EVERY content item its
 * `contentType`: `RequestAttribute` is polymorphic on `version` with a v2 default whose content items have no content type,
 * and `AttributeEngine.validateExtensibleList` compares reference, data AND contentType of a list item, so a v2-shaped item
 * never matches ("not part of predefined list", 422 — seen on a live tier, 37 tests; the UI works because it sends v3). A list gets its
 * first predefined content item COPIED AS IS (completed with the contentType when the definition's item lacks it); string-like
 * types get `value`, numbers 1, booleans true, `date` today (UTC, yyyy-MM-dd), `time` HH:mm:ss, `datetime` ISO local without a
 * zone; any other required type throws (a setup the suite cannot fill). Nothing is ever created on the tier here: definitions
 * are only read. ONE helper: every creator of an own object calls it.
 */
export type CustomAttributeResource = string;

/** The pure part of `requiredCustomAttributes` (unit-tested per content type): definitions in, request attributes out. */
export function requiredAttributeItems(defs: JsonObject[] | undefined, resource: string, value: string, now: Date = new Date()): JsonObject[] {
    const out: JsonObject[] = [];
    const iso = now.toISOString();
    for (const d of defs ?? []) {
        const props = objectOf(d?.properties);
        if (!props.required) continue;
        const type = String(d.contentType);
        let item: JsonObject;
        if (props.list && Array.isArray(d.content) && d.content.length) item = { ...(d.content[0] as JsonObject), contentType: (d.content[0] as JsonObject).contentType ?? type };
        else if (['string', 'text', 'codeblock'].includes(type)) item = { data: value, contentType: type };
        else if (['integer', 'float'].includes(type)) item = { data: 1, contentType: type };
        else if (type === 'boolean') item = { data: true, contentType: type };
        else if (type === 'date') item = { data: iso.slice(0, 10), contentType: type };
        else if (type === 'time') item = { data: iso.slice(11, 19), contentType: type };
        else if (type === 'datetime') item = { data: iso.slice(0, 19), contentType: type };
        else throw new UnfillableAttributeError(`required custom attribute ${d.uuid} on ${resource} has content type ${type}, which the suite cannot fill`);
        out.push({ version: requestVersion(d, 'v3'), uuid: d.uuid, name: d.name, contentType: type, content: [item] });
    }
    return out;
}

export async function requiredCustomAttributes(api: APIRequestContext, resource: CustomAttributeResource, value: string): Promise<JsonObject[]> {
    return requiredAttributeItems(await apiJson<JsonObject[]>(api, 'GET', `/api/v1/attributes/custom/resources/${resource}`), resource, value);
}

/**
 * Request attributes from a LIVE definition list (pure): `values` by attribute name win; otherwise a required DATA
 * attribute gets a value by content type (string / text → `fallback`, secret → `{secret: fallback}`, boolean → false,
 * integer → 1, a list → its first option); optional attributes without a value are left out; a required attribute of
 * a type the suite cannot fill throws (never a guess). `info` / `group` definitions are skipped.
 */
export function requestAttributesFrom(defs: AttributeDefinition[], values: Record<string, unknown> = {}, fallback = 'qa'): JsonObject[] {
    const out: JsonObject[] = [];
    for (const d of defs) {
        if (d.type && !/^data$/i.test(d.type)) continue;
        const type = String(d.contentType ?? 'string');
        const given = values[d.name];
        let content: JsonObject[] | undefined;
        if (given !== undefined) {
            content = type === 'secret' && (typeof given === 'string') ? [{ data: { secret: given } }] : [{ data: given }];
        } else if (d.properties?.required) {
            if (d.properties.list && d.content?.length) content = [{ ...(d.content[0] as unknown as JsonObject), contentType: (d.content[0] as unknown as JsonObject).contentType ?? type }];
            else if (['string', 'text', 'codeblock'].includes(type)) content = [{ data: fallback }];
            else if (type === 'secret') content = [{ data: { secret: fallback } }];
            else if (type === 'boolean') content = [{ data: false }];
            else if (['integer', 'float'].includes(type)) content = [{ data: 1 }];
            else throw new UnfillableAttributeError(`required attribute ${d.name} has content type ${type}, which the suite cannot fill`);
        }
        if (!content) continue;
        const version = requestVersion(d);
        // a v3 content item is read by its own contentType (BaseAttributeContentV3, no default subtype); a v2 item has none
        if (version === 'v3') content = content.map((item) => ({ ...item, contentType: item.contentType ?? type }));
        out.push({ name: d.name, uuid: d.uuid, version, contentType: type, content });
    }
    return out;
}

/** Response attribute → request attribute (data attributes only), for copying a pre-existing object's settings. */
export const toRequestAttributes = (attributes: JsonObject[] | undefined): JsonObject[] =>
    (attributes ?? []).filter((a) => !a.type || a.type === 'data').map((a) => ({ version: requestVersion(a), uuid: a.uuid, name: a.name, contentType: a.contentType, content: a.content }));
