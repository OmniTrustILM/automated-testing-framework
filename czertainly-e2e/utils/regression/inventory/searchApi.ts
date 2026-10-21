/**
 * Status-and-body helpers of the certificate search API: `send` never throws on a status and returns a `Probe`, so a
 * negative can assert the status and the body; filter and sort builders, the absolute condition sets of each field type,
 * the catalogue reader and paged search reads. Every function that can send a non-GET takes the guarded `api` fixture.
 */
import type { APIRequestContext } from '@playwright/test';
import type { GuardedApi } from '../guard/types';

export type Json = Record<string, any>;

// ------------------------------------------------------------------ one request, never throwing on a status

/** What a request answered: status, headers (lower-cased), raw text, parsed JSON (undefined when empty or not JSON), duration. */
export interface Probe {
    status: number;
    contentType: string;
    headers: Record<string, string>;
    text: string;
    json: unknown;
    ms: number;
}

export interface SendOptions {
    data?: unknown;
    params?: Record<string, string | number | boolean>;
    headers?: Record<string, string>;
    /** The guard's own switch: allow identity headers (authorization, ssl-client-cert, cookie) for a 401 / 403 negative. */
    identityOverride?: boolean;
    timeout?: number;
}

async function toProbe(res: { status(): number; headers(): Record<string, string>; text(): Promise<string> }, started: number): Promise<Probe> {
    const text = await res.text();
    let json: unknown;
    try {
        json = text ? JSON.parse(text) : undefined;
    } catch {
        json = undefined;
    }
    const headers = res.headers();
    return { status: res.status(), contentType: headers['content-type'] ?? '', headers, text, json, ms: Date.now() - started };
}

/** One request through the guarded context; the status never throws. The guard may still refuse the request (OwnObjectViolation). */
export async function send(api: GuardedApi, method: 'GET' | 'POST' | 'PUT' | 'PATCH' | 'DELETE', url: string, opts: SendOptions = {}): Promise<Probe> {
    const started = Date.now();
    const res = await api.fetch(url, { method, ...opts });
    return toProbe(res, started);
}

/** A GET through any context (the `request` fixture without credentials, or a guarded one); the status never throws. */
export async function readProbe(api: APIRequestContext, url: string, opts: { headers?: Record<string, string>; params?: Record<string, string | number | boolean>; timeout?: number } = {}): Promise<Probe> {
    const started = Date.now();
    const res = await api.get(url, { failOnStatusCode: false, ...opts });
    return toProbe(res, started);
}

/** The JSON body of a probe that must be a 2xx; else throws with the status and the first 300 characters. */
export function readJsonOk<T = any>(p: Probe, what: string): T {
    if (p.status < 200 || p.status > 299) throw new Error(`${what}: answered ${p.status} ${p.text.slice(0, 300)}`);
    return p.json as T;
}

// ------------------------------------------------------------------ the search request shape (SearchRequestDto)

export interface Filter {
    fieldSource: 'property' | 'meta' | 'custom' | 'data';
    fieldIdentifier: string;
    condition: string;
    /** Absent for EMPTY / NOT_EMPTY (the UI sends no `value` key for them). */
    value?: unknown;
}

export interface Sort {
    fieldSource: 'property' | 'meta' | 'custom' | 'data';
    fieldIdentifier: string;
    direction: 'asc' | 'desc';
}

export interface SearchBody {
    filters?: Filter[];
    itemsPerPage?: number;
    pageNumber?: number;
    sort?: Sort;
    columns?: unknown[];
    includeArchived?: boolean;
}

/** A property filter (`fieldSource: 'property'`). */
export const propertyFilter = (fieldIdentifier: string, condition: string, value?: unknown): Filter =>
    value === undefined ? { fieldSource: 'property', fieldIdentifier, condition } : { fieldSource: 'property', fieldIdentifier, condition, value };

/** A custom-attribute filter; `identifier` is `<name>|<CONTENT_TYPE>` (the catalogue publishes it that way). */
export const customAttributeFilter = (identifier: string, condition: string, value?: unknown): Filter =>
    value === undefined ? { fieldSource: 'custom', fieldIdentifier: identifier, condition } : { fieldSource: 'custom', fieldIdentifier: identifier, condition, value };

/** Common Name starts with the prefix: the isolation filter every exact row-set oracle carries. */
export const isolation = (prefix: string): Filter => propertyFilter('COMMON_NAME', 'STARTS_WITH', prefix);

/** Where the listing endpoints answer: `POST /api/v1/certificates` and its siblings (all POST_READ of the guard). */
export const CERTIFICATES = '/api/v1/certificates';

/** `POST /api/v1/certificates` (or another search endpoint) with a body; status and body never throw. */
export async function searchRaw(api: GuardedApi, body: SearchBody | Json, url: string = CERTIFICATES): Promise<Probe> {
    return send(api, 'POST', url, { data: body });
}

/** The rows of a list answer (`certificates`, `keys`, `discoveries`, … — the member holding the array), else []. */
export function rowsOf(body: unknown, member?: string): Json[] {
    if (Array.isArray(body)) return body as Json[];
    if (body && typeof body === 'object') {
        const o = body as Json;
        if (member && Array.isArray(o[member])) return o[member];
        const arrays = Object.entries(o).filter(([, v]) => Array.isArray(v));
        if (arrays.length === 1) return arrays[0][1] as Json[];
    }
    return [];
}

export interface PageAnswer {
    rows: Json[];
    totalItems: number;
    totalPages: number;
    pageNumber: number;
    itemsPerPage: number;
}

/** `POST` a certificate search and require 200: the page as typed numbers (a non-200 throws with the status and body). */
export async function searchPage(api: GuardedApi, body: SearchBody, opts: { url?: string; member?: string } = {}): Promise<PageAnswer> {
    const p = await searchRaw(api, body, opts.url ?? CERTIFICATES);
    const json = readJsonOk<Json>(p, `search ${JSON.stringify(body).slice(0, 200)}`);
    return {
        rows: rowsOf(json, opts.member ?? 'certificates'),
        totalItems: Number(json.totalItems),
        totalPages: Number(json.totalPages),
        pageNumber: Number(json.pageNumber),
        itemsPerPage: Number(json.itemsPerPage),
    };
}

/** Every page of a search, 1-based, with a page-count cap (the isolation filter keeps it small). */
export async function searchAllRows(api: GuardedApi, body: SearchBody, opts: { url?: string; member?: string; pageSize?: number; maxPages?: number } = {}): Promise<Json[]> {
    const pageSize = opts.pageSize ?? 100;
    const first = await searchPage(api, { ...body, itemsPerPage: pageSize, pageNumber: 1 }, opts);
    const rows = [...first.rows];
    const pages = Math.max(1, first.totalPages);
    if (pages > (opts.maxPages ?? 50)) throw new Error(`search has ${pages} pages (> ${opts.maxPages ?? 50}); narrow it with the isolation filter`);
    for (let n = 2; n <= pages; n++) rows.push(...(await searchPage(api, { ...body, itemsPerPage: pageSize, pageNumber: n }, opts)).rows);
    return rows;
}

/** The uuids of rows, sorted: the unit of a set comparison. */
export const uuidSet = (rows: Json[]): string[] => rows.map((r) => String(r.uuid)).sort();

// ------------------------------------------------------------------ the searchable-fields catalogue (GET .../search)

/** One field of a searchable-fields catalogue (interfaces SearchFieldDataDto). */
export interface CatalogueField {
    fieldIdentifier: string;
    fieldLabel: string;
    type: 'string' | 'number' | 'list' | 'date' | 'datetime' | 'boolean';
    conditions: string[];
    multiValue?: boolean;
    displayable?: boolean;
    sortable?: boolean;
    attributeContentType?: string;
    platformEnum?: string;
    value?: unknown;
}

export interface CatalogueGroup {
    filterFieldSource: 'property' | 'meta' | 'custom' | 'data';
    searchFieldData: CatalogueField[];
}

/** `GET <listing>/search` as typed groups (the certificate catalogue is `/api/v1/certificates/search`). */
export async function readCatalogue(api: APIRequestContext, url: string = `${CERTIFICATES}/search`): Promise<CatalogueGroup[]> {
    const res = await api.get(url);
    if (!res.ok()) throw new Error(`GET ${url} answered ${res.status()}`);
    return (await res.json()) as CatalogueGroup[];
}

/** The catalogue's fields of one source (`property`, `custom`, …), empty when the group is absent. */
export function fieldsOf(catalogue: CatalogueGroup[], source: CatalogueGroup['filterFieldSource']): CatalogueField[] {
    return catalogue.filter((g) => g.filterFieldSource === source).flatMap((g) => g.searchFieldData ?? []);
}

/** One field by identifier (any source), or undefined. */
export function findField(catalogue: CatalogueGroup[], fieldIdentifier: string, source?: CatalogueGroup['filterFieldSource']): CatalogueField | undefined {
    return catalogue
        .filter((g) => !source || g.filterFieldSource === source)
        .flatMap((g) => g.searchFieldData ?? [])
        .find((f) => f.fieldIdentifier === fieldIdentifier);
}

// ------------------------------------------------------------------ the absolute condition sets (core SearchFieldTypeEnum / SearchHelper)

const NUMBER_SET = ['EQUALS', 'NOT_EQUALS', 'GREATER', 'GREATER_OR_EQUAL', 'LESSER', 'LESSER_OR_EQUAL', 'EMPTY', 'NOT_EMPTY'] as const;
const COUNT_SET = ['COUNT_EQUAL', 'COUNT_NOT_EQUAL', 'COUNT_GREATER_THAN', 'COUNT_LESS_THAN'] as const;

/**
 * The condition sets of a catalogue field by TYPE (core `SearchFieldTypeEnum`, `SearchHelper`
 * at core 569e853 / main c7baaba). A field of a kind that has its own set — a collection, a native array, an expected-
 * value boolean, a presence-only or encrypted attribute — is named in `conditionKinds`.
 *
 * ⚠ Deviation from "boolean: 2 conditions": the code gives a BOOLEAN field four conditions
 * (EQUALS, NOT_EQUALS, EMPTY, NOT_EMPTY) and only an expected-value field (PRIVATE_KEY, `CBOM_HAS_CONTRIBUTED_ASSETS`)
 * two. The business rules agree with the code.
 */
export const CONDITION_SETS: Readonly<Record<string, readonly string[]>> = {
    string: ['CONTAINS', 'NOT_CONTAINS', 'EQUALS', 'NOT_EQUALS', 'EMPTY', 'NOT_EMPTY', 'STARTS_WITH', 'ENDS_WITH', 'MATCHES', 'NOT_MATCHES'],
    number: NUMBER_SET,
    date: [...NUMBER_SET, 'IN_NEXT', 'IN_PAST'],
    datetime: [...NUMBER_SET, 'IN_NEXT', 'IN_PAST'],
    list: ['EQUALS', 'NOT_EQUALS', 'EMPTY', 'NOT_EMPTY'],
    boolean: ['EQUALS', 'NOT_EQUALS', 'EMPTY', 'NOT_EMPTY'],
};

/** Sets of the special kinds (collection list, native array, expected-value boolean, presence-only). */
export const CONDITION_KINDS: Readonly<Record<string, readonly string[]>> = {
    collection: [...CONDITION_SETS.list, ...COUNT_SET],
    nativeArray: ['CONTAINS', 'NOT_CONTAINS', 'EQUALS', 'NOT_EQUALS', 'EMPTY', 'NOT_EMPTY'],
    expectedBoolean: ['EQUALS', 'NOT_EQUALS'],
    presence: ['EMPTY', 'NOT_EMPTY'],
    /** TIME attributes: the date set without IN_NEXT / IN_PAST (SearchHelper.prepareSearchForJSON). */
    time: NUMBER_SET,
};

/** Every condition of the FilterConditionOperator enum (interfaces model/core/search/FilterConditionOperator.java). */
export const ALL_CONDITIONS: readonly string[] = [
    'EQUALS', 'NOT_EQUALS', 'GREATER', 'GREATER_OR_EQUAL', 'LESSER', 'LESSER_OR_EQUAL', 'CONTAINS', 'NOT_CONTAINS', 'STARTS_WITH', 'ENDS_WITH',
    'EMPTY', 'NOT_EMPTY', 'IN_NEXT', 'IN_PAST', 'MATCHES', 'NOT_MATCHES', 'COUNT_EQUAL', 'COUNT_NOT_EQUAL', 'COUNT_GREATER_THAN', 'COUNT_LESS_THAN',
];

/** Same members, any order. */
export const sameSet = (a: readonly string[], b: readonly string[]): boolean => a.length === b.length && [...a].sort().join('|') === [...b].sort().join('|');
