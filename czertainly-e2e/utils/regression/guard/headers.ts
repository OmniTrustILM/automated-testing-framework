export type Method = 'GET' | 'POST' | 'PUT' | 'PATCH' | 'DELETE' | 'TRACE' | 'QAPROBE';
/**
 * The refused-method sentinels (TRACE, API-GEN-32[method], core#2502; QAPROBE, the one fixed token nothing maps —
 * API-GEN-07[unknown-method]): a bodyless READ held to the
 * GET rules and stricter (no body, no identity header, no `identityOverride`, no `text/plain`, never a redirect
 * follow, no side-effect GET path), sent through `fetch` only. Exactly these two tokens: PROPFIND (a real WebDAV
 * method some proxies handle), FOO and every other token stay refused.
 */
export const PROBE_METHODS: ReadonlySet<string> = new Set(['TRACE', 'QAPROBE']);
// Literal lists (a test-coverage generator reads these tables as string literals): METHODS = the five HTTP methods the
// suite sends plus PROBE_METHODS (HEAD is not sent through the guard); BODYLESS = GET plus PROBE_METHODS
// (tests/unit/guardedApiAllowedRequests.spec.ts pins the three in step).
export const METHODS: ReadonlySet<string> = new Set(['GET', 'POST', 'PUT', 'PATCH', 'DELETE', 'TRACE', 'QAPROBE']);
/** Methods without a body that only read (the sentinels join GET for the body and text/plain rules). */
export const BODYLESS: ReadonlySet<string> = new Set(['GET', 'TRACE', 'QAPROBE']);
/** The three method tables, for the unit test that keeps them in step. */
export const METHOD_TABLES = { METHODS, BODYLESS, PROBE_METHODS };
// ------------------------------------------------------------------ options and headers

/** A header that names a method (`X-HTTP-Method-Override`, `X-HTTP-Method`, `X-Method-Override`, `X-Forwarded-Method` …). */
const METHOD_HEADER = /(^|-)method(-|$)/i;
/** A content type the server reads as request parameters (Spring's FormContentFilter) or parts. */
const FORM_CONTENT = /x-www-form-urlencoded|multipart\//i;
/** Identity headers: another identity than the run's, only with `identityOverride: true` (401 / 403 negatives). */
export const IDENTITY_HEADERS: ReadonlySet<string> = new Set(['authorization', 'ssl-client-cert', 'cookie']);
/** Protocol media types a protocol POST may declare (ACME JWS, CMP, SCEP, TSP). */
export const PROTOCOL_CONTENT = new Set(['application/jose+json', 'application/pkixcmp', 'application/x-pki-message', 'application/timestamp-query']);
export const JSON_CONTENT = 'application/json';
/**
 * `text/plain`, with no parameter but an optional `charset=utf-8` (any case, unquoted): the content type of a 415
 * negative. Group 1 is set when the charset is given. Sent normalised
 * (TEXT_CONTENT / TEXT_CONTENT_UTF8).
 */
const TEXT_PLAIN = /^text\/plain(\s*;\s*charset=utf-8)?$/i;
const TEXT_CONTENT = 'text/plain';
const TEXT_CONTENT_UTF8 = 'text/plain; charset=utf-8';
/** The normalised `text/plain` content type of a header value, or undefined when it is not one. */
export const textPlainType = (value: string): string | undefined => {
    const m = TEXT_PLAIN.exec(value.trim());
    return m ? (m[1] ? TEXT_CONTENT_UTF8 : TEXT_CONTENT) : undefined;
};
/** The options the guard forwards to Playwright (plus `method` on `fetch`; `identityOverride` is the guard's own). */
export const FORWARDED_OPTIONS: readonly string[] = ['data', 'params', 'headers', 'timeout', 'failOnStatusCode', 'ignoreHTTPSErrors'];
export const OPTION_KEYS = new Set([...FORWARDED_OPTIONS, 'identityOverride']);
export const REDIRECTS = new Set([301, 302, 303, 307, 308]);
/** Playwright's default redirect limit; the guard follows (same-origin) redirects of a GET itself. */
export const DEFAULT_MAX_REDIRECTS = 20;

/**
 * The content types a READ POST (POST_READ: a search such as `POST /v1/certificates`) may
 * declare for a 415 negative (core#2140), besides JSON / text/plain: `application/xml`, `application/octet-stream`
 * (what an untyped client really sends: Playwright sends it for an untyped string / Buffer), and
 * `multipart/form-data; boundary=<1-70 RFC 2046 characters, no space>`. Never `application/x-www-form-urlencoded`,
 * never a type with any other parameter. Why only a read POST: Spring's FormContentFilter reads PUT / PATCH / DELETE
 * form fields as request parameters (a `_method` field could change the method), but a read POST cannot be turned into
 * a mutation by a body it does not parse — `POST /v1/certificates` takes only a JSON `@Valid @RequestBody`
 * (interfaces CertificateController), core declares no XML data format (`core/pom.xml`: jackson-dataformat-csv
 * only) and no `hiddenmethod` / `formcontent` / `multipart` configuration (`application.yml`), so Spring answers
 * `HttpMediaTypeNotSupportedException` before any controller, which core has no handler for (the generic `Exception`
 * handler, api/ExceptionHandlingAdvice: the 500 of core#2140). Group 1 of the multipart form is the boundary.
 */
const READ_POST_TYPES = /^(application\/xml|application\/octet-stream|multipart\/form-data;\s*boundary=([0-9A-Za-z'()+_,\-./:=?]{1,70}))$/i;
/** The normalised read-POST content type of a header value, or undefined when it is not one. */
export const readPostType = (value: string): string | undefined => {
    const m = READ_POST_TYPES.exec(value.trim());
    if (!m) return undefined;
    return m[2] !== undefined ? `multipart/form-data; boundary=${m[2]}` : m[1].toLowerCase();
};
/** A `_method` anywhere in a body text (any case): a form reader could take it for a method override. */
export const METHOD_IN_TEXT = /_method/i;

/** Why a header (lower-cased name) may not be sent, or undefined (rule b). */
export function headerProblem(name: string, value: string, ctx: { protocol: boolean; identityOverride: boolean; readPost: boolean }): string | undefined {
    if (METHOD_HEADER.test(name)) return 'a method-override header';
    if (name === 'content-type') {
        const v = value.trim().toLowerCase();
        // The three read-POST types, on a POST_READ route only (the body and identity conditions: the snapshot).
        if (ctx.readPost && readPostType(v)) return undefined;
        if (FORM_CONTENT.test(v)) return 'a form / multipart content type (the server reads form fields as request parameters)';
        if (v === JSON_CONTENT || (ctx.protocol && PROTOCOL_CONTENT.has(v))) return undefined;
        // text/plain: the body and identity conditions are checked by the snapshot, which knows the method and the body.
        if (textPlainType(v)) return undefined;
        return 'a content type other than application/json or text/plain (a charset other than utf-8, a parameter or another media type ' +
            'changes how the server reads the bytes)';
    }
    if (name === 'accept' || /^if-[a-z-]+$/.test(name)) return undefined;
    if (IDENTITY_HEADERS.has(name)) return ctx.identityOverride ? undefined : 'an identity header (authorization, ssl-client-cert, cookie) without identityOverride: true';
    return `a header the guard does not forward ("${name.slice(0, 32)}": content-type, accept and if-* only)`;
}

