/**
 * jwtTools — decode, tamper and forge bearer tokens for the authentication negatives. Pure; a forged token is signed with a
 * throwaway in-memory RSA key, so the platform can only refuse it. `TOKENLESS_VARIANTS` need no identity-provider call.
 */
import * as crypto from 'crypto';
import { base64Url } from '../text';

export interface DecodedJwt {
    header: Record<string, unknown>;
    payload: Record<string, unknown>;
    segments: [string, string, string];
}

function fromB64url(segment: string): Buffer {
    return Buffer.from(segment.replace(/-/g, '+').replace(/_/g, '/'), 'base64');
}

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

export function claimOf(token: string, name: string): unknown {
    return decodeJwt(token).payload[name];
}

const FORGED_ALG = 'RS256';

let throwaway: crypto.KeyObject | undefined;

function throwawayKey(): crypto.KeyObject {
    if (!throwaway) throwaway = crypto.generateKeyPairSync('rsa', { modulusLength: 2048 }).privateKey;
    return throwaway;
}

export function signWithThrowawayKey(header: Record<string, unknown>, payload: Record<string, unknown>): string {
    const head = base64Url(JSON.stringify({ ...header, alg: FORGED_ALG, typ: 'JWT' }));
    const body = base64Url(JSON.stringify(payload));
    const signature = crypto.sign('RSA-SHA256', Buffer.from(`${head}.${body}`), throwawayKey());
    return `${head}.${body}.${base64Url(signature)}`;
}

function otherBase64urlChar(c: string): string {
    return c === 'A' ? 'B' : 'A';
}

/**
 * The signature with ONE character changed: the FIRST one, because the last base64url character of an RS256 signature carries padding bits
 * and may decode to the same bytes.
 */
export function tamperSignature(token: string): string {
    const [head, body, sig] = decodeJwt(token).segments;
    if (!sig) throw new Error('the token has no signature to change');
    return `${head}.${body}.${otherBase64urlChar(sig[0])}${sig.slice(1)}`;
}

/**
 * The payload with ONE character of the first string claim value (longer than one character) changed; head and signature are kept, so only
 * the signature check can notice.
 */
export function tamperPayload(token: string): string {
    const { segments } = decodeJwt(token);
    const text = fromB64url(segments[1]).toString('utf8');
    const m = /:\s*"([^"\\]{2,})"/.exec(text);
    if (!m) throw new Error('the payload has no string claim to change');
    const end = m.index + m[0].length - 1;
    const last = text[end - 1];
    const changed = `${text.slice(0, end - 1)}${last === 'x' ? 'y' : 'x'}${text.slice(end)}`;
    return `${segments[0]}.${base64Url(changed)}.${segments[2]}`;
}

export function unsignedToken(payload: Record<string, unknown>): string {
    return `${base64Url(JSON.stringify({ alg: 'none', typ: 'JWT' }))}.${base64Url(JSON.stringify(payload))}.`;
}

export const UNKNOWN_ISSUER = 'https://idp.qa-reg.invalid/realms/none';

export type TokenVariant =
    | 'signature' | 'payload' | 'unsigned' | 'forged-real-issuer' | 'forged-unknown-issuer'
    | 'no-iss' | 'not-a-jwt' | 'empty' | 'wrong-scheme' | 'query-only';

export const TOKEN_VARIANTS: readonly TokenVariant[] = ['signature', 'payload', 'forged-real-issuer'];
export const TOKENLESS_VARIANTS: readonly TokenVariant[] = ['unsigned', 'forged-unknown-issuer', 'no-iss', 'not-a-jwt', 'empty', 'wrong-scheme'];
export const ANONYMOUS_VARIANTS: readonly TokenVariant[] = ['query-only'];

export interface VariantRequest {
    variant: TokenVariant;
    authorization?: string;
    query?: Record<string, string>;
    why: string;
}

export function syntheticClaims(username: string, issuer: string = UNKNOWN_ISSUER, nowSeconds: number = Math.floor(Date.now() / 1000)): Record<string, unknown> {
    return { iss: issuer, sub: crypto.randomUUID(), username, iat: nowSeconds, exp: nowSeconds + 300, jti: crypto.randomUUID() };
}

export interface BuildOptions {
    validToken?: string;
    username: string;
}

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
            // Tampered, never the valid token: a query string lands in access logs.
            return { variant, query: { access_token: tamperSignature(need()) }, why: 'a signature-tampered token in the query string only, no header' };
    }
}

export function echoesToken(body: string, token: string | undefined): boolean {
    if (!body) return false;
    if (token && token.length > 8 && body.includes(token.slice(0, Math.min(token.length, 24)))) return true;
    return /eyJ[A-Za-z0-9_-]{10,}/.test(body);
}
