/**
 * jwtTools — decode, tamper and forge bearer tokens for the authentication negatives. Pure (`node:crypto`), nothing is written
 * or logged; a forged token is signed with a throwaway in-memory RSA key, so the platform can only refuse it (core
 * `PlatformJwtDecoder`: signature, issuer, time and audience are verified, every refusal is 401). Ten variants, each sent
 * between two untouched-token controls; `TOKENLESS_VARIANTS` need no identity-provider call.
 */
import * as crypto from 'crypto';
import { base64Url } from '../text';

export interface DecodedJwt {
    header: Record<string, unknown>;
    payload: Record<string, unknown>;
    /** The three dot-separated segments as written (the signature segment is empty for an unsigned token). */
    segments: [string, string, string];
}

function fromB64url(segment: string): Buffer {
    return Buffer.from(segment.replace(/-/g, '+').replace(/_/g, '/'), 'base64');
}

/** Decode a compact JWT WITHOUT verifying it; throws when it is not three JSON-bearing segments. */
export function decodeJwt(token: string): DecodedJwt {
    const parts = token.split('.');
    if (parts.length !== 3) throw new Error(`not a compact JWT: ${parts.length} segment(s)`);
    const read = (segment: string, what: string): Record<string, unknown> => {
        try {
            const value = JSON.parse(fromB64url(segment).toString('utf8')) as unknown;
            if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error('not an object');
            return value as Record<string, unknown>;
        } catch (e) {
            throw new Error(`JWT ${what} is not a JSON object (${(e as Error).message})`);
        }
    };
    return { header: read(parts[0], 'header'), payload: read(parts[1], 'payload'), segments: [parts[0], parts[1], parts[2]] };
}

/** One claim of a token's payload (undefined when absent). */
export function claimOf(token: string, name: string): unknown {
    return decodeJwt(token).payload[name];
}

/** The signing algorithm a forged token claims (a real one: the platform has to verify the signature, not guess). */
const FORGED_ALG = 'RS256';

let throwaway: crypto.KeyObject | undefined;

/** A throwaway RSA-2048 private key, generated once per process; the matching public key is never shared with anyone. */
function throwawayKey(): crypto.KeyObject {
    if (!throwaway) throwaway = crypto.generateKeyPairSync('rsa', { modulusLength: 2048 }).privateKey;
    return throwaway;
}

/** Sign `header.payload` with the throwaway key: a well-formed RS256 token no configured provider can have issued. */
export function signWithThrowawayKey(header: Record<string, unknown>, payload: Record<string, unknown>): string {
    const head = base64Url(JSON.stringify({ ...header, alg: FORGED_ALG, typ: 'JWT' }));
    const body = base64Url(JSON.stringify(payload));
    const signature = crypto.sign('RSA-SHA256', Buffer.from(`${head}.${body}`), throwawayKey());
    return `${head}.${body}.${base64Url(signature)}`;
}

/** A character that differs from `c` and stays inside the base64url alphabet. */
function otherBase64urlChar(c: string): string {
    return c === 'A' ? 'B' : 'A';
}

/**
 * The signature with ONE character changed. The FIRST character is changed, not the last: the last base64url character
 * of a 256-byte RS256 signature carries four padding bits, so another character with the same two leading data bits
 * decodes to the identical bytes and the token would stay valid (a false "tampered token accepted"). The first character
 * is six significant bits.
 */
export function tamperSignature(token: string): string {
    const [head, body, sig] = decodeJwt(token).segments;
    if (!sig) throw new Error('the token has no signature to change');
    return `${head}.${body}.${otherBase64urlChar(sig[0])}${sig.slice(1)}`;
}

/**
 * The payload with ONE character of its JSON text changed (still valid JSON that decodes to different claims): the last
 * character of the first string claim value longer than one character (typically `sub` or `username`); head and
 * signature are kept, so only the signature check can notice.
 */
export function tamperPayload(token: string): string {
    const { segments } = decodeJwt(token);
    const text = fromB64url(segments[1]).toString('utf8');
    const m = /:\s*"([^"\\]{2,})"/.exec(text);
    if (!m) throw new Error('the payload has no string claim to change');
    const end = m.index + m[0].length - 1; // the closing quote
    const last = text[end - 1];
    const changed = `${text.slice(0, end - 1)}${last === 'x' ? 'y' : 'x'}${text.slice(end)}`;
    return `${segments[0]}.${base64Url(changed)}.${segments[2]}`;
}

/** `alg: none` with the real claims and an EMPTY signature (RFC 7519 §6 unsecured JWT). */
export function unsignedToken(payload: Record<string, unknown>): string {
    return `${base64Url(JSON.stringify({ alg: 'none', typ: 'JWT' }))}.${base64Url(JSON.stringify(payload))}.`;
}

/** A host name that can never resolve (RFC 6761 `.invalid`): no configured provider, and nothing to fetch. */
export const UNKNOWN_ISSUER = 'https://idp.qa-reg.invalid/realms/none';

export type TokenVariant =
    | 'signature' | 'payload' | 'unsigned' | 'forged-real-issuer' | 'forged-unknown-issuer'
    | 'no-iss' | 'not-a-jwt' | 'empty' | 'wrong-scheme' | 'query-only';

/** Variants that alter or copy the valid token (they need it). */
export const TOKEN_VARIANTS: readonly TokenVariant[] = ['signature', 'payload', 'forged-real-issuer'];
/** Variants built from nothing: no valid token, no identity-provider call. */
export const TOKENLESS_VARIANTS: readonly TokenVariant[] = ['unsigned', 'forged-unknown-issuer', 'no-iss', 'not-a-jwt', 'empty', 'wrong-scheme'];
/** Needs a request WITHOUT the context's own credentials (a credential-less guarded context), so it also needs a token. */
export const ANONYMOUS_VARIANTS: readonly TokenVariant[] = ['query-only'];

/** One request the variant stands for: the `authorization` header value, if any, and query parameters, if any. */
export interface VariantRequest {
    variant: TokenVariant;
    /** The `authorization` header to send (undefined: send none; only a credential-less context can honour that). */
    authorization?: string;
    /** Query parameters (the `query-only` variant). */
    query?: Record<string, string>;
    /** Why this must be refused, for the assertion message. */
    why: string;
}

/** Claims a made-up token carries when no valid token is available (shape of a real one; nothing here is a secret). */
export function syntheticClaims(username: string, issuer: string = UNKNOWN_ISSUER, nowSeconds: number = Math.floor(Date.now() / 1000)): Record<string, unknown> {
    return { iss: issuer, sub: crypto.randomUUID(), username, iat: nowSeconds, exp: nowSeconds + 300, jti: crypto.randomUUID() };
}

export interface BuildOptions {
    /** The valid token (needed by `signature`, `payload`, `forged-real-issuer` and `query-only`). */
    validToken?: string;
    /** The username the made-up claims carry (the tier's test user; no secret). */
    username: string;
}

/** The request of a PT-03 variant; throws when the variant needs the valid token and none was given. */
export function buildVariant(variant: TokenVariant, opts: BuildOptions): VariantRequest {
    const need = (): string => {
        if (!opts.validToken) throw new Error(`variant ${variant} needs the valid token`);
        return opts.validToken;
    };
    switch (variant) {
        case 'signature':
            return { variant, authorization: `Bearer ${tamperSignature(need())}`, why: 'one signature character changed' };
        case 'payload':
            return { variant, authorization: `Bearer ${tamperPayload(need())}`, why: 'one payload character changed' };
        case 'forged-real-issuer': {
            const real = decodeJwt(need());
            return { variant, authorization: `Bearer ${signWithThrowawayKey({ kid: real.header.kid }, real.payload)}`, why: 'real claims and issuer, signed with a key the provider does not hold' };
        }
        case 'unsigned':
            return { variant, authorization: `Bearer ${unsignedToken(syntheticClaims(opts.username))}`, why: 'alg none, no signature' };
        case 'forged-unknown-issuer':
            return { variant, authorization: `Bearer ${signWithThrowawayKey({}, syntheticClaims(opts.username, UNKNOWN_ISSUER))}`, why: 'signed by a throwaway key under an issuer no provider is configured for' };
        case 'no-iss': {
            const { iss: _iss, ...claims } = syntheticClaims(opts.username);
            return { variant, authorization: `Bearer ${signWithThrowawayKey({}, claims)}`, why: 'no iss claim' };
        }
        case 'not-a-jwt':
            return { variant, authorization: 'Bearer not-a-token', why: 'not a JWT' };
        case 'empty':
            return { variant, authorization: 'Bearer ', why: 'an empty bearer value' };
        case 'wrong-scheme':
            return { variant, authorization: `Basic ${base64Url(`${opts.username}:not-a-password`)}`, why: 'the Basic scheme, which the platform does not accept' };
        case 'query-only':
            // A TAMPERED token, never the valid one: a query string lands in access logs. The oracle stays 401.
            return { variant, query: { access_token: tamperSignature(need()) }, why: 'a signature-tampered token in the query string only, no header' };
    }
}

/** True when a response body gives the token (or any long base64url run) back: a refusal must not echo credentials. */
export function echoesToken(body: string, token: string | undefined): boolean {
    if (!body) return false;
    if (token && token.length > 8 && body.includes(token.slice(0, Math.min(token.length, 24)))) return true;
    return /eyJ[A-Za-z0-9_-]{10,}/.test(body);
}
