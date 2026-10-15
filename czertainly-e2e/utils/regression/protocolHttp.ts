/**
 * protocolHttp — the HTTP seam of the protocol endpoints (ACME, SCEP, CMP) for the request-level pins.
 *
 * The protocol endpoints are anonymous by design (the protocol carries its own proof of identity; protocols rules §1,
 * `ProtocolValidationFilter`), so like `acmeClient.ts` this module uses the global `fetch` without credentials:
 * a GET goes to the URL as given (the directory / `pkiclient.exe` query forms), a POST only through `allowListedPost`
 * (guardedApi.ts, `unauthenticated: true`): a protocol path of `/api/v1|v2/protocols/…`, judged like the guard judges
 * a URL — so the module cannot be pointed at a REST mutation (review Q2; the lint sees the runtime check). Redirects
 * are never followed (a protocol answer is what the server sent). Bodies are kept as bytes: SCEP and CMP answer DER.
 */
import * as crypto from 'crypto';
import { allowListedPost } from './guardedApi';

export interface ProtocolResponse {
    status: number;
    /** Lower-case header names. */
    headers: Record<string, string>;
    contentType?: string;
    body: Buffer;
    /** The body as UTF-8 text (for JSON / problem+json / text answers). */
    text: string;
}

async function readResponse(res: Response): Promise<ProtocolResponse> {
    const headers: Record<string, string> = {};
    res.headers.forEach((value, name) => {
        headers[name.toLowerCase()] = value;
    });
    const body = Buffer.from(await res.arrayBuffer());
    return { status: res.status, headers, contentType: headers['content-type'], body, text: body.toString('utf8') };
}

/** A plain GET of a protocol URL (no credentials, no redirect follow). */
export async function protocolGet(url: string, opts: { accept?: string } = {}): Promise<ProtocolResponse> {
    const res = await fetch(url, { method: 'GET', redirect: 'manual', headers: opts.accept ? { accept: opts.accept } : {} });
    return readResponse(res);
}

export interface ProtocolPostOptions {
    /** Sent as written (the content type IS the parameter of several pins). */
    contentType?: string;
    body: Buffer | string;
    accept?: string;
}

/** A POST to a protocol URL (`allowListedPost`), the body sent byte for byte under the given content type. */
export async function protocolPost(url: string, opts: ProtocolPostOptions): Promise<ProtocolResponse> {
    const headers: Record<string, string> = {};
    if (opts.contentType !== undefined) headers['content-type'] = opts.contentType;
    if (opts.accept) headers.accept = opts.accept;
    const body = typeof opts.body === 'string' ? Buffer.from(opts.body, 'utf8') : opts.body;
    // The allow-list check is the URL argument itself (the lint reads it there: a raw POST only through allowListedPost).
    const res = await fetch(allowListedPost(url, { unauthenticated: true }), { method: 'POST', redirect: 'manual', headers, body: new Uint8Array(body) });
    return readResponse(res);
}

/** `type` and `detail` of an ACME problem document (RFC 8555 §6.7), or undefined when the body is not one. */
export function acmeProblem(res: ProtocolResponse): { type: string; detail: string; status?: number } | undefined {
    try {
        const body = JSON.parse(res.text) as Record<string, unknown>;
        if (!body || typeof body !== 'object' || typeof body.type !== 'string') return undefined;
        return { type: body.type, detail: typeof body.detail === 'string' ? body.detail : '', ...(typeof body.status === 'number' ? { status: body.status } : {}) };
    } catch {
        return undefined;
    }
}

/** The ACME error type URN of a code (RFC 8555 §6.7). */
export const acmeErrorType = (code: string): string => `urn:ietf:params:acme:error:${code}`;

/** Is the content type `application/problem+json` (parameters ignored)? */
export const isProblemJson = (contentType: string | undefined): boolean => /^application\/problem\+json\b/i.test(contentType ?? '');

/**
 * A fragment of a stack trace or a Java class name in a response body (what a client must never see), or undefined:
 * `at com.example.Foo.bar(Foo.java:12)`, `java.lang.NullPointerException`, `com.otilm.core.…Exception`.
 */
export function stackTextIn(text: string): string | undefined {
    const m = /(\bat [a-z][\w$]*(\.[\w$]+)+\([^)]*\)|\b(java|jakarta|org|com)\.[a-z][\w.$]*(Exception|Error)\b)/.exec(text);
    return m ? m[0] : undefined;
}

/**
 * FIXED pseudo-random bytes for the malformed-body pins (a sha256 chain over `seed`): the same bytes on every run, so a
 * failure replays byte for byte (reviewer F9: never `randomBytes` in a pin).
 */
export function fixedGarbage(seed: string, length: number): Buffer {
    const chunks: Buffer[] = [];
    let block = crypto.createHash('sha256').update(`qa-reg garbage ${seed}`).digest();
    let total = 0;
    while (total < length) {
        chunks.push(block);
        total += block.length;
        block = crypto.createHash('sha256').update(block).digest();
    }
    return Buffer.concat(chunks).subarray(0, length);
}

/** The inventory-style sha256 fingerprint of DER bytes is in protocolPki; this re-export keeps the API specs to one import. */
export { sha256Hex } from './protocolPki';
