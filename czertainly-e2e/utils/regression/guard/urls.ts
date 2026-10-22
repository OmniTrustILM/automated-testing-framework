import { IS_UUID, isCanonicalUuid, isUuidLike, UUID } from './uuids';
import { API_WORDS, decodedApiPath, sideEffectGet } from './routes';
import { OwnObjectViolation } from '../ledger/ownership';


/** The base a relative URL is resolved against when BASE_URL is unset (unit tests; a real context would not send it). */
export const NO_BASE = 'http://base-url-unset.invalid/';
/** Printable ASCII only: the control characters U+0000–U+001F, space, DEL, U+0080–U+009F and every non-ASCII character are stripped or re-encoded by the parser. */
const NOT_PRINTABLE = /[^\x21-\x7e]/;
const NOT_PRINTABLE_REASON = 'a control character, space, DEL or non-ASCII character in the URL (the URL parser strips, trims or ' +
    're-encodes it: the server would see another URL than the guard checked)';
/** The forms a URL may be WRITTEN in: path-absolute `/…` (not `//`), or absolute `<scheme>://…`. */
const WRITTEN_FORM = /^(\/(?!\/)|[A-Za-z][A-Za-z0-9+.-]*:\/\/)/;
const WRITTEN_FORM_REASON = 'a URL that is neither path-absolute (/…) nor absolute (<scheme>://…): scheme-relative (//host), ' +
    '`scheme:path`, relative and query / fragment-only forms resolve to places the guard does not want to guess';
/** A path segment the guard can reason about: unreserved characters only, or a canonical uuid (which is a subset). */
const SEGMENT = /^[A-Za-z0-9._~-]+$/;
/** A segment of the POST allow-list patterns (no `.` / `..`). */
export const SEG = '(?!\\.\\.?(?:/|$))[A-Za-z0-9._~-]+';

/** The path part of a URL as written: after the scheme and authority, before the query and fragment. */
export function rawPathOf(url: string): string {
    const m = /^([A-Za-z][A-Za-z0-9+.-]*:)?(\/\/[^/?#]*)?([^?#]*)/.exec(url);
    return m ? m[3] : url;
}

const isAbsolute = (url: string): boolean => /^[A-Za-z][A-Za-z0-9+.-]*:/.test(url) || url.startsWith('//');

/** A URL resolved like Playwright resolves it, with the path as written. */
export interface SentUrl {
    effective: URL;
    rawPath: string;
}

export interface SentUrlOptions {
    env?: NodeJS.ProcessEnv;
    /** Skip the origin rule (a request that carries no credentials; the ACME client). Default false. */
    anyOrigin?: boolean;
}

/**
 * Rule (c) of the module header: the URL as written is `/…` or `<scheme>://…`, printable ASCII, and resolves with
 * `new URL(url, BASE_URL)` to http(s) without user info, on BASE_URL's origin. Returns the problem, or the resolved URL.
 * Messages never echo a host.
 */
export function resolveSentUrl(url: unknown, opts: SentUrlOptions = {}): { problem: string } | { sent: SentUrl } {
    const env = opts.env ?? process.env;
    if (typeof url !== 'string') return { problem: 'a URL that is not a string' };
    if (NOT_PRINTABLE.test(url)) return { problem: NOT_PRINTABLE_REASON };
    if (!WRITTEN_FORM.test(url)) return { problem: WRITTEN_FORM_REASON };
    let base = NO_BASE;
    if (env.BASE_URL) {
        try {
            base = new URL(env.BASE_URL).toString();
        } catch {
            return { problem: 'BASE_URL is not a valid URL' };
        }
    } else if (isAbsolute(url)) {
        return { problem: 'an absolute URL while BASE_URL is unset' };
    }
    let effective: URL;
    try {
        effective = new URL(url, base);
    } catch {
        return { problem: 'a URL that does not parse' };
    }
    if (effective.protocol !== 'http:' && effective.protocol !== 'https:') return { problem: 'a URL that is not http(s)' };
    if (effective.username || effective.password) return { problem: 'user info in the URL' };
    if (!opts.anyOrigin && effective.origin !== new URL(base).origin) return { problem: 'an absolute URL whose origin is not BASE_URL\'s' };
    return { sent: { effective, rawPath: rawPathOf(url) } };
}

/**
 * The characters and segments of one path (as written, or as sent) that let a server or proxy reach another endpoint
 * than the one the guard matched: a backslash, a `;` anywhere (Tomcat drops `;…` path parameters: `..;`, `/;x/`,
 * `approvals;x`), an encoded slash, backslash or dot (`%2f`, `%5c`, `%2e`, any case), an empty segment (`//`, which a
 * proxy with `merge_slashes` collapses) and a `.` / `..` segment.
 */
export function pathCharProblem(path: string): string | undefined {
    if (path.includes('\\')) return 'a backslash in the path';
    if (path.includes(';')) return 'a semicolon (;) in the path (a path parameter the server drops: `..;`, `;x`)';
    if (/%(2f|5c|2e)/i.test(path)) return 'an encoded slash, backslash or dot (%2f, %5c, %2e) in the path';
    if (path.includes('//')) return 'an empty segment (//) in the path';
    if (path.split('/').some((s) => s === '.' || s === '..')) return 'a dot segment in the path';
    return undefined;
}

/**
 * The structural path rule SHARED by every request the guard lets through: GET, each
 * followed redirect hop, `assertSameOrigin` and — as the first part of `structuralPathProblem` — every mutation and raw
 * POST. Refused: `pathCharProblem` on the path as written and as sent, a path the URL parser would change, and a path
 * whose lower-case form starts with `/api` but that does not start with exactly `/api/` (`/API/v1/…`, `/Api/…`, `/apix`:
 * the guard and Spring match the API case-sensitively; a proxy may not). Other percent-escapes and the query string stay
 * allowed on a GET (the side-effect rule matches the decoded path). `sent` must come from `resolveSentUrl`.
 */
export function readPathProblem({ effective, rawPath }: SentUrl): string | undefined {
    const raw = rawPath === '' ? '/' : rawPath;
    const chars = pathCharProblem(raw) ?? pathCharProblem(effective.pathname);
    if (chars) return chars;
    if (raw !== effective.pathname) return 'a path the URL parser would change (relative, dot segments, re-encoding)';
    if (effective.pathname.toLowerCase().startsWith('/api') && !effective.pathname.startsWith('/api/')) {
        return 'a spelling of /api other than exactly "/api/" (the API is matched case-sensitively)';
    }
    return undefined;
}

/**
 * Rule 1 of the module header (structure of the path): why the server would see another path than the guard checks,
 * or undefined — the shared `readPathProblem`, then the mutation-only rules: no `%` at all, no empty segment or
 * trailing slash, segments `[A-Za-z0-9._~-]` only. `sent` must come from `resolveSentUrl`.
 */
export function structuralPathProblem(sent: SentUrl): string | undefined {
    const shared = readPathProblem(sent);
    if (shared) return shared;
    const { effective, rawPath } = sent;
    if (rawPath.includes('%')) return 'an encoded character (%) in the path';
    const segments = effective.pathname.split('/').slice(1);
    if (segments.some((s) => s === '')) return 'an empty segment or a trailing slash in the path';
    if (segments.some((s) => !SEGMENT.test(s) || s === '.' || s === '..')) return 'a path segment outside [A-Za-z0-9._~-]';
    return undefined;
}

/**
 * Rule 3 for paths: a segment that is uuid-like but not canonical (padded, lenient, urn; base64 is no path form: Spring
 * converts a path variable with `UUID.fromString`), or holds a canonical uuid inside a longer segment.
 */
export function uuidSegmentProblem(pathname: string): string | undefined {
    const bad = pathname.split('/').filter((s) => s && !isCanonicalUuid(s) && (isUuidLike(s, { base64: false }) || new RegExp(UUID).test(s)));
    return bad.length ? 'a non-canonical uuid segment in the path (the server would parse it as a uuid the guard does not recognise)' : undefined;
}

/**
 * Rule 6a: a mutation path segment (after `/v1|v2`) that is neither a canonical uuid nor an API word (guard/routes.ts
 * API_WORDS) names an object by its name, which the guard cannot prove own.
 */
export function nameSegmentProblem(apiPath: string): string | undefined {
    const named = apiPath.split('/').slice(2).filter((s) => s && !IS_UUID.test(s) && !API_WORDS.has(s));
    return named.length
        ? 'a path segment that is neither a uuid nor a word of the ILM API (an object named by its name — an RA profile, a user name, ' +
            'an OID, a connector kind — cannot be proven own; guard/routes.ts API_WORDS)'
        : undefined;
}

/** The API path (after `/api`) of an effective pathname, or undefined outside `/api/v1|v2`. */
export const apiPathOfPathname = (pathname: string): string | undefined => /^\/api(\/v[12](?:\/.*)?)$/.exec(pathname)?.[1];
/** The API path a GET reaches as the server decodes it (percent-escapes, `;` content): for the side-effect rule. */
export const readApiPath = (effective: URL): string | undefined => apiPathOfPathname(decodedApiPath(effective.pathname));

/**
 * Why a mutating request's URL is not a plain API path, or undefined: printable ASCII only,
 * the path as written equal to the effective one, unreserved segments, no non-canonical uuid segment. Pure (no origin
 * rule): `check` and `allowedRawPost` add it.
 */
export function pathProblem(url: string): string | undefined {
    if (typeof url !== 'string') return 'a URL that is not a string';
    if (NOT_PRINTABLE.test(url)) return NOT_PRINTABLE_REASON;
    let effective: URL;
    try {
        effective = new URL(url, NO_BASE);
    } catch {
        return 'a URL that does not parse';
    }
    return structuralPathProblem({ effective, rawPath: rawPathOf(url) }) ?? uuidSegmentProblem(effective.pathname);
}

/** The API path after `/api` (query and origin dropped, trailing slashes trimmed); undefined outside the ILM API. */
export function apiPathOf(url: string): string | undefined {
    let pathname: string;
    try {
        pathname = new URL(url, NO_BASE).pathname;
    } catch {
        return undefined;
    }
    const m = /^\/api(\/v[12]\/.*)$/.exec(pathname);
    return m ? m[1].replace(/\/+$/, '') : undefined;
}

/**
 * Why a URL may not be sent with the run's credentials (`resolveSentUrl`: written form, printable ASCII, http(s), no
 * user info, BASE_URL's origin), or undefined; relative URLs resolve against BASE_URL like the context's baseURL.
 */
export function originProblem(url: string, env: NodeJS.ProcessEnv = process.env): string | undefined {
    const r = resolveSentUrl(url, { env });
    return 'problem' in r ? r.problem : undefined;
}

/** The keys of a query string that name a method override (Spring's HiddenHttpMethodFilter reads `_method`). */
export const hasMethodParam = (search: URLSearchParams): boolean => [...search.keys()].some((k) => k.toLowerCase() === '_method');

/**
 * Throws OwnObjectViolation (kind `request`) unless `url` resolves to BASE_URL's origin (written form, printable ASCII,
 * http(s), no user info), passes the shared structural path rule (`readPathProblem`) and is no side-effect
 * GET (those need the guarded context's ownership check): a RAW authenticated context's GET (regressionApi
 * `apiJson`) must not carry the run's credentials elsewhere.
 */
export function assertSameOrigin(url: string, where: string, env: NodeJS.ProcessEnv = process.env): string {
    const r = resolveSentUrl(url, { env });
    if ('problem' in r) throw new OwnObjectViolation(where, {}, `${r.problem}: an authenticated context talks to BASE_URL only`, undefined, 'request');
    // The structural path rule of every guarded request (no `//`, `;`, dot segment, `%2f` / `%5c` / `%2e`,
    // backslash or `/API` spelling), so the side-effect rule below matches what the server dispatches.
    const structural = readPathProblem(r.sent);
    if (structural) throw new OwnObjectViolation(where, {}, `${structural}: a raw GET is judged like a guarded one`, undefined, 'request');
    const apiPath = readApiPath(r.sent.effective);
    if (apiPath && sideEffectGet(apiPath)) {
        throw new OwnObjectViolation(where, {}, 'a GET that persists something (guard/routes.ts SIDE_EFFECT_GETS) goes through the guarded context, which checks ownership', undefined, 'request');
    }
    return url;
}
