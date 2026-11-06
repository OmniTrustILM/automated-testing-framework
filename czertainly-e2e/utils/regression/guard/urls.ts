import { IS_UUID, isCanonicalUuid, isUuidLike, UUID } from './uuids';
import { API_WORDS, decodedApiPath, sideEffectGet } from './routes';
import { OwnObjectViolation } from '../ledger/ownership';
export const NO_BASE = 'http://base-url-unset.invalid/';
/** Printable ASCII only: control characters, space, DEL and non-ASCII are stripped or re-encoded by the parser. */
const NOT_PRINTABLE = /[^\x21-\x7e]/;
const NOT_PRINTABLE_REASON = 'a control character, space, DEL or non-ASCII character in the URL (the URL parser strips, trims or ' +
    're-encodes it: the server would see another URL than the guard checked)';
const WRITTEN_FORM = /^(\/(?!\/)|[A-Za-z][A-Za-z0-9+.-]*:\/\/)/;
const WRITTEN_FORM_REASON = 'a URL that is neither path-absolute (/…) nor absolute (<scheme>://…): scheme-relative (//host), ' +
    '`scheme:path`, relative and query / fragment-only forms resolve to places the guard does not want to guess';
const SEGMENT = /^[A-Za-z0-9._~-]+$/;
export const SEG = '(?!\\.\\.?(?:/|$))[A-Za-z0-9._~-]+';

export function rawPathOf(url: string): string {
    const m = /^([A-Za-z][A-Za-z0-9+.-]*:)?(\/\/[^/?#]*)?([^?#]*)/.exec(url);
    return m ? m[3] : url;
}

const isAbsolute = (url: string): boolean => /^[A-Za-z][A-Za-z0-9+.-]*:/.test(url) || url.startsWith('//');

export interface SentUrl {
    effective: URL;
    rawPath: string;
}

export interface SentUrlOptions {
    env?: NodeJS.ProcessEnv;
    anyOrigin?: boolean;
}

/**
 * The URL as written is `/…` or `<scheme>://…`, printable ASCII, http(s), no user info, on BASE_URL's origin. Returns the problem, or the
 * resolved URL. Messages never echo a host.
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
 * Characters and segments of a path that let a server or proxy reach another endpoint than the one matched: `\`, `;`, encoded `/` `\` `.`,
 * empty and dot segments.
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
 * The structural path rule shared by every guarded request: `pathCharProblem`, a
 * path the URL parser would change, and a non-exact `/api/` prefix (case-sensitive).
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
 * Rule 1 (structure of the path) for mutations: `readPathProblem`, then
 * no `%`, no empty segment or trailing slash, unreserved segments only.
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
 * Rule 3 for paths: a uuid-like but non-canonical segment (Spring parses path variables with `UUID.fromString`), or a canonical uuid inside
 * a longer segment.
 */
export function uuidSegmentProblem(pathname: string): string | undefined {
    const bad = pathname.split('/').filter((s) => s && !isCanonicalUuid(s) && (isUuidLike(s, { base64: false }) || new RegExp(UUID).test(s)));
    return bad.length ? 'a non-canonical uuid segment in the path (the server would parse it as a uuid the guard does not recognise)' : undefined;
}

/**
 * Rule 6a: a mutation path segment that is neither a canonical uuid nor
 * an API word names an object by name, which the guard cannot prove own.
 */
export function nameSegmentProblem(apiPath: string): string | undefined {
    const named = apiPath.split('/').slice(2).filter((s) => s && !IS_UUID.test(s) && !API_WORDS.has(s));
    return named.length
        ? 'a path segment that is neither a uuid nor a word of the ILM API (an object named by its name — an RA profile, a user name, ' +
            'an OID, a connector kind — cannot be proven own; guard/routes.ts API_WORDS)'
        : undefined;
}

export const apiPathOfPathname = (pathname: string): string | undefined => /^\/api(\/v[12](?:\/.*)?)$/.exec(pathname)?.[1];
export const readApiPath = (effective: URL): string | undefined => apiPathOfPathname(decodedApiPath(effective.pathname));

/** Why a mutating request's URL is not a plain API path, or undefined. Pure: no origin rule. */
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

/** Why a URL may not be sent with the run's credentials (see `resolveSentUrl`), or undefined. */
export function originProblem(url: string, env: NodeJS.ProcessEnv = process.env): string | undefined {
    const r = resolveSentUrl(url, { env });
    return 'problem' in r ? r.problem : undefined;
}

export const hasMethodParam = (search: URLSearchParams): boolean => [...search.keys()].some((k) => k.toLowerCase() === '_method');

/**
 * Throws OwnObjectViolation unless `url` is on BASE_URL's origin, passes the structural path rule and is no side-effect GET: a raw GET must
 * not carry the run's credentials elsewhere.
 */
export function assertSameOrigin(url: string, where: string, env: NodeJS.ProcessEnv = process.env): string {
    const r = resolveSentUrl(url, { env });
    if ('problem' in r) throw new OwnObjectViolation(where, {}, `${r.problem}: an authenticated context talks to BASE_URL only`, undefined, 'request');
    const structural = readPathProblem(r.sent);
    if (structural) throw new OwnObjectViolation(where, {}, `${structural}: a raw GET is judged like a guarded one`, undefined, 'request');
    const apiPath = readApiPath(r.sent.effective);
    if (apiPath && sideEffectGet(apiPath)) {
        throw new OwnObjectViolation(where, {}, 'a GET that persists something (guard/routes.ts SIDE_EFFECT_GETS) goes through the guarded context, which checks ownership', undefined, 'request');
    }
    return url;
}
