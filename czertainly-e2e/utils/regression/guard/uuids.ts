import { UUID_TYPED_FIELDS } from './routes';

export const UUID = '[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}';
export const IS_UUID = new RegExp(`^${UUID}$`);
export const UUID_ANYWHERE = new RegExp(UUID, 'g');

/** What a server parser trims first: Java's `String.trim` (chars ≤ U+0020) plus JavaScript whitespace. */
const TRIM = /^[\s\u0000- \u007f-\u009f]+|[\s\u0000- \u007f-\u009f]+$/g;
export const serverTrim = (s: string): string => s.replace(TRIM, '');

const HEX = '[0-9a-fA-F\\p{Nd}\\uFF21-\\uFF26\\uFF41-\\uFF46]';
const LENIENT = new RegExp(`^\\+?${HEX}+(?:-\\+?${HEX}+){4}$`, 'u');
const BASE64_22 = /^[A-Za-z0-9+/_-]{22}$/;
const BASE64_24 = /^[A-Za-z0-9+/_-]{22}==$/;
const URN = /^urn:uuid:/i;
const LENIENT_TOKEN = new RegExp(`(?<![0-9A-Za-z+\\-\\p{Nd}])\\+?${HEX}+(?:-\\+?${HEX}+){4}(?![0-9A-Za-z\\-\\p{Nd}])`, 'gu');
const BASE64_TOKEN = /(?<![A-Za-z0-9+/_-])[A-Za-z0-9+/_-]{22}(?:==)?(?![A-Za-z0-9+/_=-])/g;
const BASE64_24_TOKEN = /(?<![A-Za-z0-9+/_-])[A-Za-z0-9+/_-]{22}==(?![A-Za-z0-9+/_=-])/g;
const URN_TOKEN = /urn:uuid:/gi;

/**
 * A key whose string values hold uuids (also UUID_TYPED_FIELDS): the unpadded base64 form counts only under such a key; the padded form
 * counts under every key.
 */
export const UUID_FIELD_NAME = /uuid|^ids?$/i;

export const isUuidField = (key: string): boolean => UUID_FIELD_NAME.test(key) || UUID_TYPED_FIELDS.has(key);

export const isCanonicalUuid = (v: unknown): boolean => typeof v === 'string' && IS_UUID.test(v);

/** The lower-case uuid of an exact canonical string, else undefined; other forms are never canonicalised. */
export function canonicalUuid(v: unknown): string | undefined {
    return typeof v === 'string' && IS_UUID.test(v) ? v.toLowerCase() : undefined;
}

export interface UuidLikeOptions {
    base64?: boolean;
}

/**
 * True when a server could read `v` as a uuid (over-approximation):
 * canonical, Java-lenient, `urn:uuid:`, and base64 unless `base64: false`.
 */
export function isUuidLike(v: unknown, opts: UuidLikeOptions = {}): boolean {
    if (typeof v !== 'string') return false;
    const t = serverTrim(v);
    if (URN.test(t) || IS_UUID.test(t) || LENIENT.test(t)) return true;
    return opts.base64 !== false && (BASE64_22.test(t) || BASE64_24.test(t));
}

export interface FoundUuids {
    canonical: string[];
    nonCanonical: string[];
    /** Exact canonical uuids that are the whole value of a BODY_FIELD_TYPES field: `[uuid, ledger type or null (probes only), field]`. */
    typed?: Array<[string, string | null, string]>;
}

const short = (s: string): string => JSON.stringify(s.length > 12 ? `${s.slice(0, 8)}…` : s);

export interface StringFindingOptions {
    free?: boolean;
    /** The value sits under a uuid-typed key: the unpadded 22-character base64 form counts too (default true). */
    uuidKey?: boolean;
}

const uuidLikeUnder = (v: string, uuidKey: boolean): boolean => isUuidLike(v, { base64: uuidKey }) || BASE64_24.test(serverTrim(v));

/** One string of a body or query (`free`: also bounded uuid-like tokens inside it, for query values and unparseable bodies). */
export function findUuidsInString(s: string, opts: StringFindingOptions = {}): FoundUuids {
    const uuidKey = opts.uuidKey !== false;
    const canonical = new Set<string>();
    const nonCanonical = new Set<string>();
    if (isCanonicalUuid(s)) return { canonical: [s.toLowerCase()], nonCanonical: [] };
    if (uuidLikeUnder(s, uuidKey)) nonCanonical.add(short(s));
    if (s.includes(',')) {
        for (const part of s.split(',')) {
            const t = serverTrim(part);
            if (isCanonicalUuid(t)) canonical.add(t.toLowerCase());
            else if (uuidLikeUnder(part, uuidKey)) nonCanonical.add(short(part));
        }
    }
    for (const m of s.matchAll(UUID_ANYWHERE)) canonical.add(m[0].toLowerCase());
    if (opts.free) {
        for (const re of uuidKey ? [LENIENT_TOKEN, BASE64_TOKEN] : [LENIENT_TOKEN, BASE64_24_TOKEN]) {
            for (const m of s.matchAll(re)) if (!isCanonicalUuid(m[0])) nonCanonical.add(short(m[0]));
        }
        if (s.match(URN_TOKEN)) nonCanonical.add('"urn:uuid:…"');
    }
    return { canonical: [...canonical], nonCanonical: [...nonCanonical] };
}

export function uuidTokens(text: string): string[] {
    return findUuidsInString(text, { free: true }).canonical;
}

export const merge = (into: FoundUuids, f: FoundUuids): void => {
    into.canonical.push(...f.canonical.filter((u) => !into.canonical.includes(u)));
    into.nonCanonical.push(...f.nonCanonical.filter((u) => !into.nonCanonical.includes(u)));
    if (f.typed?.length) (into.typed ??= []).push(...f.typed);
};

export const unescapeJson = (text: string): string =>
    text.replace(/\\u([0-9a-fA-F]{4})/g, (_m, h: string) => String.fromCharCode(parseInt(h, 16))).replace(/\\\//g, '/');

