/**
 * customAttributes — request attributes the helpers send: own custom attribute definitions, the one filler of the required custom
 * attributes a tier defines, and response → request copies.
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

export class UnfillableAttributeError extends Error {
    constructor(message: string) {
        super(message);
        this.name = 'UnfillableAttributeError';
    }
}

export interface OwnCustomAttribute extends OwnRef {
    attributeName: string;
    contentType: string;
}

export interface CustomAttributeOptions {
    resources?: string[];
    contentType?: string;
    options?: string[];
    multiSelect?: boolean;
    label?: string;
    description?: string;
    name?: string;
    note?: string;
}

/** An own custom attribute definition (NEVER required: a required one would break other users' forms), visible and writable, recorded. */
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

/** A request custom attribute that sets `attr` to `value`; the content type is the attribute's own when it has one, else `string`. */
export const customAttributeRequest = (attr: { uuid: string; name: string; contentType?: string }, value: unknown): JsonObject => ({
    uuid: attr.uuid,
    name: attr.name,
    contentType: attr.contentType ?? 'string',
    content: [{ data: value }],
});

export function customAttributeValue(detail: JsonObject, name: string): unknown {
    const a = ((detail.customAttributes ?? []) as JsonObject[]).find((x) => x.name === name);
    const item = rowsOf(a?.content)[0];
    return item?.data;
}

export function toRequestAttribute(a: JsonObject): JsonObject {
    return { version: requestVersion(a), uuid: a.uuid, name: a.name, contentType: a.contentType, content: a.content };
}

/**
 * Values for the REQUIRED custom attributes a tier defines on a resource (a create without them answers 422): every
 * request attribute carries the definition's normalised `version` and every content item its `contentType` (a v2-shaped
 * list item never matches the predefined list); a list gets its first predefined item copied; any other required type
 * that cannot be filled throws. Definitions are only read; one helper for every creator of an own object.
 */
export type CustomAttributeResource = string;

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
 * Request attributes from a LIVE definition list (pure): `values` by name win, a required data attribute gets a value by content type, a
 * type the suite cannot fill throws (never a guess); `info` / `group` definitions are skipped.
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
        if (version === 'v3') content = content.map((item) => ({ ...item, contentType: item.contentType ?? type }));
        out.push({ name: d.name, uuid: d.uuid, version, contentType: type, content });
    }
    return out;
}

export const toRequestAttributes = (attributes: JsonObject[] | undefined): JsonObject[] =>
    (attributes ?? []).filter((a) => !a.type || a.type === 'data').map((a) => ({ version: requestVersion(a), uuid: a.uuid, name: a.name, contentType: a.contentType, content: a.content }));
