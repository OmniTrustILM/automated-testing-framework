/**
 * protocolHttp — anonymous HTTP to the protocol endpoints (ACME, SCEP, CMP): no credentials, no redirects, POSTs only through
 * `allowedRawPost`, bodies kept as bytes.
 */
import * as crypto from 'crypto';
import { allowedRawPost } from '../guard/rawPost';

export interface ProtocolResponse {
    status: number;
    headers: Record<string, string>;
    contentType?: string;
    body: Buffer;
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

export async function protocolGet(url: string, opts: { accept?: string } = {}): Promise<ProtocolResponse> {
    const res = await fetch(url, { method: 'GET', redirect: 'manual', headers: opts.accept ? { accept: opts.accept } : {} });
    return readResponse(res);
}

export interface ProtocolPostOptions {
    contentType?: string;
    body: Buffer | string;
    accept?: string;
}

export async function protocolPost(url: string, opts: ProtocolPostOptions): Promise<ProtocolResponse> {
    const headers: Record<string, string> = {};
    if (opts.contentType !== undefined) headers['content-type'] = opts.contentType;
    if (opts.accept) headers.accept = opts.accept;
    const body = typeof opts.body === 'string' ? Buffer.from(opts.body, 'utf8') : opts.body;
    const res = await fetch(allowedRawPost(url, { unauthenticated: true }), { method: 'POST', redirect: 'manual', headers, body: new Uint8Array(body) });
    return readResponse(res);
}

export function acmeProblem(res: ProtocolResponse): { type: string; detail: string; status?: number } | undefined {
    try {
        const body = JSON.parse(res.text) as Record<string, unknown>;
        if (!body || typeof body !== 'object' || typeof body.type !== 'string') return undefined;
        return { type: body.type, detail: typeof body.detail === 'string' ? body.detail : '', ...(typeof body.status === 'number' ? { status: body.status } : {}) };
    } catch {
        return undefined;
    }
}

export const acmeErrorType = (code: string): string => `urn:ietf:params:acme:error:${code}`;

export const isProblemJson = (contentType: string | undefined): boolean => /^application\/problem\+json\b/i.test(contentType ?? '');

/** A fragment of a stack trace or Java class name in a response body (what a client must never see), or undefined. */
export function stackTextIn(text: string): string | undefined {
    const m = /(\bat [a-z][\w$]*(\.[\w$]+)+\([^)]*\)|\b(java|jakarta|org|com)\.[a-z][\w.$]*(Exception|Error)\b)/.exec(text);
    return m ? m[0] : undefined;
}

/** Fixed pseudo-random bytes for the malformed-body pins: the same on every run, so a failure replays byte for byte. */
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

