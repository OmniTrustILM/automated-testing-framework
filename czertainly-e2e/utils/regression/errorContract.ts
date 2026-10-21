/**
 * errorContract — the shape of an ILM core error body, as one pure reader (REG-USE-07.1, REG-DEP-01.c, the
 * API-GEN-32 error sentinel; the full battery is API-GEN-01).
 *
 * The rule (the error contract of the inventory API, ExceptionHandlingAdvice + ErrorMessageDto, unchanged by the Spring 7
 * migration): a 422 is a JSON ARRAY of non-empty strings; every other core error (400, 404, 409, 500) is an OBJECT
 * with exactly one string member `message`. An API negative asserts the status AND this shape (spec-authoring hard
 * rule 8), never the status alone.
 */

export type ErrorShape =
    | { kind: 'messages'; messages: string[] }
    | { kind: 'message'; message: string }
    | { kind: 'empty' }
    | { kind: 'other'; why: string };

/** Classify an error body (the raw text of the response). */
export function errorShape(text: string): ErrorShape {
    if (!text || !text.trim()) return { kind: 'empty' };
    let body: unknown;
    try {
        body = JSON.parse(text);
    } catch {
        return { kind: 'other', why: 'not JSON' };
    }
    if (Array.isArray(body)) {
        if (body.length && body.every((x) => typeof x === 'string' && x.trim().length > 0)) return { kind: 'messages', messages: body as string[] };
        return { kind: 'other', why: 'an array that is empty or holds something other than non-empty strings' };
    }
    if (body && typeof body === 'object') {
        const keys = Object.keys(body as object);
        const message = (body as { message?: unknown }).message;
        if (keys.length === 1 && keys[0] === 'message' && typeof message === 'string') return { kind: 'message', message };
        return { kind: 'other', why: `an object with keys [${keys.join(', ')}]` };
    }
    return { kind: 'other', why: `a JSON ${typeof body}` };
}

/** The 422 rule: the body is a JSON array of non-empty strings; returns them, else throws naming the shape. */
export function expect422Messages(text: string): string[] {
    const s = errorShape(text);
    if (s.kind !== 'messages') throw new Error(`a 422 body must be a JSON array of non-empty strings; got ${s.kind === 'other' ? s.why : s.kind}`);
    return s.messages;
}

/** The non-422 rule: the body is `{ "message": "<text>" }` and nothing else; returns the message, else throws. */
export function expectMessageObject(text: string): string {
    const s = errorShape(text);
    if (s.kind !== 'message') throw new Error(`an error body must be {"message": "<text>"} and nothing else; got ${s.kind === 'other' ? s.why : s.kind}`);
    return s.message;
}

// ------------------------------------------------------------------ the refused-method answer (API-GEN-32[method])

/** What a refused HTTP method (TRACE) answered: the status, the lower-case response headers and the raw body text. */
export interface RefusedMethodAnswer {
    status: number;
    headers: Record<string, string>;
    bodyText: string;
}

/** The skip reason of a sentinel whose answer did not come from core (the ingress / a proxy in front of it refused first). */
export const INGRESS_SKIP_MESSAGE = 'refused by the ingress before core (its firewall allow list)';

/** `Server` header values of the proxies / ingress controllers an ILM tier may sit behind (Tomcat's own value is not among them). */
const PROXY_SERVER = /\b(nginx|envoy|haproxy|traefik|istio|cloudflare|openresty|awselb|varnish|squid|caddy|kong|akamai|bigip|netscaler)\b/i;

export type RefusedMethodResult =
    /** Not core's answer: the test skips with INGRESS_SKIP_MESSAGE; `why` is only a status, a byte count or a proxy name. */
    | { outcome: 'skip'; why: string }
    /** Core's answer: `problems` is empty for the baseline (400, empty body), else says what differs (status, byte count). */
    | { outcome: 'core'; problems: string[] };

/**
 * Judge the answer to a refused method. Whose answer is it? A 405, a `Server` header naming a proxy, or a body that is
 * neither empty nor JSON is the ingress's (core answers a refused method 400 with an empty body on main, 401 on the
 * migrated build, core#2502): skip, so neither a red gate on main nor a masked core#2502 on a migrated build. For core's
 * answer the problems are numbers only — the BODY is never put in a message (a proxy or an error forward could echo the
 * bearer token of the request).
 */
export function checkRefusedMethod(answer: RefusedMethodAnswer): RefusedMethodResult {
    if (answer.status === 405) return { outcome: 'skip', why: 'HTTP 405' };
    const proxy = PROXY_SERVER.exec(answer.headers.server ?? '');
    if (proxy) return { outcome: 'skip', why: `server header names a proxy (${proxy[1].toLowerCase()})` };
    const bytes = Buffer.byteLength(answer.bodyText.trim());
    if (bytes > 0 && !isJson(answer.bodyText)) return { outcome: 'skip', why: `non-JSON body (${bytes} bytes)` };
    const problems: string[] = [];
    if (answer.status !== 400) problems.push(`status ${answer.status}, expected 400`);
    if (bytes > 0) problems.push(`body is not empty (${bytes} bytes), expected an empty body`);
    return { outcome: 'core', problems };
}

function isJson(text: string): boolean {
    try {
        JSON.parse(text);
        return true;
    } catch {
        return false;
    }
}
