import { isCanonicalUuid, isUuidField, merge, findUuidsInString, FoundUuids } from './uuids';
import { NO_BASE } from './urls';
import { REFERENCE_FIELDS } from './allowLists';
import { ATTRIBUTE_KEY, isPlainObject } from './targets';
import { BODY_FIELD_TYPES, ledgerTypeOfResource, LIST_ELEMENT, SIBLING_TYPED_FIELDS } from './routes';

const KEY_DESTINATION = /^keydestination$/i;
const ENTRY_REFERENCE = /^[0-9a-f]{64}$/;
const MAX_IMPORT_ENTRIES = 250;

function findKey(value: unknown, re: RegExp): string | undefined {
    const stack: unknown[] = [value];
    while (stack.length) {
        const v = stack.pop();
        if (Array.isArray(v)) stack.push(...v);
        else if (isPlainObject(v)) {
            for (const [k, x] of Object.entries(v)) {
                if (re.test(k)) return k;
                stack.push(x);
            }
        }
    }
    return undefined;
}

/**
 * The `POST /v1/certificates/import` body the guard lets through: certificate-only entries (a `keyDestination` anywhere is refused, so the
 * key import is unreachable).
 */
export function importBodyShapeProblem(view: BodyView): string | undefined {
    const where = 'POST /v1/certificates/import (certificate-only entries)';
    if (view.kind !== 'json') return `${where}: the body must be a JSON object (a non-JSON Buffer or text is refused on this route)`;
    const body = view.value;
    if (!isPlainObject(body)) return `${where}: the body must be a JSON object`;
    const hidden = findKey(body, KEY_DESTINATION);
    if (hidden !== undefined) return `${where}: a "${hidden.slice(0, 24)}" key (a key import writes into a token profile and may update a pre-existing key record)`;
    const allowed = new Set(['file', 'entries', 'passphrase', 'customAttributes']);
    const extra = Object.keys(body).filter((k) => !allowed.has(k));
    if (extra.length) return `${where}: a top-level key the shape rule does not allow (${extra.slice(0, 3).map((k) => JSON.stringify(k.slice(0, 24))).join(', ')})`;
    if (typeof body.file !== 'string') return `${where}: "file" must be a string`;
    if (body.passphrase !== undefined && typeof body.passphrase !== 'string') return `${where}: "passphrase" must be a string when given`;
    const entries = body.entries;
    if (!Array.isArray(entries) || !entries.length) return `${where}: "entries" must be a non-empty array`;
    if (entries.length > MAX_IMPORT_ENTRIES) return `${where}: more than ${MAX_IMPORT_ENTRIES} entries`;
    for (const e of entries) {
        if (!isPlainObject(e)) return `${where}: every entry must be an object`;
        const keys = Object.keys(e);
        if (keys.length !== 1 || keys[0] !== 'entryReference') return `${where}: an entry may hold "entryReference" only`;
        if (typeof e.entryReference !== 'string' || !ENTRY_REFERENCE.test(e.entryReference)) return `${where}: "entryReference" must be 64 lower-case hex characters`;
    }
    return undefined;
}

const PROXY_CODE = /^proxycode$/i;

/**
 * A connector create may bind a pre-existing proxy through `proxyCode` (a
 * plain string the uuid rules never see): any non-blank `proxyCode` is refused.
 */
export function connectorBodyShapeProblem(view: BodyView): string | undefined {
    if (view.kind !== 'json' || !isPlainObject(view.value)) return undefined;
    const stack: unknown[] = [view.value];
    while (stack.length) {
        const v = stack.pop();
        if (Array.isArray(v)) stack.push(...v);
        else if (isPlainObject(v)) {
            for (const [k, x] of Object.entries(v)) {
                if (PROXY_CODE.test(k) && !(x === null || x === undefined || (typeof x === 'string' && !x.trim()))) {
                    return `a connector create with a "${k.slice(0, 24)}" (a pre-existing proxy named by its code: core binds the new connector to it and routes through it)`;
                }
                stack.push(x);
            }
        }
    }
    return undefined;
}

export const CREATE_BODY_SHAPES: Readonly<Record<string, (view: BodyView) => string | undefined>> = {
    '/v1/certificates/import': importBodyShapeProblem,
    '/v1/connectors': connectorBodyShapeProblem,
    '/v2/connectors': connectorBodyShapeProblem,
};

export interface AssociationOptions {
    references?: boolean;
    /** Route-scoped top-level string fields whose canonical uuid may name a non-own object (ROUTE_FIELD_WAIVERS). */
    waive?: ReadonlySet<string>;
    waivePaths?: ReadonlyArray<readonly string[]>;
    scanAttributes?: boolean;
}

export { LIST_ELEMENT } from './routes';

/**
 * The uuids a JSON body names: canonical ones must be own, uuid-like non-canonical ones are refused; with `references`, top-level
 * REFERENCE_FIELDS are waived.
 */
export function findUuidsInBody(json: unknown, opts: AssociationOptions = {}): FoundUuids {
    const out: FoundUuids = { canonical: [], nonCanonical: [] };
    const waivedPath = (path: readonly string[]): boolean => !!opts.waivePaths?.some((w) => w.length === path.length && w.every((k, i) => k === path[i]));
    /** `field` / `fieldType`: the nearest key and its BODY_FIELD_TYPES / sibling-typed type; undefined = untyped. */
    const visit = (v: unknown, depth: number, reference: boolean, uuidKey: boolean, field?: string, fieldType?: string | null, path: readonly string[] = []): void => {
        if (typeof v === 'string') {
            const f = findUuidsInString(v, { uuidKey });
            merge(out, reference ? { canonical: [], nonCanonical: f.nonCanonical } : f);
            if (!reference && field !== undefined && fieldType !== undefined && isCanonicalUuid(v)) (out.typed ??= []).push([v.toLowerCase(), fieldType, field]);
            return;
        }
        if (Array.isArray(v)) return v.forEach((x) => visit(x, depth + 1, false, uuidKey, field, fieldType, [...path, LIST_ELEMENT]));
        if (!isPlainObject(v)) return;
        for (const [k, x] of Object.entries(v)) {
            merge(out, findUuidsInString(k, { uuidKey: false }));
            if (ATTRIBUTE_KEY.test(k) && !opts.scanAttributes) continue;
            const reference = typeof x === 'string' && ((depth === 0 && ((!!opts.references && Object.hasOwn(REFERENCE_FIELDS, k)) || !!opts.waive?.has(k))) || waivedPath([...path, k]));
            const type = Object.hasOwn(BODY_FIELD_TYPES, k) ? BODY_FIELD_TYPES[k]
                : Object.hasOwn(SIBLING_TYPED_FIELDS, k) ? (ledgerTypeOfResource(v[SIBLING_TYPED_FIELDS[k]]) ?? null) : undefined;
            visit(x, depth + 1, reference, isUuidField(k), k, type, [...path, k]);
        }
    };
    visit(json, 0, false, true);
    return out;
}

export function associationUuids(data: unknown, opts: AssociationOptions = {}): string[] {
    return findUuidsInBody(data, opts).canonical;
}

/** What the guard reads of a body: nothing, JSON (`raw` = the caller's own text), non-JSON text, or an unreadable body. */
export type BodyView =
    | { kind: 'none' }
    | { kind: 'json'; value: unknown; raw?: string }
    | { kind: 'text'; text: string }
    | { kind: 'plain'; text: string }
    | { kind: 'unreadable'; why: string };

const UTF8 = new TextDecoder('utf-8', { fatal: true });
const UTF8_KEEP_BOM = new TextDecoder('utf-8', { fatal: true, ignoreBOM: true });

/** The first duplicate key of a JSON object anywhere in `text` (already accepted by JSON.parse), or undefined. */
export function jsonDuplicateKey(text: string): string | undefined {
    const stack: Array<Set<string> | undefined> = [];
    let i = 0;
    while (i < text.length) {
        const c = text[i];
        if (c === '"') {
            let j = i + 1;
            while (j < text.length && text[j] !== '"') j += text[j] === '\\' ? 2 : 1;
            const literal = text.slice(i, j + 1);
            let k = j + 1;
            while (k < text.length && /\s/.test(text[k])) k++;
            const keys = stack[stack.length - 1];
            if (text[k] === ':' && keys) {
                const key = JSON.parse(literal) as string;
                if (keys.has(key)) return key;
                keys.add(key);
            }
            i = j + 1;
            continue;
        }
        if (c === '{') stack.push(new Set());
        else if (c === '[') stack.push(undefined);
        else if (c === '}' || c === ']') stack.pop();
        i++;
    }
    return undefined;
}

function jsonTextView(text: string): BodyView {
    const dup = jsonDuplicateKey(text);
    if (dup !== undefined) return { kind: 'unreadable', why: `a JSON body with a duplicate key (${JSON.stringify(dup.slice(0, 24))}): readers disagree on which value wins` };
    return { kind: 'json', value: JSON.parse(text), raw: text };
}

const parses = (text: string): boolean => {
    try {
        JSON.parse(text);
        return true;
    } catch {
        return false;
    }
};

export interface BodySnapshot {
    view: BodyView;
    /** undefined = no body; a string goes as `application/json` (`text/plain`: as written); a Buffer byte for byte. */
    send?: string | Buffer;
}

/**
 * The body as the guard sends and the server reads it; each input is read once. A string is judged as JSON when
 * JSON.parse accepts it, else as a JSON string value; a Buffer is sent byte for byte (UTF-8 only; NUL or invalid UTF-8
 * is unreadable); anything else is serialised once with `JSON.stringify`. bigint, functions and symbols are refused.
 */
export function readJsonBody(data: unknown): BodySnapshot | { problem: string } {
    if (data === undefined) return { view: { kind: 'none' } };
    if (typeof data === 'string' || data instanceof String) {
        const text = String(data);
        if (parses(text)) return { view: jsonTextView(text), send: text };
        const quoted = JSON.stringify(text);
        return { view: { kind: 'json', value: text }, send: quoted };
    }
    if (Buffer.isBuffer(data)) {
        const copy = Buffer.from(data);
        let text: string;
        try {
            text = UTF8.decode(copy);
        } catch {
            return { view: { kind: 'unreadable', why: 'a Buffer body that is not UTF-8' }, send: copy };
        }
        if (text.includes('\u0000')) return { view: { kind: 'unreadable', why: 'a body with NUL characters (UTF-16 / UTF-32, which the server detects)' }, send: copy };
        const t = text.replace(/^﻿/, '');
        if (!t.trim()) return { view: { kind: 'none' }, send: copy };
        return { view: parses(t) ? jsonTextView(t) : { kind: 'text', text: t }, send: copy };
    }
    if (typeof data === 'bigint' || typeof data === 'function' || typeof data === 'symbol') return { problem: `a ${typeof data} body (Playwright cannot send it)` };
    let text: string | undefined;
    try {
        text = JSON.stringify(data);
    } catch {
        return { problem: 'a body that JSON.stringify cannot serialise' };
    }
    if (text === undefined) return { view: { kind: 'none' } };
    return { view: { kind: 'json', value: JSON.parse(text) }, send: text };
}

export function bodyView(data: unknown): BodyView {
    const s = readJsonBody(data);
    return 'problem' in s ? { kind: 'unreadable', why: s.problem } : s.view;
}

/**
 * A `text/plain` body (415 negatives), sent as written: Playwright re-quotes a string only under exactly `application/json`. NUL characters
 * make it unreadable.
 */
export function readTextBody(data: unknown): BodySnapshot | { problem: string } {
    if (Buffer.isBuffer(data)) {
        const copy = Buffer.from(data);
        let text: string;
        try {
            text = UTF8_KEEP_BOM.decode(copy);
        } catch {
            return { view: { kind: 'unreadable', why: 'a text/plain Buffer body that is not UTF-8' }, send: copy };
        }
        if (text.includes('\u0000')) return { view: { kind: 'unreadable', why: 'a text/plain body with NUL characters' }, send: copy };
        return { view: { kind: 'plain', text }, send: copy };
    }
    if (typeof data !== 'string' && !(data instanceof String)) {
        return { problem: 'text/plain with a body that is not a string or Buffer (Playwright would serialise it as JSON under a text type)' };
    }
    const written = String(data);
    const text = Buffer.from(written, 'utf8').toString('utf8');
    if (text.includes('\u0000')) return { view: { kind: 'unreadable', why: 'a text/plain body with NUL characters' }, send: written };
    return { view: { kind: 'plain', text }, send: written };
}

export type Params = Record<string, string | number | boolean> | URLSearchParams | string | undefined;

function queryEntries(search: URLSearchParams, params: Params): Array<[string, string]> {
    const out: Array<[string, string]> = [...search.entries()];
    if (typeof params === 'string') out.push(...new URLSearchParams(params).entries());
    else if (params instanceof URLSearchParams) out.push(...params.entries());
    else if (params && typeof params === 'object') {
        out.push(...Object.entries(params).filter(([, v]) => v !== undefined).map(([k, v]) => [k, String(v)] as [string, string]));
    }
    return out;
}

const searchOf = (url: string): URLSearchParams => {
    try {
        return new URL(url, NO_BASE).searchParams;
    } catch {
        return new URLSearchParams();
    }
};

/** Every uuid the query string and `params` name: canonical ones (to be own) and non-canonical uuid-like ones (refused). */
export function findUuidsInQuery(url: string | URL, params?: Params): FoundUuids {
    const out: FoundUuids = { canonical: [], nonCanonical: [] };
    const search = typeof url === 'string' ? searchOf(url) : url.searchParams;
    for (const [k, v] of queryEntries(search, params)) {
        merge(out, findUuidsInString(k, { free: true, uuidKey: false }));
        merge(out, findUuidsInString(v, { free: true, uuidKey: isUuidField(k) }));
    }
    return out;
}

export function queryUuids(url: string, params?: Params): string[] {
    return findUuidsInQuery(url, params).canonical;
}
