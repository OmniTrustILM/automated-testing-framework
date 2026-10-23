import { isCanonicalUuid, isUuidField, merge, findUuidsInString, FoundUuids } from './uuids';
import { NO_BASE } from './urls';
import { REFERENCE_FIELDS } from './allowLists';
import { ATTRIBUTE_KEY, isPlainObject } from './targets';
import { BODY_FIELD_TYPES, ledgerTypeOfResource, SIBLING_TYPED_FIELDS } from './routes';

const KEY_DESTINATION = /^keydestination$/i;
const ENTRY_REFERENCE = /^[0-9a-f]{64}$/;
const MAX_IMPORT_ENTRIES = 250;

/** The first key anywhere in a JSON value that matches `re`, or undefined (iterative). */
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
 * The body of `POST /v1/certificates/import` the guard lets through — certificate-only entries. The guard cannot
 * read the file, so the body is constrained instead: a JSON object (a non-JSON Buffer is refused on this route although
 * creates normally accept one); top-level keys ⊂ {file, entries, passphrase, customAttributes}; `file` and `passphrase`
 * strings; `entries` a non-empty array (at most 250) of objects whose ONLY key is `entryReference`, a 64-character
 * lower-case hex fingerprint; any `keyDestination` key (even null, any case, anywhere — also inside `customAttributes`)
 * refuses. Core: a certificate entry with a `keyDestination` is refused (`TAKES_NO_DESTINATION`,
 * CertificateImportServiceImpl), a key entry without one is refused (`NEEDS_DESTINATION`), a CSR entry is
 * refused; so a body of this shape can reach the certificate registration only
 * (the plain upload), never the key import (KeyImportGates). Only
 * `certificateOutcome: "created"` results belong in the ledger (the spec's duty).
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
 * A connector create may name a pre-existing PROXY by its code — `proxyCode` is a plain
 * string, not a uuid, so the uuid rules never see it, yet core binds the new connector to that proxy and routes the
 * validate call through it (`service/v2/impl/ConnectorServiceImpl` → `resolveProxy`,
 * `proxyRepository.findByCode`). The v1 create delegates to the v2 one (`service/impl/ConnectorServiceImpl`).
 * So any `proxyCode` key (any case, any depth, any non-blank value) refuses on both creates; `proxyUuid` stays probes-only
 * (BODY_FIELD_TYPES). A blank / null / absent `proxyCode` names nothing (`:964` `isBlank`).
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

/** Per-route body shape rules of allow-listed CREATES (consulted by `judge()` after the body view checks). */
export const CREATE_BODY_SHAPES: Readonly<Record<string, (view: BodyView) => string | undefined>> = {
    '/v1/certificates/import': importBodyShapeProblem,
    '/v1/connectors': connectorBodyShapeProblem,
    '/v2/connectors': connectorBodyShapeProblem,
};

export interface AssociationOptions {
    /** An own create / update: canonical STRING values of TOP-LEVEL REFERENCE_FIELDS may name pre-existing objects. */
    references?: boolean;
    /**
     * Route-scoped waivers (guard/routes.ts ROUTE_FIELD_WAIVERS): TOP-LEVEL string fields whose canonical
     * uuid value may name a non-own object on this request (treated like a REFERENCE_FIELDS field: not claimed, not
     * typed; a non-canonical form is still refused; a list or nested key under the name is scanned as usual).
     */
    waive?: ReadonlySet<string>;
}

/**
 * The uuids a JSON body names: every string outside attribute subtrees, keys included —
 * canonical uuids (whole or inside a longer string) must be own, uuid-like non-canonical values are refused (base64 forms
 * only under a uuid-shaped key; keys themselves never take a base64 form: Jackson's map-key reader for UUID is
 * `UUID.fromString`). With `references`, canonical string values of top-level REFERENCE_FIELDS are waived.
 */
export function findUuidsInBody(json: unknown, opts: AssociationOptions = {}): FoundUuids {
    const out: FoundUuids = { canonical: [], nonCanonical: [] };
    /**
     * `field`: the nearest key (array parents included) and `fieldType` its type: a BODY_FIELD_TYPES field
     * or a SIBLING_TYPED_FIELDS field typed by its sibling `resource` code (unknown code: null = probes only);
     * undefined = not typed. An exact canonical uuid value under a typed field becomes a typed claim.
     */
    const visit = (v: unknown, depth: number, reference: boolean, uuidKey: boolean, field?: string, fieldType?: string | null): void => {
        if (typeof v === 'string') {
            const f = findUuidsInString(v, { uuidKey });
            merge(out, reference ? { canonical: [], nonCanonical: f.nonCanonical } : f);
            if (!reference && field !== undefined && fieldType !== undefined && isCanonicalUuid(v)) (out.typed ??= []).push([v.toLowerCase(), fieldType, field]);
            return;
        }
        if (Array.isArray(v)) return v.forEach((x) => visit(x, depth + 1, false, uuidKey, field, fieldType));
        if (!isPlainObject(v)) return;
        for (const [k, x] of Object.entries(v)) {
            merge(out, findUuidsInString(k, { uuidKey: false }));
            if (ATTRIBUTE_KEY.test(k)) continue;
            const reference = depth === 0 && typeof x === 'string' && ((!!opts.references && Object.hasOwn(REFERENCE_FIELDS, k)) || !!opts.waive?.has(k));
            const type = Object.hasOwn(BODY_FIELD_TYPES, k) ? BODY_FIELD_TYPES[k]
                : Object.hasOwn(SIBLING_TYPED_FIELDS, k) ? (ledgerTypeOfResource(v[SIBLING_TYPED_FIELDS[k]]) ?? null) : undefined;
            visit(x, depth + 1, reference, isUuidField(k), k, type);
        }
    };
    // The root: a top-level string, or a string of a top-level array (`List<UUID>` bodies), counts as uuid-keyed.
    visit(json, 0, false, true);
    return out;
}

/** The canonical uuids a body names besides its target (`findUuidsInBody(…).canonical`). */
export function associationUuids(data: unknown, opts: AssociationOptions = {}): string[] {
    return findUuidsInBody(data, opts).canonical;
}

/**
 * What the guard reads of a request body: nothing, a JSON value (`raw`: the caller's own text, when the caller sent
 * text), text that is not JSON (a Buffer), or a body it cannot read.
 */
export type BodyView =
    | { kind: 'none' }
    | { kind: 'json'; value: unknown; raw?: string }
    | { kind: 'text'; text: string }
    /** A `text/plain` body (for the 415 negatives): raw text, never read as JSON. */
    | { kind: 'plain'; text: string }
    | { kind: 'unreadable'; why: string };

const UTF8 = new TextDecoder('utf-8', { fatal: true });
/** For `text/plain` bodies: a leading BOM is kept (the text is judged exactly as the bytes are). */
const UTF8_KEEP_BOM = new TextDecoder('utf-8', { fatal: true, ignoreBOM: true });

/**
 * The first duplicate key of a JSON object anywhere in `text` (which JSON.parse accepted), or undefined. Iterative: a
 * stack of key sets, one per open object; a key is the decoded string before a `:`.
 */
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

/** A JSON view of caller-supplied text that JSON.parse accepts (duplicate keys: unreadable). */
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

/** What the guard sends of a body: the view it judges and the exact value it hands Playwright. */
export interface BodySnapshot {
    view: BodyView;
    /**
     * undefined: no body is sent. A string goes with `content-type: application/json` (`text/plain`: as written); a Buffer byte for byte.
     */
    send?: string | Buffer;
}

/**
 * The body as the guard will send it and the server will read it; every input is read once:
 * - undefined: no body;
 * - a string (or String object): with `content-type: application/json`, Playwright sends it as written when
 *   `JSON.parse` accepts it (judged as that JSON; a duplicate key = unreadable), else re-quoted as a JSON string — so the
 *   guard sends `JSON.stringify(text)` itself and judges the JSON string value (a BOM, trailing junk);
 * - a Buffer: a copy, sent byte for byte; UTF-8 only (NUL bytes or invalid UTF-8 = unreadable: the server detects
 *   UTF-16 / UTF-32), a leading BOM skipped like Jackson does, whitespace only = no body; JSON (duplicate key =
 *   unreadable) or text (an allow-listed create may send it: malformed-JSON negatives);
 * - anything else Playwright serialises with `JSON.stringify` (`toJSON`, dropped functions and non-enumerables, a typed
 *   array's index object, `null` as `null`): serialised ONCE here, sent as that text and judged as its parse.
 * bigint, functions and symbols (Playwright throws) and unserialisable values are refused.
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

/** The body as the guard judges it (`readJsonBody(data).view`; an unsendable body is `unreadable`). */
export function bodyView(data: unknown): BodyView {
    const s = readJsonBody(data);
    return 'problem' in s ? { kind: 'unreadable', why: s.problem } : s.view;
}

/**
 * A `text/plain` body (for the 415 negatives), read once and sent AS WRITTEN: Playwright
 * re-quotes a string only under exactly `application/json` (playwright-core client/fetch.js `isJsonContentType`); under
 * any other type it sends `Buffer.from(data, 'utf8')`, and a Buffer byte for byte. The view is the raw text of the bytes
 * that go out (a string's lone surrogates become U+FFFD there; a Buffer must be UTF-8; a BOM is kept); NUL characters
 * make it unreadable (a reader could take the bytes for UTF-16).
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

/** The keys and values of the effective query string and the `params` option (decoded, as the server reads them). */
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

/**
 * Every uuid the query string and `params` name: canonical ones (to be own) and non-canonical uuid-like ones (refused;
 * base64 forms only as the value of a uuid-shaped key).
 */
export function findUuidsInQuery(url: string | URL, params?: Params): FoundUuids {
    const out: FoundUuids = { canonical: [], nonCanonical: [] };
    const search = typeof url === 'string' ? searchOf(url) : url.searchParams;
    for (const [k, v] of queryEntries(search, params)) {
        merge(out, findUuidsInString(k, { free: true, uuidKey: false }));
        merge(out, findUuidsInString(v, { free: true, uuidKey: isUuidField(k) }));
    }
    return out;
}

/** Every canonical uuid the query string and `params` name (any key or value, comma lists included). */
export function queryUuids(url: string, params?: Params): string[] {
    return findUuidsInQuery(url, params).canonical;
}
