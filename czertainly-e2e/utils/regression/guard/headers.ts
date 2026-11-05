export type Method = 'GET' | 'POST' | 'PUT' | 'PATCH' | 'DELETE' | 'TRACE' | 'QAPROBE';
/**
 * The refused-method sentinels (TRACE, QAPROBE): a bodyless read held to
 * the GET rules and stricter; only these two tokens, sent through `fetch`.
 */
export const PROBE_METHODS: ReadonlySet<string> = new Set(['TRACE', 'QAPROBE']);
// Literal lists: a test-coverage generator reads these tables as string literals.
export const METHODS: ReadonlySet<string> = new Set(['GET', 'POST', 'PUT', 'PATCH', 'DELETE', 'TRACE', 'QAPROBE']);
export const BODYLESS: ReadonlySet<string> = new Set(['GET', 'TRACE', 'QAPROBE']);
export const METHOD_TABLES = { METHODS, BODYLESS, PROBE_METHODS };

const METHOD_HEADER = /(^|-)method(-|$)/i;
const FORM_CONTENT = /x-www-form-urlencoded|multipart\//i;
export const IDENTITY_HEADERS: ReadonlySet<string> = new Set(['authorization', 'ssl-client-cert', 'cookie']);
export const PROTOCOL_CONTENT = new Set(['application/jose+json', 'application/pkixcmp', 'application/x-pki-message', 'application/timestamp-query']);
export const JSON_CONTENT = 'application/json';
/** `text/plain`, optionally with `charset=utf-8`: the content type of a 415 negative; group 1 is the charset. */
const TEXT_PLAIN = /^text\/plain(\s*;\s*charset=utf-8)?$/i;
const TEXT_CONTENT = 'text/plain';
const TEXT_CONTENT_UTF8 = 'text/plain; charset=utf-8';
export const textPlainType = (value: string): string | undefined => {
    const m = TEXT_PLAIN.exec(value.trim());
    return m ? (m[1] ? TEXT_CONTENT_UTF8 : TEXT_CONTENT) : undefined;
};
export const FORWARDED_OPTIONS: readonly string[] = ['data', 'params', 'headers', 'timeout', 'failOnStatusCode', 'ignoreHTTPSErrors'];
export const OPTION_KEYS = new Set([...FORWARDED_OPTIONS, 'identityOverride']);
export const REDIRECTS = new Set([301, 302, 303, 307, 308]);
export const DEFAULT_MAX_REDIRECTS = 20;

/**
 * Content types a READ POST may declare for a 415 negative, besides JSON / text/plain: xml, octet-stream and
 * multipart with a boundary (group 1). Never form-urlencoded: PUT / PATCH / DELETE form fields become request
 * parameters, but a read POST cannot be turned into a mutation by a body it does not parse.
 */
const READ_POST_TYPES = /^(application\/xml|application\/octet-stream|multipart\/form-data;\s*boundary=([0-9A-Za-z'()+_,\-./:=?]{1,70}))$/i;
export const readPostType = (value: string): string | undefined => {
    const m = READ_POST_TYPES.exec(value.trim());
    if (!m) return undefined;
    return m[2] !== undefined ? `multipart/form-data; boundary=${m[2]}` : m[1].toLowerCase();
};
export const METHOD_IN_TEXT = /_method/i;

export function headerProblem(name: string, value: string, ctx: { protocol: boolean; identityOverride: boolean; readPost: boolean }): string | undefined {
    if (METHOD_HEADER.test(name)) return 'a method-override header';
    if (name === 'content-type') {
        const v = value.trim().toLowerCase();
        if (ctx.readPost && readPostType(v)) return undefined;
        if (FORM_CONTENT.test(v)) return 'a form / multipart content type (the server reads form fields as request parameters)';
        if (v === JSON_CONTENT || (ctx.protocol && PROTOCOL_CONTENT.has(v))) return undefined;
        if (textPlainType(v)) return undefined;
        return 'a content type other than application/json or text/plain (a charset other than utf-8, a parameter or another media type ' +
            'changes how the server reads the bytes)';
    }
    if (name === 'accept' || /^if-[a-z-]+$/.test(name)) return undefined;
    if (IDENTITY_HEADERS.has(name)) return ctx.identityOverride ? undefined : 'an identity header (authorization, ssl-client-cert, cookie) without identityOverride: true';
    return `a header the guard does not forward ("${name.slice(0, 32)}": content-type, accept and if-* only)`;
}

