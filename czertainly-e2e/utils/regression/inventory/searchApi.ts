/**
 * searchApi — status-and-body helpers of the certificate search API: `send` never throws on a status, filter and sort builders, the
 * absolute condition sets per field type, the catalogue reader and paged reads. Non-GET calls take the guarded `api`.
 */
import type { APIRequestContext } from '@playwright/test';
import type { GuardedApi } from '../guard/types';
import { ApiAnswer, answerOf } from '../apiReads';
import type { JsonObject } from '../json';


export interface SendOptions {
    data?: unknown;
    params?: Record<string, string | number | boolean>;
    headers?: Record<string, string>;
    identityOverride?: boolean;
    timeout?: number;
}

export async function send(api: GuardedApi, method: 'GET' | 'POST' | 'PUT' | 'PATCH' | 'DELETE', url: string, opts: SendOptions = {}): Promise<ApiAnswer> {
    const started = Date.now();
    const res = await api.fetch(url, { method, ...opts });
    return answerOf(res, started);
}

export async function readAnswer(api: APIRequestContext, url: string, opts: { headers?: Record<string, string>; params?: Record<string, string | number | boolean>; timeout?: number } = {}): Promise<ApiAnswer> {
    const started = Date.now();
    const res = await api.get(url, { failOnStatusCode: false, ...opts });
    return answerOf(res, started);
}

export function readJsonOk<T = any>(p: ApiAnswer, what: string): T {
    if (p.status < 200 || p.status > 299) throw new Error(`${what}: answered ${p.status} ${p.text.slice(0, 300)}`);
    return p.json as T;
}


export interface Filter {
    fieldSource: 'property' | 'meta' | 'custom' | 'data';
    fieldIdentifier: string;
    condition: string;
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

export const propertyFilter = (fieldIdentifier: string, condition: string, value?: unknown): Filter =>
    value === undefined ? { fieldSource: 'property', fieldIdentifier, condition } : { fieldSource: 'property', fieldIdentifier, condition, value };

export const customAttributeFilter = (identifier: string, condition: string, value?: unknown): Filter =>
    value === undefined ? { fieldSource: 'custom', fieldIdentifier: identifier, condition } : { fieldSource: 'custom', fieldIdentifier: identifier, condition, value };

export const isolation = (prefix: string): Filter => propertyFilter('COMMON_NAME', 'STARTS_WITH', prefix);

export const CERTIFICATES = '/api/v1/certificates';

export async function searchRaw(api: GuardedApi, body: SearchBody | JsonObject, url: string = CERTIFICATES): Promise<ApiAnswer> {
    return send(api, 'POST', url, { data: body });
}

export function rowsOf(body: unknown, member?: string): JsonObject[] {
    if (Array.isArray(body)) return body as JsonObject[];
    if (body && typeof body === 'object') {
        const o = body as JsonObject;
        if (member && Array.isArray(o[member])) return o[member];
        const arrays = Object.entries(o).filter(([, v]) => Array.isArray(v));
        if (arrays.length === 1) return arrays[0][1] as JsonObject[];
    }
    return [];
}

export interface PageAnswer {
    rows: JsonObject[];
    totalItems: number;
    totalPages: number;
    pageNumber: number;
    itemsPerPage: number;
}

export async function searchPage(api: GuardedApi, body: SearchBody, opts: { url?: string; member?: string } = {}): Promise<PageAnswer> {
    const p = await searchRaw(api, body, opts.url ?? CERTIFICATES);
    const json = readJsonOk<JsonObject>(p, `search ${JSON.stringify(body).slice(0, 200)}`);
    return {
        rows: rowsOf(json, opts.member ?? 'certificates'),
        totalItems: Number(json.totalItems),
        totalPages: Number(json.totalPages),
        pageNumber: Number(json.pageNumber),
        itemsPerPage: Number(json.itemsPerPage),
    };
}

export async function searchAllRows(api: GuardedApi, body: SearchBody, opts: { url?: string; member?: string; pageSize?: number; maxPages?: number } = {}): Promise<JsonObject[]> {
    const pageSize = opts.pageSize ?? 100;
    const first = await searchPage(api, { ...body, itemsPerPage: pageSize, pageNumber: 1 }, opts);
    const rows = [...first.rows];
    const pages = Math.max(1, first.totalPages);
    if (pages > (opts.maxPages ?? 50)) throw new Error(`search has ${pages} pages (> ${opts.maxPages ?? 50}); narrow it with the isolation filter`);
    for (let n = 2; n <= pages; n++) rows.push(...(await searchPage(api, { ...body, itemsPerPage: pageSize, pageNumber: n }, opts)).rows);
    return rows;
}

export const uuidSet = (rows: JsonObject[]): string[] => rows.map((r) => String(r.uuid)).sort();


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

export async function readCatalogue(api: APIRequestContext, url: string = `${CERTIFICATES}/search`): Promise<CatalogueGroup[]> {
    const res = await api.get(url);
    if (!res.ok()) throw new Error(`GET ${url} answered ${res.status()}`);
    return (await res.json()) as CatalogueGroup[];
}

export function fieldsOf(catalogue: CatalogueGroup[], source: CatalogueGroup['filterFieldSource']): CatalogueField[] {
    return catalogue.filter((g) => g.filterFieldSource === source).flatMap((g) => g.searchFieldData ?? []);
}

export function findField(catalogue: CatalogueGroup[], fieldIdentifier: string, source?: CatalogueGroup['filterFieldSource']): CatalogueField | undefined {
    return catalogue
        .filter((g) => !source || g.filterFieldSource === source)
        .flatMap((g) => g.searchFieldData ?? [])
        .find((f) => f.fieldIdentifier === fieldIdentifier);
}


const NUMBER_SET = ['EQUALS', 'NOT_EQUALS', 'GREATER', 'GREATER_OR_EQUAL', 'LESSER', 'LESSER_OR_EQUAL', 'EMPTY', 'NOT_EMPTY'] as const;
const COUNT_SET = ['COUNT_EQUAL', 'COUNT_NOT_EQUAL', 'COUNT_GREATER_THAN', 'COUNT_LESS_THAN'] as const;

/**
 * The condition sets of a catalogue field by type. A BOOLEAN field has four conditions (EQUALS, NOT_EQUALS, EMPTY, NOT_EMPTY);
 * only an expected-value field (PRIVATE_KEY, `CBOM_HAS_CONTRIBUTED_ASSETS`) has two. Special kinds are named in `conditionKinds`.
 */
export const CONDITION_SETS: Readonly<Record<string, readonly string[]>> = {
    string: ['CONTAINS', 'NOT_CONTAINS', 'EQUALS', 'NOT_EQUALS', 'EMPTY', 'NOT_EMPTY', 'STARTS_WITH', 'ENDS_WITH', 'MATCHES', 'NOT_MATCHES'],
    number: NUMBER_SET,
    date: [...NUMBER_SET, 'IN_NEXT', 'IN_PAST'],
    datetime: [...NUMBER_SET, 'IN_NEXT', 'IN_PAST'],
    list: ['EQUALS', 'NOT_EQUALS', 'EMPTY', 'NOT_EMPTY'],
    boolean: ['EQUALS', 'NOT_EQUALS', 'EMPTY', 'NOT_EMPTY'],
};

export const CONDITION_KINDS: Readonly<Record<string, readonly string[]>> = {
    collection: [...CONDITION_SETS.list, ...COUNT_SET],
    nativeArray: ['CONTAINS', 'NOT_CONTAINS', 'EQUALS', 'NOT_EQUALS', 'EMPTY', 'NOT_EMPTY'],
    expectedBoolean: ['EQUALS', 'NOT_EQUALS'],
    presence: ['EMPTY', 'NOT_EMPTY'],
    time: NUMBER_SET,
};

export const ALL_CONDITIONS: readonly string[] = [
    'EQUALS', 'NOT_EQUALS', 'GREATER', 'GREATER_OR_EQUAL', 'LESSER', 'LESSER_OR_EQUAL', 'CONTAINS', 'NOT_CONTAINS', 'STARTS_WITH', 'ENDS_WITH',
    'EMPTY', 'NOT_EMPTY', 'IN_NEXT', 'IN_PAST', 'MATCHES', 'NOT_MATCHES', 'COUNT_EQUAL', 'COUNT_NOT_EQUAL', 'COUNT_GREATER_THAN', 'COUNT_LESS_THAN',
];

export const sameSet = (a: readonly string[], b: readonly string[]): boolean => a.length === b.length && [...a].sort().join('|') === [...b].sort().join('|');
