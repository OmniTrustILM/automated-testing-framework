/**
 * readRequest — turns what a caller handed to the guard into one snapshot of plain data (first half of every request).
 *
 * Each input is read exactly once and anything the guard does not forward is refused, so the judge and Playwright cannot be
 * shown different things. A refused request is never sent. Rules for every method:
 *   a. only known options; `identityOverride` is the guard's own switch and is never forwarded
 *   b. only known headers; identity headers only with `identityOverride: true` (401 / 403 negatives)
 *   c. the URL must resolve to http(s) on BASE_URL's origin, without user info
 *   d. a `_method` query parameter is refused
 */
import { apiPathOfPathname, hasMethodParam, resolveSentUrl, SentUrl } from './urls';
import { postRouteKind } from './allowLists';
import { BodySnapshot, readJsonBody, readTextBody } from './bodies';
import {
    BODYLESS, DEFAULT_MAX_REDIRECTS, FORWARDED_OPTIONS, headerProblem, IDENTITY_HEADERS, JSON_CONTENT, Method, METHOD_IN_TEXT, METHODS, OPTION_KEYS,
    PROBE_METHODS, PROTOCOL_CONTENT, readPostType, textPlainType,
} from './headers';
import { Refuse, refuserFor } from './refuse';

/** The request the guard judged and sends: every input read once, plain data only. */
export interface Snapshot {
    method: Method;
    /** The URL as written (a string), first argument only. */
    url: string;
    sent: SentUrl;
    /** The query Playwright will send: the URL's, replaced by string / URLSearchParams params, appended by object params. */
    query: URLSearchParams;
    /** Forwarded params: a string (encodedParams) or a plain string map. */
    params?: string | Record<string, string>;
    /** Forwarded headers, lower-cased; content-type set to application/json for a body unless a protocol type was given. */
    headers?: Record<string, string>;
    body: BodySnapshot;
    /** timeout / failOnStatusCode / ignoreHTTPSErrors, as given. */
    pass: Record<string, number | boolean>;
    /** GET: how many same-origin redirects the guard follows; every other method: 0. */
    maxRedirects: number;
    /**
     * The caller asked to send an identity header of its own (never forwarded; judged: the refused-method and no-handler probes refuse it).
     */
    identityOverride: boolean;
}

/** How the request reached the guard: a method wrapper (`get`, `post`, …) or `fetch`. */
export type Entry = { kind: 'wrapper'; method: string } | { kind: 'fetch' };

/** The label of a refusal before the guard knows the method. */
const WHERE_OPTIONS = 'guardedApi (outside /api)';

/** A plain object (no class instance, no Map / URLSearchParams / Headers): `{}` or `Object.create(null)`. */
const isPlainRecord = (v: unknown): v is Record<string, unknown> => {
    if (!v || typeof v !== 'object' || Array.isArray(v)) return false;
    const p = Object.getPrototypeOf(v);
    return p === Object.prototype || p === null;
};

/** Reads one request into a snapshot; throws OwnObjectViolation (kind `request`) for anything the guard does not forward. */
export function readRequest(env: NodeJS.ProcessEnv, entry: Entry, urlIn: unknown, optionsIn: unknown): Snapshot {
    const o = readOptions(entry, optionsIn, refuserFor(WHERE_OPTIONS));
    const { method, url, sent, where } = readMethodAndUrl(entry, urlIn, o, env);
    const refuse = refuserFor(where);
    const apiPath = apiPathOfPathname(sent.effective.pathname);
    const routeKind = method === 'POST' && !!apiPath ? postRouteKind(apiPath) : undefined;
    const protocol = routeKind === 'protocol';
    // A read POST (POST_READ) may declare the three read-POST content types.
    const readPost = routeKind === 'read';
    const identityOverride = readIdentityOverride(o, method, refuse);
    const params = readParams(o.params, refuse);
    const query = readQuery(sent, params, refuse);
    const headers = readHeaders(o.headers, { protocol, identityOverride, readPost }, refuse);
    const read = readBody(o.data, headers, { method, protocol, readPost }, refuse);
    const pass = readForwarded(o, refuse);
    return { method, url, sent, query, params, headers: read.headers, body: read.body, pass, maxRedirects: readRedirects(method), identityOverride };
}

/** The options: an allow-list of keys, each read once. */
function readOptions(entry: Entry, optionsIn: unknown, refuse: Refuse): Record<string, unknown> {
    const o: Record<string, unknown> = {};
    if (optionsIn === undefined || optionsIn === null) return o;
    if (typeof optionsIn !== 'object' || Array.isArray(optionsIn)) refuse('request options that are not an object');
    for (const key of Reflect.ownKeys(optionsIn as object)) {
        if (typeof key !== 'string') refuse('a symbol option key');
        const k = key as string;
        if (k === 'form' || k === 'multipart') refuse('a form / multipart body (the guard reads JSON bodies only)');
        const allowed = OPTION_KEYS.has(k) || (entry.kind === 'fetch' && k === 'method');
        if (!allowed) {
            refuse(`the option "${k.slice(0, 32)}" (the guard forwards ${FORWARDED_OPTIONS.join(', ')}${entry.kind === 'fetch' ? ' and method' : ''} only; ` +
                'the URL goes as the first argument)');
        }
        o[k] = (optionsIn as Record<string, unknown>)[k];
    }
    return o;
}

/**
 * The URL string, the method and (c) the URL as sent. `where` is the refusal label of every later step: it names the
 * method and the API path once both are known.
 */
function readMethodAndUrl(entry: Entry, urlIn: unknown, o: Record<string, unknown>, env: NodeJS.ProcessEnv): { method: Method; url: string; sent: SentUrl; where: string } {
    const refuseEarly = refuserFor(WHERE_OPTIONS);
    if (typeof urlIn !== 'string') refuseEarly('a URL that is not a string (a String / URL object is refused; pass the string)');
    const url = urlIn as string;
    let name: string;
    if (entry.kind === 'wrapper') name = entry.method;
    else {
        const m = o.method !== undefined ? o.method : 'GET';
        if (typeof m !== 'string') refuseEarly('a method that is not a string');
        name = (m as string).toUpperCase();
    }
    if (!METHODS.has(name)) refuseEarly(`the method ${JSON.stringify(name.slice(0, 16))} (GET, POST, PUT, PATCH, DELETE and TRACE only)`);
    const method = name as Method;
    const resolved = resolveSentUrl(url, { env });
    if ('problem' in resolved) refuserFor(`guardedApi ${method} (outside /api)`)(`${resolved.problem}: requests go to BASE_URL only, as written`);
    const sent = (resolved as { sent: SentUrl }).sent;
    const apiPath = apiPathOfPathname(sent.effective.pathname);
    return { method, url, sent, where: `guardedApi ${method} ${apiPath ?? '(outside /api)'}` };
}

/** `identityOverride`: a boolean; a refused-method probe runs as the run's own identity, never with an identity header. */
function readIdentityOverride(o: Record<string, unknown>, method: Method, refuse: Refuse): boolean {
    if (o.identityOverride !== undefined && typeof o.identityOverride !== 'boolean') refuse('identityOverride must be a boolean');
    const identityOverride = o.identityOverride === true;
    if (PROBE_METHODS.has(method) && identityOverride) refuse(`identityOverride on a ${method} (a refused-method probe carries no identity header)`);
    return identityOverride;
}

/** `params`: a string, URLSearchParams (read once with toString) or a plain map of primitives (each read once). */
function readParams(p: unknown, refuse: Refuse): string | Record<string, string> | undefined {
    if (p === undefined) return undefined;
    if (typeof p === 'string') return p;
    if (p instanceof URLSearchParams) return p.toString();
    if (!isPlainRecord(p)) return refuse('params that are not a string, URLSearchParams or a plain object');
    const map: Record<string, string> = {};
    for (const key of Reflect.ownKeys(p)) {
        if (typeof key !== 'string') refuse('a symbol params key');
        const v = (p as Record<string, unknown>)[key as string];
        if (v === undefined) continue;
        if (typeof v !== 'string' && typeof v !== 'number' && typeof v !== 'boolean') refuse('a params value that is not a string, number or boolean');
        map[key as string] = String(v);
    }
    return map;
}

/**
 * The query Playwright sends: encodedParams (a non-empty string) replaces the URL's query, object params append. (d) A
 * `_method` override is refused in the URL and in the params.
 */
function readQuery(sent: SentUrl, params: string | Record<string, string> | undefined, refuse: Refuse): URLSearchParams {
    const final = new URL(sent.effective.toString());
    if (typeof params === 'string') {
        if (params) final.search = params;
    } else if (params) for (const [k, v] of Object.entries(params)) final.searchParams.append(k, v);
    if (hasMethodParam(final.searchParams) || hasMethodParam(sent.effective.searchParams)) refuse('a _method query parameter (a method override)');
    return final.searchParams;
}

/** Headers: each read once, lower-cased, allow-listed (rule b). */
function readHeaders(
    headersIn: unknown,
    ctx: { protocol: boolean; identityOverride: boolean; readPost: boolean },
    refuse: Refuse,
): Record<string, string> | undefined {
    if (headersIn === undefined || headersIn === null) return undefined;
    if (!isPlainRecord(headersIn)) refuse('headers that are not a plain object');
    const headers: Record<string, string> = {};
    for (const key of Reflect.ownKeys(headersIn as object)) {
        if (typeof key !== 'string') refuse('a symbol header name');
        const v = (headersIn as Record<string, unknown>)[key as string];
        if (v === undefined) continue;
        if (typeof v !== 'string') refuse('a header value that is not a string');
        const name = (key as string).toLowerCase();
        if (Object.hasOwn(headers, name)) refuse('the same header twice (in another case)');
        const why = headerProblem(name, v as string, ctx);
        if (why) refuse(why);
        headers[name] = name === 'content-type' && (v as string).trim().toLowerCase() === JSON_CONTENT
            ? JSON_CONTENT
            : (name === 'content-type' ? (textPlainType(v as string) ?? (ctx.readPost ? readPostType(v as string) : undefined)) : undefined) ?? (v as string);
    }
    return headers;
}

const hasIdentityHeader = (headers: Record<string, string>): boolean => Object.keys(headers).some((h) => IDENTITY_HEADERS.has(h));

/**
 * The body as it will be sent: raw text for a 415 negative (`text/plain`, a read-POST type), a protocol POST's string as
 * written, and JSON for everything else.
 */
function serialiseBody(data: unknown, how: { rawText: boolean; protocolType: boolean }): BodySnapshot | { problem: string } {
    if (how.rawText) return readTextBody(data);
    if (how.protocolType && (typeof data === 'string' || data instanceof String)) return { view: { kind: 'text', text: String(data) }, send: String(data) };
    return readJsonBody(data);
}

/**
 * The body, serialised once, and the content type that goes with it. A protocol POST that declares its protocol media
 * type sends a string as written; a 415 negative sends `text/plain` or a read-POST type as written, judged as raw text;
 * every other body is JSON.
 */
function readBody(
    data: unknown,
    headersIn: Record<string, string> | undefined,
    ctx: { method: Method; protocol: boolean; readPost: boolean },
    refuse: Refuse,
): { body: BodySnapshot; headers: Record<string, string> | undefined } {
    let headers = headersIn;
    const declared = headers?.['content-type'];
    const protocolType = ctx.protocol && !!declared && PROTOCOL_CONTENT.has(declared.toLowerCase());
    // A 415 negative: text/plain only on a non-GET request with a string / Buffer
    // body and without an identity header (even with identityOverride); the body goes as written, judged as raw text.
    const textPlain = declared !== undefined && textPlainType(declared) !== undefined;
    if (textPlain) {
        if (BODYLESS.has(ctx.method)) refuse('text/plain on a GET / TRACE (a 415 negative is a request with a text body)');
        if (hasIdentityHeader(headers!)) {
            refuse('an identity header on a text/plain request (a 415 negative runs as the run\'s own identity)');
        }
    }
    // A read-POST content type (headerProblem admitted it on a POST_READ route only): the body goes as
    // written like text/plain (Playwright sends a string raw under any non-JSON type), UTF-8, no NUL, no identity
    // header (even with identityOverride), and its text may not contain `_method` (any case).
    const readPostContent = declared !== undefined && ctx.readPost && readPostType(declared) !== undefined;
    if (readPostContent && hasIdentityHeader(headers!)) {
        refuse(`an identity header on a ${declared} request (a 415 negative runs as the run's own identity)`);
    }
    const body = serialiseBody(data, { rawText: textPlain || readPostContent, protocolType });
    if ('problem' in body) return refuse(readPostContent ? body.problem.replace(/^text\/plain/, String(declared)) : body.problem);
    if (readPostContent) {
        const v = body.view;
        if (v.kind === 'unreadable') refuse(`${v.why.replace(/^a text\/plain/, `a ${declared}`)}: the guard cannot read what the server would read`);
        if (v.kind === 'plain' && METHOD_IN_TEXT.test(v.text)) refuse(`a body containing "_method" under ${declared} (a form reader could take it for a method override)`);
    }
    if (body.send !== undefined) {
        if (BODYLESS.has(ctx.method)) refuse('a body on a GET / TRACE');
        headers = { ...(headers ?? {}) };
        if (!protocolType && !textPlain && !readPostContent) headers['content-type'] = JSON_CONTENT;
    }
    return { body: body as BodySnapshot, headers };
}

/** The other forwarded options, type-checked. */
function readForwarded(o: Record<string, unknown>, refuse: Refuse): Record<string, number | boolean> {
    const pass: Record<string, number | boolean> = {};
    const timeout = o.timeout;
    if (timeout !== undefined) {
        if (typeof timeout !== 'number' || !Number.isFinite(timeout) || timeout < 0) refuse('timeout must be a non-negative number');
        pass.timeout = timeout as number;
    }
    for (const key of ['failOnStatusCode', 'ignoreHTTPSErrors']) {
        const v = o[key];
        if (v === undefined) continue;
        if (typeof v !== 'boolean') refuse(`${key} must be a boolean`);
        pass[key] = v as boolean;
    }
    return pass;
}

/** A GET follows same-origin redirects itself (through the URL rules); every other method never follows one. */
const readRedirects = (method: Method): number => (method === 'GET' ? DEFAULT_MAX_REDIRECTS : 0);
