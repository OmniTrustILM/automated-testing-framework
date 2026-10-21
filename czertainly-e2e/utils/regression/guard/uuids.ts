import { UUID_TYPED_FIELDS } from './routes';

export const UUID = '[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}';
export const IS_UUID = new RegExp(`^${UUID}$`);
/** A canonical uuid anywhere in a string (no boundaries: over-approximation, `u<uuid>` counts too). */
export const UUID_ANYWHERE = new RegExp(UUID, 'g');

// ------------------------------------------------------------------ uuid recognition

/**
 * What a server parser trims first: Java's `String.trim` (every char ≤ U+0020: control characters and space, as Spring's
 * StringToUUIDConverter and Jackson's FromStringDeserializer do) plus JavaScript whitespace (over-approximation).
 */
const TRIM = /^[\s\u0000- \u007f-\u009f]+|[\s\u0000- \u007f-\u009f]+$/g;
export const serverTrim = (s: string): string => s.replace(TRIM, '');

/** A hex digit as Java's `Character.digit(c, 16)` reads it: ASCII hex, any Unicode decimal digit, full-width a–f. */
const HEX = '[0-9a-fA-F\\p{Nd}\\uFF21-\\uFF26\\uFF41-\\uFF46]';
/** Java's lenient `UUID.fromString`: five `+`-signed groups of any length (over-approximation: no 36-character limit). */
const LENIENT = new RegExp(`^\\+?${HEX}+(?:-\\+?${HEX}+){4}$`, 'u');
/** Jackson's UUIDDeserializer: the 16 raw bytes as base64 (24 characters ending `==`), here also URL-safe and unpadded. */
const BASE64_22 = /^[A-Za-z0-9+/_-]{22}$/;
const BASE64_24 = /^[A-Za-z0-9+/_-]{22}==$/;
const URN = /^urn:uuid:/i;
/** Bounded tokens in free text (a query value, an unparseable body): not glued to letters, digits or dashes. */
const LENIENT_TOKEN = new RegExp(`(?<![0-9A-Za-z+\\-\\p{Nd}])\\+?${HEX}+(?:-\\+?${HEX}+){4}(?![0-9A-Za-z\\-\\p{Nd}])`, 'gu');
/** A 22-character base64 token, padded (`==`) or not: counted only under a uuid-typed key. */
const BASE64_TOKEN = /(?<![A-Za-z0-9+/_-])[A-Za-z0-9+/_-]{22}(?:==)?(?![A-Za-z0-9+/_=-])/g;
/** The padded 24-character form alone: counted everywhere (no enum value or name ends in `==`). */
const BASE64_24_TOKEN = /(?<![A-Za-z0-9+/_-])[A-Za-z0-9+/_-]{22}==(?![A-Za-z0-9+/_=-])/g;
const URN_TOKEN = /urn:uuid:/gi;

/**
 * A key whose string values hold uuids: the unpadded 22-character base64 form counts only under such a key, or the
 * nearest array-parent key of the value, or a query key of that shape. `userUuids`, `keyUuid`, `uuid`, `ids`, `id` — not
 * `reason`, `event`. Also every field name in guard/routes.ts UUID_TYPED_FIELDS (`triggers`,
 * `internalRules`, `groups`: request DTO fields typed UUID / List<UUID> / Set<UUID> in `interfaces`), see `isUuidField`;
 * the padded 24-character form (`…==`) counts under EVERY key and in raw text.
 */
export const UUID_FIELD_NAME = /uuid|^ids?$/i;

/** A key under which the base64 forms are uuids: UUID_FIELD_NAME-shaped or a uuid-typed DTO field. */
export const isUuidField = (key: string): boolean => UUID_FIELD_NAME.test(key) || UUID_TYPED_FIELDS.has(key);

/** True for an exact canonical uuid (8-4-4-4-12 hex, either case, nothing around it). */
export const isCanonicalUuid = (v: unknown): boolean => typeof v === 'string' && IS_UUID.test(v);

/**
 * The lower-case uuid of an EXACT canonical string, else undefined. Other forms (padded, lenient groups,
 * base64, `urn:uuid:`) are never canonicalised — `isUuidLike` finds them and the guard refuses them.
 */
export function canonicalUuid(v: unknown): string | undefined {
    return typeof v === 'string' && IS_UUID.test(v) ? v.toLowerCase() : undefined;
}

export interface UuidLikeOptions {
    /** Count the 22 / 24-character base64 forms too (default true; only under a uuid-shaped key). */
    base64?: boolean;
}

/**
 * True when a server could read `v` as a uuid (over-approximation, N3): after trimming, a canonical uuid, Java's
 * lenient groups, a `urn:uuid:` prefix, and (unless `base64: false`) a 22-character (unpadded) or 24-character (`==`)
 * base64 / base64url value.
 */
export function isUuidLike(v: unknown, opts: UuidLikeOptions = {}): boolean {
    if (typeof v !== 'string') return false;
    const t = serverTrim(v);
    if (URN.test(t) || IS_UUID.test(t) || LENIENT.test(t)) return true;
    return opts.base64 !== false && (BASE64_22.test(t) || BASE64_24.test(t));
}

/** The uuids a string names: canonical ones (to be own) and non-canonical uuid-like ones (refused). */
export interface FoundUuids {
    canonical: string[];
    nonCanonical: string[];
    /**
     * Exact canonical uuids that are the whole value of a BODY_FIELD_TYPES field (or of
     * its list) — `[uuid, ledger type or null (no ledger type: probes only), field]`.
     */
    typed?: Array<[string, string | null, string]>;
}

/** Shortened for messages (a value is never echoed in full: it may be a foreign object's id). */
const short = (s: string): string => JSON.stringify(s.length > 12 ? `${s.slice(0, 8)}…` : s);

export interface StringFindingOptions {
    /** Free text (a query value, an unparseable body): also bounded uuid-like TOKENS inside it. */
    free?: boolean;
    /**
     * The value sits under a uuid-typed key (`isUuidField`): the unpadded 22-character base64 form counts too (default
     * true). The padded 24-character form (`…==`) counts regardless.
     */
    uuidKey?: boolean;
}

/** Whether a (trimmed) value is uuid-like under the base64 rule: every form, the 22-character one only under a uuid key. */
const uuidLikeUnder = (v: string, uuidKey: boolean): boolean => isUuidLike(v, { base64: uuidKey }) || BASE64_24.test(serverTrim(v));

/**
 * One string of a body or query (`free`: also bounded uuid-like tokens inside it, for query values and unparseable
 * bodies — JSON string values are read whole by the server, so tokens inside them would only add false positives).
 */
export function findUuidsInString(s: string, opts: StringFindingOptions = {}): FoundUuids {
    const uuidKey = opts.uuidKey !== false;
    const canonical = new Set<string>();
    const nonCanonical = new Set<string>();
    if (isCanonicalUuid(s)) return { canonical: [s.toLowerCase()], nonCanonical: [] };
    if (uuidLikeUnder(s, uuidKey)) nonCanonical.add(short(s));
    if (s.includes(',')) {
        // A comma list (Spring splits request parameters, then trims each value): parts may be padded, never non-canonical.
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

/** Every canonical uuid in free text (an unparseable body, a query value), lower-case. Non-canonical ones: `findUuidsInString`. */
export function uuidTokens(text: string): string[] {
    return findUuidsInString(text, { free: true }).canonical;
}

export const merge = (into: FoundUuids, f: FoundUuids): void => {
    into.canonical.push(...f.canonical.filter((u) => !into.canonical.includes(u)));
    into.nonCanonical.push(...f.nonCanonical.filter((u) => !into.nonCanonical.includes(u)));
    if (f.typed?.length) (into.typed ??= []).push(...f.typed);
};

/** Text with JSON `\uXXXX` and `\/` escapes decoded (a raw body is scanned as written AND as a JSON reader decodes it). */
export const unescapeJson = (text: string): string =>
    text.replace(/\\u([0-9a-fA-F]{4})/g, (_m, h: string) => String.fromCharCode(parseInt(h, 16))).replace(/\\\//g, '/');

