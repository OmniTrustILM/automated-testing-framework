/**
 * guardedApi — the APIRequestContext of REG-* / API-* specs: it cannot change anything the run did not create (reviews
 * R7a, Q2, Q3, B0 fix passes 3, 4, 5 and 6). Specs get it as the `api` fixture (fixtures/testFixtures.ts) or from
 * `getGuardedApiContext(request, env, opts?)`; tests/unit/specGuards.spec.ts refuses a raw context for anything but a GET
 * (deny by default).
 *
 * The guard judges what is SENT, and sends what it judged (fix passes 4 and 5, round-4 N1 / N2, round-5 F1):
 * - it reads every request input ONCE into a snapshot — the URL (a string, the first argument only), the method, each
 *   allow-listed option, each header, each `params` entry, the body (serialised once: `JSON.stringify` of the value, a
 *   copy of a Buffer), and for a Request object its `url()` / `method()` / `headers()` / `postDataBuffer()` — judges the
 *   snapshot, and hands Playwright only the snapshot: the URL string, the serialised body with
 *   `content-type: application/json`, plain params and lower-cased plain headers. Getters, `toJSON`, Proxies, stateful
 *   `toString`s and Request objects are never read twice, and an option the guard does not know never reaches Playwright;
 * - Playwright resolves a URL with `new URL(url, baseURL)`, which strips tab / CR / LF anywhere, trims C0 controls and
 *   spaces, normalises dot segments and backslashes and re-encodes what it does not like: the guard refuses every URL the
 *   parser would change;
 * - a string body is sent as Playwright sends a string with `content-type: application/json`: as written when
 *   `JSON.parse` accepts it, else re-quoted as a JSON string (`JSON.stringify(text)`, e.g. a BOM or trailing junk) — and
 *   judged as exactly that; a Buffer is sent byte for byte (a malformed-JSON negative case sends a Buffer);
 * - a string or Buffer under `content-type: text/plain` (author decision after fix pass 5: 415 negatives) is sent AS
 *   WRITTEN — Playwright re-quotes a string only under exactly `application/json` (playwright-core client/fetch.js
 *   `isJsonContentType`), else it sends `Buffer.from(data, 'utf8')` — and judged as raw text (rule 4).
 *
 * Rules, per request (`get` / `head` / `post` / `put` / `patch` / `delete` / `fetch`, and `check()` without sending):
 * - Any method (the context carries the run's token or client certificate):
 *   a. the options: only `data`, `params`, `headers`, `timeout`, `failOnStatusCode`, `ignoreHTTPSErrors`,
 *      `maxRedirects`, `maxRetries` (and `method` for `fetch`; `identityOverride`, the guard's own switch, is never
 *      forwarded); `url`, `request`, `encodedParams`, `form`, `multipart`, `__testHookLookup` or any other key is refused.
 *      `params`: a string, URLSearchParams or a plain object of string / number / boolean values. The method: GET, HEAD,
 *      POST, PUT, PATCH or DELETE;
 *   b. the headers: `content-type` (`application/json`; on a protocol POST also the protocol media types; `text/plain`
 *      with no parameter but an optional `charset=utf-8`, on a non-GET request whose body is a string or Buffer and
 *      that carries no identity header — a 415 negative), `accept`, `if-*`; identity headers (`authorization`,
 *      `ssl-client-cert`, `cookie`) only with `identityOverride: true` (401 / 403 negatives); a method-override header
 *      and everything else (another charset, `text/html`, …) is refused;
 *   c. the URL as written starts with `/` (not `//`) or `<scheme>://`, holds printable ASCII only (no C0 control,
 *      space, DEL, C1 or non-ASCII character), and resolves exactly like Playwright resolves it (`new URL(url,
 *      BASE_URL)`) to http(s), without user info, on BASE_URL's ORIGIN. An absolute URL while BASE_URL is unset is refused;
 *   d. a `_method` query parameter (Spring's HiddenHttpMethodFilter) is refused, in the URL and in `params`.
 * - GET and HEAD: allowed after (a)–(d) and the shared structural path rule (`readPathProblem`, fix pass 6, round-6
 *   G1: no `//`, `.` / `..` segment, `;`, `%2f` / `%5c` / `%2e`, backslash, parser-changed path or `/API` spelling; the
 *   query string is free), without a body; a GET that persists something (apiRoutes.ts SIDE_EFFECT_GETS, matched
 *   case-sensitively: a certificate's validation or chain download, a token's status refresh, …) only on own objects of
 *   the type the route names, or probe uuids, like a mutation (a connector's health check is a plain read: author
 *   decision after fix pass 5).
 *   Redirects are followed by the guard, never by Playwright: only to BASE_URL's origin and through rules (c), the
 *   structural path rule (the `Location` as written and as resolved) and the side-effect rule; any other `Location` is
 *   not followed (the 3xx response is returned). `assertSameOrigin` (a raw GET) applies the same structural rule.
 * - TRACE and QAPROBE (SENTINEL_METHODS; B1 fix pass, author decision 1: the refused-method sentinel API-GEN-32[method],
 *   core#2502; guard-integration pass GD-11 (a): the one unknown token, API-GEN-07[unknown-method]): a bodyless READ
 *   held to the GET rules — (a)–(d), the structural path rule, BASE_URL's origin — and stricter: no body, no identity
 *   header (`identityOverride` refused too), no `text/plain`, never a redirect follow (`maxRedirects: 0` only), and a
 *   path that is a side-effect GET (SIDE_EFFECT_GETS) is refused outright, own object or not. Sent through `fetch` only.
 *   Any other method token (PROPFIND, FOO, …) stays refused.
 * - Guard-integration pass (2026-10-14, design assets/plan/guard-requests.md GD-01…GD-14 + platform / lifecycle / protocols):
 *   GD-08 `POST /v1/inspections` and GD-09 `POST /v1/certificates/import` (shape rule CREATE_BODY_SHAPES), lifecycle G1
 *   `…/certificates/register` and platform G-4 `POST /v2/connectors` are allow-listed CREATES (body judged); GD-10 a read
 *   POST may declare `application/xml`, `application/octet-stream` or `multipart/form-data; boundary=…` (READ_POST_TYPES,
 *   body as written, no identity header, no `_method` in it); GD-11 (b) the exact no-handler pairs of apiRoutes.ts
 *   NO_HANDLER_PROBES go bodyless, query-less, as the run's identity; GD-13 the exact malformed-uuid shapes of
 *   MALFORMED_UUID_PROBES skip rule 6a and the path-target rule (core answers 422 before any lookup); platform G-2 a
 *   route-scoped field waiver (ROUTE_FIELD_WAIVERS: `ruleUuid` of a provider rule on an own compliance profile);
 *   platform G-1 the `keyItems` ledger type (apiRoutes.ts TARGET_TYPES / BULK_ROUTES / LIST_BODY_TYPES); GD-03 a `users`
 *   line named REG_RESTRICTED_USERNAME is own (ownObjects.ts). REJECTED, unchanged: platform G-3 (a callback on a
 *   pre-existing connector stores attribute definitions: CallbackServiceImpl.java:274-275, :620-633), events G-3 / G-4,
 *   inventory GR-I6 (test-side alternatives in the design).
 * - Any other method, in this order (a refused request is never sent), always with `maxRedirects: 0`:
 *   1. the path: the shared structural rule of GET / HEAD (`readPathProblem`), then: the path as written must BE the
 *      effective pathname (no dot-segment normalisation, no backslash, no relative path, no stripping); every segment
 *      matches `^[A-Za-z0-9._~-]+$` (no `.` / `..`, no `%`, `;`, `+`, empty segment or trailing slash); it lies under
 *      `/api/v1|v2`. The API path, its targets and the query are taken from
 *      the EFFECTIVE URL (with `params` applied as Playwright applies them);
 *   2. POST to the read-only allow-list (lists, searches, attribute validations) or to client protocol traffic
 *      (ACME / SCEP / CMP): allowed, the body is a query or a protocol message (patterns segment-strict, fix pass 4);
 *   3. uuid-like values (fix pass 4, N3; fix pass 5, F3): a path segment, a query key / value or a body string (key or
 *      value) that a server parser could read as a uuid but that is NOT a canonical uuid is refused (kind `request`) —
 *      never canonicalised: padded (`String.trim` / Spring's converter trim first), Java's lenient `UUID.fromString`
 *      groups (`+`-signed, short or over-long, Unicode digits), a `urn:uuid:` prefix and Jackson's padded base64 form
 *      (24 characters ending `==`, also URL-safe; fix pass 6, G3) everywhere — every key, value and raw text; the
 *      unpadded 22-character form only for a value whose key (or nearest array-parent key) is uuid-typed (`isUuidKey`:
 *      UUID_KEY `/uuid|^ids?$/i` or apiRoutes.ts UUID_TYPED_FIELDS, the `UUID` / `List<UUID>` request DTO fields such as
 *      `triggers`, `internalRules`, `groups`), a string of a TOP-LEVEL array or a top-level string, and a query value
 *      whose key is uuid-typed (so enum values such as `CESSATION_OF_OPERATION` pass);
 *   4. the body, as it will be sent: a JSON body with a duplicate key (at any depth) is refused (Jackson keeps the last
 *      value, JSON.parse too, but a reader may not); a body nested deeper than MAX_BODY_DEPTH is refused; a Buffer that is
 *      not JSON is accepted on an allow-listed CREATE only, when no uuid-like token appears in it (malformed-JSON
 *      negative cases); every canonical uuid in a caller-supplied TEXT body (string or Buffer) must be own, attribute
 *      subtrees and reference fields included (pass an object to use their waivers); a `text/plain` body is never read
 *      as JSON: every canonical uuid anywhere in its raw text (as written and `\uXXXX`-decoded) must be own or a probe,
 *      a non-canonical uuid-like token in it (padded, lenient, `urn:uuid:`, base64) is refused, it may not contain NUL,
 *      and on a bulk route it is refused (the route's DTO is JSON);
 *   5. the platform deny-list (`PLATFORM_DENY`, v1 and v2, case-insensitive, `([/.]|$)`-anchored): refused unless
 *      `localStack` on a proven local stack;
 *   6. ownership, BEFORE the dry run (Q1 / Q15), lifted only by `localStack` on a proven local stack:
 *        (a) every mutation path segment is a canonical uuid or an API word (apiRoutes.ts API_WORDS): a segment that
 *            names an object by NAME (`/v1/operations/{raProfileName}/…`, an end-entity user name, an OID, a connector
 *            kind) cannot be proven own and is refused (kind `request`);
 *        (b) the uuids in the path, except a scope parent (`/authorities/{a}/raProfiles/{r}`, `/raProfiles/{r}/
 *            certificates/{c}`, `/tokens/{t}/tokenProfiles|keys/{x}`, `/entities/{e}/locations/{l}`, `/vaults/{v}/
 *            vaultProfiles/{p}`, `/acmeProfiles/{p}/acmeAccounts/{a}`): an own child may live under a foreign parent;
 *        (c) a mutation without a uuid in the path is an allow-listed CREATE (POST_CREATE) or an allow-listed BULK route
 *            (apiRoutes.ts BULK_ROUTES, round-5 F2) whose body is exactly its DTO: the uuid list (`[...]`, `uuids`,
 *            `certificateUuids`) non-empty and canonical, no other field than the DTO's (never `filters`); anything
 *            else is refused;
 *        (d) every canonical uuid in a body string — key or value, whole or inside a longer string — outside attribute
 *            subtrees (`attributes`, `customAttributes`, `*Attributes`, `metadata`); exception: a TOP-LEVEL STRING field
 *            of REFERENCE_FIELDS may name a pre-existing object on an own create / update (never on a DELETE);
 *        (e) every canonical uuid in the effective query string (comma lists split);
 *      each one must be own — a ledger `created` line of this run and a live run-prefixed name (`assertOwnLive`) — or a
 *      probe uuid. A DERIVED ledger object (a `certKey_<CN>` key, a certificate a discovery onboarded) is refused (Q5).
 *      Fix pass 6 (round-6 G2): a TARGET (b, c) must have a ledger line of exactly the type of the resource the route acts
 *      on (apiRoutes.ts `resourceTypeAt`, BULK_ROUTES `type`), for id-named and live-checked types alike, checked before
 *      the live read; a target of a resource the suite has no ledger type for (key items, signing / TSP profiles,
 *      notifications, comments, …) is refused unless it is a probe. Fix pass 6b (author decision 3): a uuid that is the
 *      whole value of a typed body field (apiRoutes.ts BODY_FIELD_TYPES: `groupUuids` → groups, `ownerUuid` → users,
 *      `triggers` → triggers, …; outside the REFERENCE_FIELDS waiver) must have a ledger line of that type, and a field
 *      of a resource without a ledger type (`proxyUuid`, `parentUuid`, compliance `groups` / `internalRules` /
 *      `ruleUuid`, `defaultSigningProfileUuid`) takes probes only; the other body associations (d, e: UNMAPPED_UUID_FIELDS,
 *      embedded uuids, map keys, query) may be any own type. Fix pass 7: `objectUuid` is typed by its sibling `resource`
 *      code (SIBLING_TYPED_FIELDS; unknown code: probes only); a top-level uuid LIST body on a route with a path target
 *      or on a create is typed by apiRoutes.ts LIST_BODY_TYPES (`PATCH /roles/{id}/users` → users, `PATCH
 *      /users/{id}/roles` → roles, the per-key item lists → probes only) and refused on any other such route (R7-1);
 *      a uuid in a body the server does not read as JSON (`text/plain`, a non-JSON Buffer) may not be backed by an
 *      id-named ledger line (N6-1: only a live-checked type proves which object it is).
 *   7. DELETE under API_TEARDOWN_DRY_RUN: DryRunRefusal.
 * - `localStack: true` (`@local` specs only, B4: platform settings, schedules, docker control) lifts rules 5 and 6 only
 *   while TIER_KIND=local in the PROCESS environment AND this run holds its unexpired local-backend proof (tier.ts
 *   `hasLocalProof`); on a shared tier the option changes nothing. Every other rule still holds.
 * - `probeUuid()`: a fresh random uuid the guard accepts as a mutation target (path, body or query), for negative cases
 *   that must answer 404 (`DELETE /roles/<probe>`). It cannot name an existing object.
 * A refusal is an OwnObjectViolation whose `kind` says why: `ownership` (not this run's object), `derived`, `request`
 * (the URL, the options, the headers, the body format, a non-canonical uuid, a platform endpoint, a name-keyed path, a
 * path-less mutation off the allow-lists) or `not-guarded` (a raw context in a mutating helper).
 *
 * Every uuid check reads the live object through the raw context (GET), so a refused request costs one read.
 * The ledger, run id, tier identity and environment the guard judges against are the process's own; unit tests inject
 * them through `guardApiForUnitTests` only (specGuards refuses that name outside tests/unit).
 *
 * Runtime companions of the lint: `requireGuarded(api)` (a mutating helper refuses a raw context, e.g. regressionApi's
 * `apiJson` for anything but a GET or a read-only POST), `assertSameOrigin(url)` (a raw authenticated GET: BASE_URL's
 * origin, never a side-effect GET) and `allowListedPost(url, opts?)` (a raw POST only to a read-only or protocol path of
 * BASE_URL's origin, judged like the guard judges a URL, no `_method`; `{ unauthenticated: true }` — the ACME client's
 * credential-less `fetch` — skips the origin rule).
 */
import type { APIRequestContext, APIResponse } from '@playwright/test';
import * as crypto from 'crypto';
import {
    API_WORDS, BODY_FIELD_TYPES, bulkRoute, BulkRoute, decodedApiPath, ledgerTypeOfResource, listBodyRoute, malformedUuidProbe, noHandlerProbe,
    resourceTypeAt, routeFieldWaivers, SIBLING_TYPED_FIELDS, sideEffectGet, UUID_TYPED_FIELDS,
} from './apiRoutes';
import { assertNotDryRun } from './flags';
import { assertOwn, assertOwnLive, isIdNamed, LiveOptions, OwnObjectViolation, RefusalKind } from './ownObjects';
import { currentRunId } from './runId';
import { hasLocalProof, isLocalTier, tierIdentity } from './tier';

type Method = 'GET' | 'HEAD' | 'POST' | 'PUT' | 'PATCH' | 'DELETE' | 'TRACE' | 'QAPROBE';
/**
 * The refused-method sentinels (B1 fix pass, author decision 1: TRACE, API-GEN-32[method], core#2502; guard-integration
 * pass GD-11 (a): QAPROBE, the one fixed token nothing maps — API-GEN-07[unknown-method]): a bodyless READ held to the
 * GET rules and stricter (no body, no identity header, no `identityOverride`, no `text/plain`, never a redirect
 * follow, no side-effect GET path), sent through `fetch` only. Exactly these two tokens: PROPFIND (a real WebDAV
 * method some proxies handle), FOO and every other token stay refused.
 */
export const SENTINEL_METHODS: ReadonlySet<string> = new Set(['TRACE', 'QAPROBE']);
// Literal lists (the qa-api-coverage generator reads these tables as string literals): METHODS = the six HTTP methods plus
// SENTINEL_METHODS; BODYLESS = GET / HEAD plus SENTINEL_METHODS (tests/unit/guardPass.spec.ts pins the three in step).
const METHODS: ReadonlySet<string> = new Set(['GET', 'HEAD', 'POST', 'PUT', 'PATCH', 'DELETE', 'TRACE', 'QAPROBE']);
/** Methods without a body that only read (B1 fix pass: the sentinels join GET / HEAD for the body and text/plain rules). */
const BODYLESS: ReadonlySet<string> = new Set(['GET', 'HEAD', 'TRACE', 'QAPROBE']);
/** The three method tables, for the unit test that keeps them in step. */
export const METHOD_TABLES = { METHODS, BODYLESS, SENTINEL_METHODS };

const UUID = '[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}';
const IS_UUID = new RegExp(`^${UUID}$`);
/** A canonical uuid anywhere in a string (no boundaries: over-approximation, `u<uuid>` counts too). */
const UUID_ANYWHERE = new RegExp(UUID, 'g');

// ------------------------------------------------------------------ uuid recognition (fix pass 4, N3; fix pass 5, F3)

/**
 * What a server parser trims first: Java's `String.trim` (every char ≤ U+0020: C0 controls and space, as Spring's
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
/** A 22-character base64 token, padded (`==`) or not: counted only under a uuid-typed key (F3). */
const BASE64_TOKEN = /(?<![A-Za-z0-9+/_-])[A-Za-z0-9+/_-]{22}(?:==)?(?![A-Za-z0-9+/_=-])/g;
/** The padded 24-character form alone: counted everywhere (fix pass 6, G3; no enum value or name ends in `==`). */
const BASE64_24_TOKEN = /(?<![A-Za-z0-9+/_-])[A-Za-z0-9+/_-]{22}==(?![A-Za-z0-9+/_=-])/g;
const URN_TOKEN = /urn:uuid:/gi;

/**
 * A key whose string values hold uuids (F3): the unpadded 22-character base64 form counts only under such a key, or the
 * nearest array-parent key of the value, or a query key of that shape. `userUuids`, `keyUuid`, `uuid`, `ids`, `id` — not
 * `reason`, `event`. Fix pass 6 (G3): also every field name in apiRoutes.ts UUID_TYPED_FIELDS (`triggers`,
 * `internalRules`, `groups`: request DTO fields typed UUID / List<UUID> / Set<UUID> in `interfaces`), see `isUuidKey`;
 * the padded 24-character form (`…==`) counts under EVERY key and in raw text.
 */
export const UUID_KEY = /uuid|^ids?$/i;

/** A key under which the base64 forms are uuids (fix pass 6, G3): UUID_KEY-shaped or a uuid-typed DTO field. */
export const isUuidKey = (key: string): boolean => UUID_KEY.test(key) || UUID_TYPED_FIELDS.has(key);

/** True for an exact canonical uuid (8-4-4-4-12 hex, either case, nothing around it). */
export const isCanonicalUuid = (v: unknown): boolean => typeof v === 'string' && IS_UUID.test(v);

/**
 * The lower-case uuid of an EXACT canonical string, else undefined. Fix pass 4: other forms (padded, lenient groups,
 * base64, `urn:uuid:`) are never canonicalised — `isUuidLike` finds them and the guard refuses them.
 */
export function canonicalUuid(v: unknown): string | undefined {
    return typeof v === 'string' && IS_UUID.test(v) ? v.toLowerCase() : undefined;
}

export interface UuidLikeOptions {
    /** Count the 22 / 24-character base64 forms too (default true; F3: only under a uuid-shaped key). */
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
export interface UuidFindings {
    canonical: string[];
    nonCanonical: string[];
    /**
     * Fix pass 6b (author decision 3): exact canonical uuids that are the whole value of a BODY_FIELD_TYPES field (or of
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
     * The value sits under a uuid-typed key (`isUuidKey`): the unpadded 22-character base64 form counts too (default
     * true; F3). The padded 24-character form (`…==`) counts regardless (fix pass 6, G3).
     */
    uuidKey?: boolean;
}

/** Whether a (trimmed) value is uuid-like under the F3 / G3 rule: every form, the 22-character one only under a uuid key. */
const uuidLikeUnder = (v: string, uuidKey: boolean): boolean => isUuidLike(v, { base64: uuidKey }) || BASE64_24.test(serverTrim(v));

/**
 * One string of a body or query (`free`: also bounded uuid-like tokens inside it, for query values and unparseable
 * bodies — JSON string values are read whole by the server, so tokens inside them would only add false positives).
 */
export function stringFindings(s: string, opts: StringFindingOptions = {}): UuidFindings {
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

/** Every canonical uuid in free text (an unparseable body, a query value), lower-case. Non-canonical ones: `stringFindings`. */
export function uuidTokens(text: string): string[] {
    return stringFindings(text, { free: true }).canonical;
}

const merge = (into: UuidFindings, f: UuidFindings): void => {
    into.canonical.push(...f.canonical.filter((u) => !into.canonical.includes(u)));
    into.nonCanonical.push(...f.nonCanonical.filter((u) => !into.nonCanonical.includes(u)));
    if (f.typed?.length) (into.typed ??= []).push(...f.typed);
};

/** Text with JSON `\uXXXX` and `\/` escapes decoded (a raw body is scanned as written AND as a JSON reader decodes it). */
const unescapeJson = (text: string): string =>
    text.replace(/\\u([0-9a-fA-F]{4})/g, (_m, h: string) => String.fromCharCode(parseInt(h, 16))).replace(/\\\//g, '/');

// ------------------------------------------------------------------ URLs as Playwright sends them (fix passes 4 and 5)

/** The base a relative URL is resolved against when BASE_URL is unset (unit tests; a real context would not send it). */
const NO_BASE = 'http://base-url-unset.invalid/';
/** Printable ASCII only: C0 controls, space, DEL, C1 and every non-ASCII character are stripped or re-encoded by the parser. */
const NOT_PRINTABLE = /[^\x21-\x7e]/;
const NOT_PRINTABLE_REASON = 'a control character, space, DEL or non-ASCII character in the URL (the URL parser strips, trims or ' +
    're-encodes it: the server would see another URL than the guard checked)';
/** The forms a URL may be WRITTEN in (fix pass 5): path-absolute `/…` (not `//`), or absolute `<scheme>://…`. */
const WRITTEN_FORM = /^(\/(?!\/)|[A-Za-z][A-Za-z0-9+.-]*:\/\/)/;
const WRITTEN_FORM_REASON = 'a URL that is neither path-absolute (/…) nor absolute (<scheme>://…): scheme-relative (//host), ' +
    '`scheme:path`, relative and query / fragment-only forms resolve to places the guard does not want to guess';
/** A path segment the guard can reason about: unreserved characters only, or a canonical uuid (which is a subset). */
const SEGMENT = /^[A-Za-z0-9._~-]+$/;
/** A segment of the POST allow-list patterns (no `.` / `..`). */
const SEG = '(?!\\.\\.?(?:/|$))[A-Za-z0-9._~-]+';

/** The path part of a URL as written: after the scheme and authority, before the query and fragment. */
function rawPathOf(url: string): string {
    const m = /^([A-Za-z][A-Za-z0-9+.-]*:)?(\/\/[^/?#]*)?([^?#]*)/.exec(url);
    return m ? m[3] : url;
}

const isAbsolute = (url: string): boolean => /^[A-Za-z][A-Za-z0-9+.-]*:/.test(url) || url.startsWith('//');

/** A URL resolved like Playwright resolves it, with the path as written. */
export interface SentUrl {
    effective: URL;
    rawPath: string;
}

export interface SentUrlOptions {
    env?: NodeJS.ProcessEnv;
    /** Skip the origin rule (a request that carries no credentials; the ACME client). Default false. */
    anyOrigin?: boolean;
}

/**
 * Rule (c) of the module header: the URL as written is `/…` or `<scheme>://…`, printable ASCII, and resolves with
 * `new URL(url, BASE_URL)` to http(s) without user info, on BASE_URL's origin. Returns the problem, or the resolved URL.
 * Messages never echo a host.
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
 * The characters and segments of one path (as written, or as sent) that let a server or proxy reach another endpoint
 * than the one the guard matched: a backslash, a `;` anywhere (Tomcat drops `;…` path parameters: `..;`, `/;x/`,
 * `approvals;x`), an encoded slash, backslash or dot (`%2f`, `%5c`, `%2e`, any case), an empty segment (`//`, which a
 * proxy with `merge_slashes` collapses) and a `.` / `..` segment. Fix pass 6 (round-6 G1).
 */
function pathCharProblem(path: string): string | undefined {
    if (path.includes('\\')) return 'a backslash in the path';
    if (path.includes(';')) return 'a semicolon (;) in the path (a path parameter the server drops: `..;`, `;x`)';
    if (/%(2f|5c|2e)/i.test(path)) return 'an encoded slash, backslash or dot (%2f, %5c, %2e) in the path';
    if (path.includes('//')) return 'an empty segment (//) in the path';
    if (path.split('/').some((s) => s === '.' || s === '..')) return 'a dot segment in the path';
    return undefined;
}

/**
 * The structural path rule SHARED by every request the guard lets through (fix pass 6, round-6 G1): GET / HEAD, each
 * followed redirect hop, `assertSameOrigin` and — as the first part of `structuralPathProblem` — every mutation and raw
 * POST. Refused: `pathCharProblem` on the path as written and as sent, a path the URL parser would change, and a path
 * whose lower-case form starts with `/api` but that does not start with exactly `/api/` (`/API/v1/…`, `/Api/…`, `/apix`:
 * the guard and Spring match the API case-sensitively; a proxy may not). Other percent-escapes and the query string stay
 * allowed on a GET (the side-effect rule matches the decoded path). `sent` must come from `resolveSentUrl`.
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
 * Rule 1 of the module header (structure of the path): why the server would see another path than the guard checks,
 * or undefined — the shared `readPathProblem`, then the mutation-only rules: no `%` at all, no empty segment or
 * trailing slash, segments `[A-Za-z0-9._~-]` only. `sent` must come from `resolveSentUrl`.
 */
function structuralPathProblem(sent: SentUrl): string | undefined {
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
 * Rule 3 for paths: a segment that is uuid-like but not canonical (padded, lenient, urn; base64 is no path form: Spring
 * converts a path variable with `UUID.fromString`), or holds a canonical uuid inside a longer segment.
 */
function uuidSegmentProblem(pathname: string): string | undefined {
    const bad = pathname.split('/').filter((s) => s && !isCanonicalUuid(s) && (isUuidLike(s, { base64: false }) || new RegExp(UUID).test(s)));
    return bad.length ? 'a non-canonical uuid segment in the path (the server would parse it as a uuid the guard does not recognise)' : undefined;
}

/**
 * Rule 6a: a mutation path segment (after `/v1|v2`) that is neither a canonical uuid nor an API word (apiRoutes.ts
 * API_WORDS) names an object by its name, which the guard cannot prove own.
 */
export function nameSegmentProblem(apiPath: string): string | undefined {
    const named = apiPath.split('/').slice(2).filter((s) => s && !IS_UUID.test(s) && !API_WORDS.has(s));
    return named.length
        ? 'a path segment that is neither a uuid nor a word of the ILM API (an object named by its name — an RA profile, a user name, ' +
            'an OID, a connector kind — cannot be proven own; apiRoutes.ts API_WORDS)'
        : undefined;
}

/** The API path (after `/api`) of an effective pathname, or undefined outside `/api/v1|v2`. */
const apiPathOfPathname = (pathname: string): string | undefined => /^\/api(\/v[12](?:\/.*)?)$/.exec(pathname)?.[1];
/** The API path a GET reaches as the server decodes it (percent-escapes, `;` content): for the side-effect rule. */
const readApiPath = (effective: URL): string | undefined => apiPathOfPathname(decodedApiPath(effective.pathname));

/**
 * Why a mutating request's URL is not a plain API path (review Q16, fix pass 4), or undefined: printable ASCII only,
 * the path as written equal to the effective one, unreserved segments, no non-canonical uuid segment. Pure (no origin
 * rule): `check` and `allowListedPost` add it.
 */
export function unsafePath(url: string): string | undefined {
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

/** The API path after `/api` (query and origin dropped, trailing slashes trimmed); undefined outside the ILM API. */
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

/**
 * Why a URL may not be sent with the run's credentials (`resolveSentUrl`: written form, printable ASCII, http(s), no
 * user info, BASE_URL's origin), or undefined; relative URLs resolve against BASE_URL like the context's baseURL.
 */
export function originProblem(url: string, env: NodeJS.ProcessEnv = process.env): string | undefined {
    const r = resolveSentUrl(url, { env });
    return 'problem' in r ? r.problem : undefined;
}

/** The keys of a query string that name a method override (Spring's HiddenHttpMethodFilter reads `_method`). */
const hasMethodParam = (search: URLSearchParams): boolean => [...search.keys()].some((k) => k.toLowerCase() === '_method');

/**
 * Throws OwnObjectViolation (kind `request`) unless `url` resolves to BASE_URL's origin (written form, printable ASCII,
 * http(s), no user info), passes the shared structural path rule (`readPathProblem`, fix pass 6) and is no side-effect
 * GET (fix pass 5: those need the guarded context's ownership check): a RAW authenticated context's GET (regressionApi
 * `apiJson`) must not carry the run's credentials elsewhere.
 */
export function assertSameOrigin(url: string, where: string, env: NodeJS.ProcessEnv = process.env): string {
    const r = resolveSentUrl(url, { env });
    if ('problem' in r) throw new OwnObjectViolation(where, {}, `${r.problem}: an authenticated context talks to BASE_URL only`, undefined, 'request');
    // Fix pass 6 (G1): the structural path rule of every guarded request (no `//`, `;`, dot segment, `%2f` / `%5c` / `%2e`,
    // backslash or `/API` spelling), so the side-effect rule below matches what the server dispatches.
    const structural = readPathProblem(r.sent);
    if (structural) throw new OwnObjectViolation(where, {}, `${structural}: a raw GET is judged like a guarded one`, undefined, 'request');
    const apiPath = readApiPath(r.sent.effective);
    if (apiPath && sideEffectGet(apiPath)) {
        throw new OwnObjectViolation(where, {}, 'a GET that persists something (apiRoutes.ts SIDE_EFFECT_GETS) goes through the guarded context, which checks ownership', undefined, 'request');
    }
    return url;
}

// ------------------------------------------------------------------ POST allow-list

/** POST paths (after /api) that CREATE an object. `{id}` = any canonical uuid (a scope parent, never checked). Body checked (Q3). */
export const POST_CREATE: readonly string[] = [
    '/v1/roles', '/v1/groups', '/v1/users', '/v1/credentials', '/v1/authorities', '/v1/authorities/{id}/raProfiles',
    '/v1/acmeProfiles', '/v1/scepProfiles', '/v1/cmpProfiles', '/v1/tokens', '/v1/tokens/{id}/tokenProfiles',
    '/v1/tokens/{id}/tokenProfiles/{id}/keys/[A-Za-z]+', '/v1/discoveries', '/v1/attributes/custom',
    '/v1/notificationInstances', '/v1/notificationProfiles',
    '/v1/workflows/(triggers|rules|conditions|actions|executions)', '/v1/entities', '/v1/entities/{id}/locations',
    '/v1/vaults', '/v1/vaults/{id}/vaultProfiles', '/v1/vaults/{id}/vaultProfiles/{id}/secrets', '/v1/complianceProfiles',
    '/v1/approvalProfiles', '/v1/connectors', '/v1/certificates/upload', '/v1/certificates/upload/async',
    '/v2/operations/authorities/{id}/raProfiles/{id}/certificates',
    // Fix pass 5 (F2): an event-trigger association of an object (`eventAssociations` ledger type): its body names the
    // object (`objectUuid`, own) and the triggers (own); without a canonical objectUuid it is platform-level (PLATFORM_DENY).
    '/v1/workflows/events',
    // Guard-integration pass (2026-10-14), one edit for four areas:
    // GD-08 (inventory GR-I1): `POST /v1/inspections` — class "body-judged, creates nothing". NOT a read: with a
    // `tokenProfileUuid` core resolves the profile and records the connector's import-capability answer on that profile
    // row (KeyTransferCapabilityService.java:139-156 → KeyTransferCapabilityWriter.java:50-64), so the field is judged
    // as a typed body field (apiRoutes BODY_FIELD_TYPES → tokenProfiles: own or a probe); without it, or with a plain
    // non-uuid string, nothing is persisted but the audit record (FileInspectionServiceImpl.java:51-53, :76-101;
    // ContainerReader.java:9-23; InspectionControllerImpl.java:27-39). A raw context may still not POST it.
    '/v1/inspections',
    // GD-09 (inventory GR-I2): `POST /v1/certificates/import`, certificate-only entries (CREATE_BODY_SHAPES): a
    // certificate entry goes through the same upload as `/v1/certificates/upload` and one already in the inventory is
    // left as it is (`EXISTING`, no write: CertificateImportServiceImpl.java:385-406); a `keyDestination` (the key
    // import, which writes into a token profile) is refused by the shape rule before anything is sent.
    '/v1/certificates/import',
    // cert-lifecycle G1: a platform-level pre-registration CREATES a certificate placeholder (core
    // ClientOperationServiceImpl.registerCertificate, service/v2/impl/ClientOperationServiceImpl.java:620-700: a new
    // REQUESTED → PENDING_REGISTRATION → REGISTERED row under the path RA profile; with a secret, a new
    // CertificateRegistrationAuthorization row, :1046-1062; nothing on a pre-existing object). Body judged like every
    // create: `sourceCertificateUuid` → certificates, `ownerUuid` → users, `groupUuids` → groups must be own.
    '/v2/operations/authorities/{id}/raProfiles/{id}/certificates/register',
    // platform G-4: the v2 ADMIN create of a connector (interfaces v2/ConnectorController.java:105; core
    // v2/ConnectorServiceImpl.java:319-322 `createNewConnector(request, CONNECTED)`): the same DTO family as
    // `/v1/connectors` (name, url, authType, attributes; `proxyUuid` stays probes-only). Approve / reconnect / connect
    // and `connector/register` stay on PLATFORM_DENY.
    '/v2/connectors',
    // platform G-2 (Sonnet review): the v2 create of a compliance profile (interfaces v2/ComplianceProfileController.java:75;
    // core service/v2/impl/ComplianceProfileServiceImpl.java:165 createComplianceProfile: a new profile row with its own
    // rule / group association rows; the referenced provider rules are read, never written). `internalRules` / `groups`
    // stay probes-only typed fields, `connectorUuid` a reference; the v1 create was allow-listed already.
    '/v2/complianceProfiles',
];

/**
 * POST paths that only READ: lists, searches, and attribute validations (review Q7: `…/attributes/validate`,
 * `…/attributes/<kind>/validate`, a connector's `/{functionGroup}/{kind}/validate`; a certificate's own
 * `/certificates/{uuid}/validate` re-runs its validation and is a mutation). `{seg}` = one unreserved segment, never
 * `.` / `..` (fix pass 4, N2).
 */
export const POST_READ: readonly string[] = [
    '/v1/certificates', '/v1/keys', '/v1/discoveries/list', '/v1/entities/list', '/v1/locations', '/v1/secrets',
    '/v1/vaults/list', '/v1/vaultProfiles/list', '/v1/auditLogs', '/v1/oids/list', '/v1/users/identify',
    '/v1/certificates/content', '/v1/workflows/events/{seg}/history', '/v1/workflows/events/{seg}/{seg}/{id}/history',
    '/v1/({seg}/)*attributes(/{seg})?/validate', '/v1/connectors/{id}/{seg}/{seg}/validate',
];

/** Client protocol traffic (ACME / SCEP / CMP endpoints): authenticated by the protocol, bodies are protocol messages. */
export const POST_PROTOCOL: readonly string[] = ['/v[12]/protocols(/{seg})+'];

/** Every allow-listed POST (creates, reads, protocol traffic). */
export const POST_ALLOWED: readonly string[] = [...POST_CREATE, ...POST_READ, ...POST_PROTOCOL];

export type PostKind = 'create' | 'read' | 'protocol';

const compile = (list: readonly string[]) => list.map((p) => new RegExp(`^${p.replace(/\{id\}/g, UUID).replace(/\{seg\}/g, SEG)}$`));
const POST_KINDS: Array<[PostKind, RegExp[]]> = [['protocol', compile(POST_PROTOCOL)], ['read', compile(POST_READ)], ['create', compile(POST_CREATE)]];

/** Which allow-listed POST an API path is, or undefined (a POST elsewhere is a mutation). */
export function postKind(apiPath: string): PostKind | undefined {
    return POST_KINDS.find(([, res]) => res.some((re) => re.test(apiPath)))?.[0];
}

export function isAllowedPost(apiPath: string): boolean {
    return postKind(apiPath) !== undefined;
}

/** A POST a RAW context may send (lint and `allowListedPost`): a read-only or protocol path; a create needs the guard. */
export function isRawPostAllowed(apiPath: string): boolean {
    const kind = postKind(apiPath);
    return kind === 'read' || kind === 'protocol';
}

// ------------------------------------------------------------------ reference fields (Q3, fix passes 3, 4 and 5)

/**
 * TOP-LEVEL body fields that may name a PRE-EXISTING object on an own create / update (never on a DELETE), decided per
 * field from the request DTOs in `interfaces` (com.otilm.api.model.*). Default deny: every other uuid must be own. The
 * value must be a canonical uuid STRING (fix pass 4: a non-canonical form is refused, never waived; fix pass 5: a list
 * or an object under the field is no reference and is scanned like any other value).
 * - connectorUuid: the provider an own authority / credential / token / entity / vault / discovery / notification
 *   instance uses (AuthorityInstanceRequestDto, CredentialRequestDto, TokenInstanceRequestDto, EntityInstanceRequestDto,
 *   VaultInstanceRequestDto, DiscoveryDto, NotificationInstanceRequestDto); the connector is only referenced, and
 *   connector registration / approval is on the platform deny-list.
 * - interfaceUuid: the connector's function-group interface (AuthorityInstanceRequestDto, DiscoveryDto,
 *   VaultInstanceRequestDto): a capability id of the connector, not an inventory object.
 * - raProfileUuid: the RA profile an own ACME / SCEP / CMP profile issues through, or an own certificate / location
 *   issue is assigned to (AcmeProfileRequestDto, AcmeProfileEditRequestDto, BaseScepProfileRequestDto,
 *   BaseCmpProfileRequestDto, CertificateUpdateObjectsDto, MultipleCertificateObjectUpdateDto, IssueToLocationRequestDto,
 *   ClientCertificateRequestDto): stored on the own object, the RA profile is not changed (issuing under any RA profile
 *   is already on the create allow-list). Side effect, accepted: while the own object exists the RA profile has a
 *   dependant (the run-end teardown removes it).
 * Removed in fix pass 4 (round-4 minor, open point until the B2 key handler exists): tokenProfileUuid /
 * altTokenProfileUuid — the platform generates the own certificate's key IN the foreign token profile, i.e. it leaves
 * a key in a foreign token that no teardown handler removes yet.
 * Deliberately NOT allowed (must be own or a probe): authorityUuid — no request DTO carries it in a body (the authority
 * is a path scope parent); keyUuid / altKeyUuid — issuing with a pre-existing key attaches it to a new certificate (its
 * associations and usage change); groupUuids / groupUuid — group membership feeds approvals (ApprovalStepRequestDto) and
 * notifications to the group's members (the suite creates its own groups, REG-CFG-06); ownerUuid / userUuid / roleUuid /
 * recipientUuids / notificationInstanceUuid / mappedUserUuid — point real people or delivery channels at run objects;
 * certificateUuid / signingCertificateUuid / caCertificateUuid / sourceCertificateUuid — bind or sign with a
 * pre-existing certificate; proxyUuid — connector routing (platform-level); rulesUuids / actionsUuids / conditionsUuids
 * / executionsUuids / triggerUuids / objectUuid — workflow wiring would make a foreign part fire on run events or keep it
 * from being deleted; uuid (ObjectPermissionsRequestDto) — a role permission on a pre-existing object.
 */
export const REFERENCE_FIELDS: Readonly<Record<string, string>> = {
    connectorUuid: 'the connector (provider) of an own object; referenced, never changed',
    interfaceUuid: 'the connector function-group interface: a capability id, not an inventory object',
    raProfileUuid: 'the RA profile an own protocol profile / certificate issues through; the RA profile is not changed',
};

// ------------------------------------------------------------------ platform deny-list (fix passes 3, 4 and 5)

/** `objectUuid` of a workflow event association: a canonical uuid string, else the association is platform-level. */
const objectLevel = (body: unknown): boolean =>
    !!body && typeof body === 'object' && !Array.isArray(body) && isCanonicalUuid((body as { objectUuid?: unknown }).objectUuid);

/** The end of a deny pattern for a SUBTREE: the next segment or a `.suffix` (Spring's suffix spellings, fix pass 5), or the end. */
const END = '(?:[/.]|$)';
const deny = (body: string): RegExp => new RegExp(`^/v[12]/${body}${END}`, 'i');
/** One endpoint (not its subtree): itself or a `.suffix` spelling of it (`purge.json`, `purge.`). */
const denyExact = (body: string): RegExp => new RegExp(`^/v[12]/${body}(?:\\.|$)`, 'i');

/**
 * Platform-level endpoints, v1 and v2, case-insensitive (fix pass 4), anchored `([/.]|$)` (fix pass 5: `purge.json`,
 * `settings.` are the same endpoint): refused for every mutating method unless `localStack` on a proven local stack
 * (B4). Read POSTs (`/v1/oids/list`, `/v1/auditLogs`) are allow-listed before this.
 */
export const PLATFORM_DENY: ReadonlyArray<{ path: RegExp; why: string; when?: (body: unknown) => boolean }> = [
    { path: deny('settings'), why: 'platform settings' },
    { path: deny('scheduler'), why: 'scheduled jobs of the platform' },
    { path: denyExact('auth/profile'), why: 'the profile of the logged-in (pre-existing) user' },
    {
        path: denyExact('workflows/events'),
        why: 'a platform-level event trigger association (no canonical objectUuid: it fires for every object)',
        when: (body) => !objectLevel(body),
    },
    { path: deny('trustedCertificates'), why: 'the platform\'s trusted certificates' },
    { path: deny('proxies'), why: 'connector proxies' },
    { path: deny('timeQualityConfigurations'), why: 'time-quality configurations' },
    { path: deny('attributes/metadata'), why: 'global metadata definitions' },
    { path: deny('cboms'), why: 'the CBOM repository (upload, delete, sync)' },
    { path: denyExact(`connectors/(?:approve|reconnect|connect|${UUID}/(?:approve|reconnect))`), why: 'connector approve / reconnect / connect' },
    { path: denyExact('connector/register'), why: 'connector registration' },
    { path: deny('branding'), why: 'platform branding' },
    { path: deny('local'), why: 'local administrator management' },
    { path: denyExact('auditLogs/purge'), why: 'the platform audit log (purge)' },
    { path: deny('oids'), why: 'the platform OID registry' },
    { path: denyExact('discoveries/schedule'), why: 'a scheduled (platform-level) discovery job' },
    // Fix pass 5 (F2): the legacy client API names RA profiles and end entities by NAME (`/v1/operations/{raProfileName}/
    // certificate/revoke`, `…/endentity/{username}`); the uuid-keyed `/v1/operations/tokens/{uuid}/…` and
    // `/v2/operations/authorities/{uuid}/…` stay (an RA profile NAMED `tokens` / `authorities` gets no further: its
    // path-less legacy routes are no create and no bulk route).
    { path: new RegExp(`^/v[12]/operations/(?!(?:tokens|authorities)/)[^/]+${END}`, 'i'), why: 'the legacy name-keyed client API (/v1/operations/{raProfileName}/…)' },
];

/** Why a mutation of `apiPath` is a platform-level change, or undefined. */
export function platformDenied(apiPath: string, body?: unknown): string | undefined {
    return PLATFORM_DENY.find((d) => d.path.test(apiPath) && (!d.when || d.when(body)))?.why;
}

// ------------------------------------------------------------------ path helpers

/** A uuid preceded by one of these and followed by a child collection plus a uuid is a scope parent. */
const SCOPE_PARENTS = new Set(['authorities', 'raProfiles', 'tokens', 'entities', 'vaults', 'acmeProfiles']);
const SCOPE_CHILDREN = new Set(['raProfiles', 'certificates', 'tokenProfiles', 'keys', 'locations', 'vaultProfiles', 'acmeAccounts']);

/** A uuid a mutation path names as its target and the ledger type of the resource there (undefined: none). */
export interface PathTarget {
    uuid: string;
    type: string | undefined;
}

/**
 * The uuids of a path that name the object(s) a mutation changes (scope parents excluded), each with the ledger type of
 * the resource the route acts on there (apiRoutes.ts `resourceTypeAt`, fix pass 6, G2).
 */
export function pathTargets(apiPath: string): PathTarget[] {
    const seg = apiPath.split('/').filter(Boolean);
    const out: PathTarget[] = [];
    seg.forEach((s, i) => {
        if (!IS_UUID.test(s)) return;
        const scopeParent = i > 0 && SCOPE_PARENTS.has(seg[i - 1]) && SCOPE_CHILDREN.has(seg[i + 1] ?? '') && IS_UUID.test(seg[i + 2] ?? '');
        if (!scopeParent) out.push({ uuid: s.toLowerCase(), type: resourceTypeAt(seg, i) });
    });
    return out;
}

/** The uuids of a path that name the object(s) a mutation changes (scope parents excluded). */
export function targetUuids(apiPath: string): string[] {
    return pathTargets(apiPath).map((t) => t.uuid);
}

// ------------------------------------------------------------------ bodies and queries (Q3, fix passes 4 and 5)

/** Body keys whose subtree is an attribute payload (definition uuids, content), never an association. */
const ATTRIBUTE_KEY = /^(attributes|customAttributes|metadata)$|Attributes$/;
const LIST_KEY = /^uuids$|Uuids$/;
/** Bodies nested deeper are refused (Jackson's own default limit is 1000; nobody needs 200). */
export const MAX_BODY_DEPTH = 200;

const isPlainObject = (v: unknown): v is Record<string, unknown> => !!v && typeof v === 'object' && !Array.isArray(v);

/** The nesting depth of a JSON value (iterative: a hostile body cannot exhaust the stack). */
export function jsonDepth(value: unknown): number {
    let max = 0;
    const stack: Array<[unknown, number]> = [[value, 0]];
    while (stack.length) {
        const [v, d] = stack.pop()!;
        if (d > max) max = d;
        if (d > MAX_BODY_DEPTH) return d;
        if (Array.isArray(v)) for (const x of v) stack.push([x, d + 1]);
        else if (isPlainObject(v)) for (const x of Object.values(v)) stack.push([x, d + 1]);
    }
    return max;
}

/**
 * The objects a bulk mutation (no uuid in the path) names explicitly, or why it does not (fix pass 4): only a
 * top-level uuid array, a top-level `uuids` list or top-level `*Uuids` lists count; every listed value must be a
 * canonical uuid; an empty `uuids` / `*Uuids` list ("all" on some endpoints) and a `filters` key anywhere are refused.
 * Fix pass 5: the guard itself uses `bulkRouteTargets` (the DTO of an allow-listed bulk route); this generic reading
 * stays for callers that only need the explicit list.
 */
export function bulkTargets(data: unknown): { uuids: string[] } | { problem: string } {
    if (hasFiltersKey(data)) return { problem: 'a bulk body with filters (never accepted: they select objects the guard cannot see)' };
    let lists: unknown[][];
    if (Array.isArray(data)) lists = [data];
    else if (isPlainObject(data)) {
        const keyed = Object.entries(data).filter(([k]) => LIST_KEY.test(k));
        if (keyed.some(([, v]) => !Array.isArray(v))) return { problem: 'a top-level uuids / *Uuids field that is not a list' };
        if (keyed.some(([, v]) => (v as unknown[]).length === 0)) return { problem: 'an empty uuids / *Uuids list (means "all" on some endpoints)' };
        lists = keyed.map(([, v]) => v as unknown[]);
    } else lists = [];
    const values = lists.flat();
    if (!values.length) return { problem: 'a mutation without a uuid in the path needs an explicit, non-empty uuid list at the top level of the body (never filters, never nested)' };
    if (!values.every((u) => isCanonicalUuid(u))) return { problem: 'a bulk list with a value that is not a canonical uuid' };
    return { uuids: [...new Set(values.map((u) => (u as string).toLowerCase()))] };
}

/** A `filters` key anywhere (any case) in a body. */
function hasFiltersKey(data: unknown): boolean {
    const stack: unknown[] = [data];
    while (stack.length) {
        const v = stack.pop();
        if (Array.isArray(v)) stack.push(...v);
        else if (isPlainObject(v)) {
            for (const [k, x] of Object.entries(v)) {
                if (k.toLowerCase() === 'filters') return true;
                stack.push(x);
            }
        }
    }
    return false;
}

/**
 * The objects the body of an allow-listed bulk route names (fix pass 5, F2), or why it does not: an `array` route takes
 * a non-empty array of canonical uuids and nothing else; a DTO route a plain object with only the DTO's fields, its list
 * field non-empty and canonical. `filters` is never a field.
 */
export function bulkRouteTargets(route: BulkRoute, data: unknown): { uuids: string[] } | { problem: string } {
    let values: unknown;
    if (route.list === 'array') {
        if (!Array.isArray(data)) return { problem: `${route.path} takes a uuid list (${route.dto}) as its body` };
        values = data;
    } else {
        if (!isPlainObject(data)) return { problem: `${route.path} takes a ${route.dto} object as its body` };
        const allowed = new Set([route.list, ...(route.fields ?? [])]);
        const extra = Object.keys(data).filter((k) => !allowed.has(k));
        if (extra.length) return { problem: `a field the ${route.dto} body does not have (${extra.slice(0, 3).map((k) => JSON.stringify(k.slice(0, 24))).join(', ')}): filters, select-all flags and unknown fields are refused` };
        values = data[route.list];
        if (!Array.isArray(values)) return { problem: `${route.list} must be a list of uuids` };
    }
    const list = values as unknown[];
    if (!list.length) return { problem: 'an empty uuid list (means "all" or nothing on some endpoints)' };
    if (!list.every((u) => isCanonicalUuid(u))) return { problem: 'a bulk list with a value that is not a canonical uuid' };
    return { uuids: [...new Set(list.map((u) => (u as string).toLowerCase()))] };
}

/** The uuids a bulk mutation names in its body, or undefined when the body does not name them explicitly (top level only). */
export function bodyUuids(data: unknown): string[] | undefined {
    const r = bulkTargets(data);
    return 'uuids' in r ? r.uuids : undefined;
}

// ------------------------------------------------------------------ create body shapes (guard-integration pass, GD-09)

/** A key named `keyDestination` in any case, anywhere (the JSON view is already `\uXXXX`-decoded). */
const KEY_DESTINATION = /^keydestination$/i;
const ENTRY_REFERENCE = /^[0-9a-f]{64}$/;
const MAX_IMPORT_ENTRIES = 250;

/** The first key anywhere in a JSON value that matches `re`, or undefined (iterative). */
function findKey(value: unknown, re: RegExp): string | undefined {
    const stack: unknown[] = [value];
    while (stack.length) {
        const v = stack.pop();
        if (Array.isArray(v)) stack.push(...v);
        else if (isPlainObject(v)) {
            for (const [k, x] of Object.entries(v)) {
                if (re.test(k)) return k;
                stack.push(x);
            }
        }
    }
    return undefined;
}

/**
 * GD-09: the body of `POST /v1/certificates/import` the guard lets through — certificate-only entries. The guard cannot
 * read the file, so the body is constrained instead: a JSON object (a non-JSON Buffer is refused on this route although
 * creates normally accept one); top-level keys ⊂ {file, entries, passphrase, customAttributes}; `file` and `passphrase`
 * strings; `entries` a non-empty array (at most 250) of objects whose ONLY key is `entryReference`, a 64-character
 * lower-case hex fingerprint; any `keyDestination` key (even null, any case, anywhere — also inside `customAttributes`)
 * refuses. Core: a certificate entry with a `keyDestination` is refused (`TAKES_NO_DESTINATION`,
 * CertificateImportServiceImpl.java:102, :202-206), a key entry without one is refused (`NEEDS_DESTINATION`, :101,
 * :208-210), a CSR entry is refused (:199-201); so a body of this shape can reach the certificate registration only
 * (:385-406, the plain upload), never the key import (KeyImportGates.java:113-129, :154-165). Only
 * `certificateOutcome: "created"` results belong in the ledger (the spec's duty).
 */
export function importBodyShapeProblem(view: BodyView): string | undefined {
    const where = 'POST /v1/certificates/import (GD-09, certificate-only entries)';
    if (view.kind !== 'json') return `${where}: the body must be a JSON object (a non-JSON Buffer or text is refused on this route)`;
    const body = view.value;
    if (!isPlainObject(body)) return `${where}: the body must be a JSON object`;
    const hidden = findKey(body, KEY_DESTINATION);
    if (hidden !== undefined) return `${where}: a "${hidden.slice(0, 24)}" key (a key import writes into a token profile and may update a pre-existing key record)`;
    const allowed = new Set(['file', 'entries', 'passphrase', 'customAttributes']);
    const extra = Object.keys(body).filter((k) => !allowed.has(k));
    if (extra.length) return `${where}: a top-level key the shape rule does not allow (${extra.slice(0, 3).map((k) => JSON.stringify(k.slice(0, 24))).join(', ')})`;
    if (typeof body.file !== 'string') return `${where}: "file" must be a string`;
    if (body.passphrase !== undefined && typeof body.passphrase !== 'string') return `${where}: "passphrase" must be a string when given`;
    const entries = body.entries;
    if (!Array.isArray(entries) || !entries.length) return `${where}: "entries" must be a non-empty array`;
    if (entries.length > MAX_IMPORT_ENTRIES) return `${where}: more than ${MAX_IMPORT_ENTRIES} entries`;
    for (const e of entries) {
        if (!isPlainObject(e)) return `${where}: every entry must be an object`;
        const keys = Object.keys(e);
        if (keys.length !== 1 || keys[0] !== 'entryReference') return `${where}: an entry may hold "entryReference" only`;
        if (typeof e.entryReference !== 'string' || !ENTRY_REFERENCE.test(e.entryReference)) return `${where}: "entryReference" must be 64 lower-case hex characters`;
    }
    return undefined;
}

const PROXY_CODE = /^proxycode$/i;

/**
 * Review F1 (Sonnet, guard pass): a connector create may name a pre-existing PROXY by its code — `proxyCode` is a plain
 * string, not a uuid, so the uuid rules never see it, yet core binds the new connector to that proxy and routes the
 * validate call through it (`service/v2/impl/ConnectorServiceImpl.java:651` → `resolveProxy`, `:958-969`
 * `proxyRepository.findByCode`). The v1 create delegates to the v2 one (`service/impl/ConnectorServiceImpl.java:133-145`).
 * So any `proxyCode` key (any case, any depth, any non-blank value) refuses on both creates; `proxyUuid` stays probes-only
 * (BODY_FIELD_TYPES). A blank / null / absent `proxyCode` names nothing (`:964` `isBlank`).
 */
export function connectorBodyShapeProblem(view: BodyView): string | undefined {
    if (view.kind !== 'json' || !isPlainObject(view.value)) return undefined;
    const stack: unknown[] = [view.value];
    while (stack.length) {
        const v = stack.pop();
        if (Array.isArray(v)) stack.push(...v);
        else if (isPlainObject(v)) {
            for (const [k, x] of Object.entries(v)) {
                if (PROXY_CODE.test(k) && !(x === null || x === undefined || (typeof x === 'string' && !x.trim()))) {
                    return `a connector create with a "${k.slice(0, 24)}" (a pre-existing proxy named by its code: core binds the new connector to it and routes through it; review F1)`;
                }
                stack.push(x);
            }
        }
    }
    return undefined;
}

/** Per-route body shape rules of allow-listed CREATES (consulted by `judge()` after the body view checks). */
export const CREATE_BODY_SHAPES: Readonly<Record<string, (view: BodyView) => string | undefined>> = {
    '/v1/certificates/import': importBodyShapeProblem,
    '/v1/connectors': connectorBodyShapeProblem,
    '/v2/connectors': connectorBodyShapeProblem,
};

export interface AssociationOptions {
    /** An own create / update: canonical STRING values of TOP-LEVEL REFERENCE_FIELDS may name pre-existing objects. */
    references?: boolean;
    /**
     * Route-scoped waivers (apiRoutes.ts ROUTE_FIELD_WAIVERS, platform G-2): TOP-LEVEL string fields whose canonical
     * uuid value may name a non-own object on this request (treated like a REFERENCE_FIELDS field: not claimed, not
     * typed; a non-canonical form is still refused; a list or nested key under the name is scanned as usual).
     */
    waive?: ReadonlySet<string>;
}

/**
 * The uuids a JSON body names (Q3, fix passes 3, 4 and 5): every string outside attribute subtrees, keys included —
 * canonical uuids (whole or inside a longer string) must be own, uuid-like non-canonical values are refused (base64 forms
 * only under a uuid-shaped key, F3; keys themselves never take a base64 form: Jackson's map-key reader for UUID is
 * `UUID.fromString`). With `references`, canonical string values of top-level REFERENCE_FIELDS are waived.
 */
export function bodyFindings(json: unknown, opts: AssociationOptions = {}): UuidFindings {
    const out: UuidFindings = { canonical: [], nonCanonical: [] };
    /**
     * `field`: the nearest key (array parents included) and `fieldType` its type: a BODY_FIELD_TYPES field (fix pass 6b)
     * or a SIBLING_TYPED_FIELDS field typed by its sibling `resource` code (fix pass 7; unknown code: null = probes only);
     * undefined = not typed. An exact canonical uuid value under a typed field becomes a typed claim.
     */
    const visit = (v: unknown, depth: number, reference: boolean, uuidKey: boolean, field?: string, fieldType?: string | null): void => {
        if (typeof v === 'string') {
            const f = stringFindings(v, { uuidKey });
            merge(out, reference ? { canonical: [], nonCanonical: f.nonCanonical } : f);
            if (!reference && field !== undefined && fieldType !== undefined && isCanonicalUuid(v)) (out.typed ??= []).push([v.toLowerCase(), fieldType, field]);
            return;
        }
        if (Array.isArray(v)) return v.forEach((x) => visit(x, depth + 1, false, uuidKey, field, fieldType));
        if (!isPlainObject(v)) return;
        for (const [k, x] of Object.entries(v)) {
            merge(out, stringFindings(k, { uuidKey: false }));
            if (ATTRIBUTE_KEY.test(k)) continue;
            const reference = depth === 0 && typeof x === 'string' && ((!!opts.references && Object.hasOwn(REFERENCE_FIELDS, k)) || !!opts.waive?.has(k));
            const type = Object.hasOwn(BODY_FIELD_TYPES, k) ? BODY_FIELD_TYPES[k]
                : Object.hasOwn(SIBLING_TYPED_FIELDS, k) ? (ledgerTypeOfResource(v[SIBLING_TYPED_FIELDS[k]]) ?? null) : undefined;
            visit(x, depth + 1, reference, isUuidKey(k), k, type);
        }
    };
    // The root: a top-level string, or a string of a top-level array (`List<UUID>` bodies), counts as uuid-keyed.
    visit(json, 0, false, true);
    return out;
}

/** The canonical uuids a body names besides its target (`bodyFindings(…).canonical`). */
export function associationUuids(data: unknown, opts: AssociationOptions = {}): string[] {
    return bodyFindings(data, opts).canonical;
}

/**
 * What the guard reads of a request body: nothing, a JSON value (`raw`: the caller's own text, when the caller sent
 * text), text that is not JSON (a Buffer), or a body it cannot read.
 */
export type BodyView =
    | { kind: 'none' }
    | { kind: 'json'; value: unknown; raw?: string }
    | { kind: 'text'; text: string }
    /** A `text/plain` body (author decision after fix pass 5): raw text, never read as JSON. */
    | { kind: 'plain'; text: string }
    | { kind: 'unreadable'; why: string };

const UTF8 = new TextDecoder('utf-8', { fatal: true });
/** For `text/plain` bodies: a leading BOM is kept (the text is judged exactly as the bytes are). */
const UTF8_KEEP_BOM = new TextDecoder('utf-8', { fatal: true, ignoreBOM: true });

/**
 * The first duplicate key of a JSON object anywhere in `text` (which JSON.parse accepted), or undefined. Iterative: a
 * stack of key sets, one per open object; a key is the decoded string before a `:`.
 */
export function jsonDuplicateKey(text: string): string | undefined {
    const stack: Array<Set<string> | undefined> = [];
    let i = 0;
    while (i < text.length) {
        const c = text[i];
        if (c === '"') {
            let j = i + 1;
            while (j < text.length && text[j] !== '"') j += text[j] === '\\' ? 2 : 1;
            const literal = text.slice(i, j + 1);
            let k = j + 1;
            while (k < text.length && /\s/.test(text[k])) k++;
            const keys = stack[stack.length - 1];
            if (text[k] === ':' && keys) {
                const key = JSON.parse(literal) as string;
                if (keys.has(key)) return key;
                keys.add(key);
            }
            i = j + 1;
            continue;
        }
        if (c === '{') stack.push(new Set());
        else if (c === '[') stack.push(undefined);
        else if (c === '}' || c === ']') stack.pop();
        i++;
    }
    return undefined;
}

/** A JSON view of caller-supplied text that JSON.parse accepts (duplicate keys: unreadable). */
function jsonTextView(text: string): BodyView {
    const dup = jsonDuplicateKey(text);
    if (dup !== undefined) return { kind: 'unreadable', why: `a JSON body with a duplicate key (${JSON.stringify(dup.slice(0, 24))}): readers disagree on which value wins` };
    return { kind: 'json', value: JSON.parse(text), raw: text };
}

const parses = (text: string): boolean => {
    try {
        JSON.parse(text);
        return true;
    } catch {
        return false;
    }
};

/** What the guard sends of a body (fix pass 5, F1): the view it judges and the exact value it hands Playwright. */
export interface BodySnapshot {
    view: BodyView;
    /** undefined: no body is sent. A string goes with `content-type: application/json` (`text/plain`: as written); a Buffer byte for byte. */
    send?: string | Buffer;
}

/**
 * The body as the guard will send it (fix pass 5, F1) and the server will read it; every input is read once:
 * - undefined: no body;
 * - a string (or String object): with `content-type: application/json`, Playwright sends it as written when
 *   `JSON.parse` accepts it (judged as that JSON; a duplicate key = unreadable), else re-quoted as a JSON string — so the
 *   guard sends `JSON.stringify(text)` itself and judges the JSON string value (a BOM, trailing junk);
 * - a Buffer: a copy, sent byte for byte; UTF-8 only (NUL bytes or invalid UTF-8 = unreadable: the server detects
 *   UTF-16 / UTF-32), a leading BOM skipped like Jackson does, whitespace only = no body; JSON (duplicate key =
 *   unreadable) or text (an allow-listed create may send it: malformed-JSON negatives);
 * - anything else Playwright serialises with `JSON.stringify` (`toJSON`, dropped functions and non-enumerables, a typed
 *   array's index object, `null` as `null`): serialised ONCE here, sent as that text and judged as its parse.
 * bigint, functions and symbols (Playwright throws) and unserialisable values are refused.
 */
export function snapshotBody(data: unknown): BodySnapshot | { problem: string } {
    if (data === undefined) return { view: { kind: 'none' } };
    if (typeof data === 'string' || data instanceof String) {
        const text = String(data);
        if (parses(text)) return { view: jsonTextView(text), send: text };
        const quoted = JSON.stringify(text);
        return { view: { kind: 'json', value: text }, send: quoted };
    }
    if (Buffer.isBuffer(data)) {
        const copy = Buffer.from(data);
        let text: string;
        try {
            text = UTF8.decode(copy);
        } catch {
            return { view: { kind: 'unreadable', why: 'a Buffer body that is not UTF-8' }, send: copy };
        }
        if (text.includes('\u0000')) return { view: { kind: 'unreadable', why: 'a body with NUL characters (UTF-16 / UTF-32, which the server detects)' }, send: copy };
        const t = text.replace(/^﻿/, '');
        if (!t.trim()) return { view: { kind: 'none' }, send: copy };
        return { view: parses(t) ? jsonTextView(t) : { kind: 'text', text: t }, send: copy };
    }
    if (typeof data === 'bigint' || typeof data === 'function' || typeof data === 'symbol') return { problem: `a ${typeof data} body (Playwright cannot send it)` };
    let text: string | undefined;
    try {
        text = JSON.stringify(data);
    } catch {
        return { problem: 'a body that JSON.stringify cannot serialise' };
    }
    if (text === undefined) return { view: { kind: 'none' } };
    return { view: { kind: 'json', value: JSON.parse(text) }, send: text };
}

/** The body as the guard judges it (`snapshotBody(data).view`; an unsendable body is `unreadable`). */
export function readBody(data: unknown): BodyView {
    const s = snapshotBody(data);
    return 'problem' in s ? { kind: 'unreadable', why: s.problem } : s.view;
}

/**
 * A `text/plain` body (author decision after fix pass 5: 415 negatives), read once and sent AS WRITTEN: Playwright
 * re-quotes a string only under exactly `application/json` (playwright-core client/fetch.js `isJsonContentType`); under
 * any other type it sends `Buffer.from(data, 'utf8')`, and a Buffer byte for byte. The view is the raw text of the bytes
 * that go out (a string's lone surrogates become U+FFFD there; a Buffer must be UTF-8; a BOM is kept); NUL characters
 * make it unreadable (a reader could take the bytes for UTF-16).
 */
export function snapshotPlainText(data: unknown): BodySnapshot | { problem: string } {
    if (Buffer.isBuffer(data)) {
        const copy = Buffer.from(data);
        let text: string;
        try {
            text = UTF8_KEEP_BOM.decode(copy);
        } catch {
            return { view: { kind: 'unreadable', why: 'a text/plain Buffer body that is not UTF-8' }, send: copy };
        }
        if (text.includes('\u0000')) return { view: { kind: 'unreadable', why: 'a text/plain body with NUL characters' }, send: copy };
        return { view: { kind: 'plain', text }, send: copy };
    }
    if (typeof data !== 'string' && !(data instanceof String)) {
        return { problem: 'text/plain with a body that is not a string or Buffer (Playwright would serialise it as JSON under a text type)' };
    }
    const written = String(data);
    const text = Buffer.from(written, 'utf8').toString('utf8');
    if (text.includes('\u0000')) return { view: { kind: 'unreadable', why: 'a text/plain body with NUL characters' }, send: written };
    return { view: { kind: 'plain', text }, send: written };
}

type Params = Record<string, string | number | boolean> | URLSearchParams | string | undefined;

/** The keys and values of the effective query string and the `params` option (decoded, as the server reads them). */
function queryEntries(search: URLSearchParams, params: Params): Array<[string, string]> {
    const out: Array<[string, string]> = [...search.entries()];
    if (typeof params === 'string') out.push(...new URLSearchParams(params).entries());
    else if (params instanceof URLSearchParams) out.push(...params.entries());
    else if (params && typeof params === 'object') {
        out.push(...Object.entries(params).filter(([, v]) => v !== undefined).map(([k, v]) => [k, String(v)] as [string, string]));
    }
    return out;
}

const searchOf = (url: string): URLSearchParams => {
    try {
        return new URL(url, NO_BASE).searchParams;
    } catch {
        return new URLSearchParams();
    }
};

/**
 * Every uuid the query string and `params` name: canonical ones (to be own) and non-canonical uuid-like ones (refused;
 * base64 forms only as the value of a uuid-shaped key, F3).
 */
export function queryFindings(url: string | URL, params?: Params): UuidFindings {
    const out: UuidFindings = { canonical: [], nonCanonical: [] };
    const search = typeof url === 'string' ? searchOf(url) : url.searchParams;
    for (const [k, v] of queryEntries(search, params)) {
        merge(out, stringFindings(k, { free: true, uuidKey: false }));
        merge(out, stringFindings(v, { free: true, uuidKey: isUuidKey(k) }));
    }
    return out;
}

/** Every canonical uuid the query string and `params` name (any key or value, comma lists included). */
export function queryUuids(url: string, params?: Params): string[] {
    return queryFindings(url, params).canonical;
}

// ------------------------------------------------------------------ options and headers (fix pass 5, F1)

/** A header that names a method (`X-HTTP-Method-Override`, `X-HTTP-Method`, `X-Method-Override`, `X-Forwarded-Method` …). */
const METHOD_HEADER = /(^|-)method(-|$)/i;
/** A content type the server reads as request parameters (Spring's FormContentFilter) or parts. */
const FORM_CONTENT = /x-www-form-urlencoded|multipart\//i;
/** Identity headers: another identity than the run's, only with `identityOverride: true` (401 / 403 negatives). */
export const IDENTITY_HEADERS: ReadonlySet<string> = new Set(['authorization', 'ssl-client-cert', 'cookie']);
/** Protocol media types a protocol POST may declare (ACME JWS, CMP, SCEP, TSP). */
const PROTOCOL_CONTENT = new Set(['application/jose+json', 'application/pkixcmp', 'application/x-pki-message', 'application/timestamp-query']);
const JSON_CONTENT = 'application/json';
/**
 * `text/plain`, with no parameter but an optional `charset=utf-8` (any case, unquoted): the content type of a 415
 * negative (author decision after fix pass 5). Group 1 is set when the charset is given. Sent normalised
 * (TEXT_CONTENT / TEXT_CONTENT_UTF8).
 */
const TEXT_PLAIN = /^text\/plain(\s*;\s*charset=utf-8)?$/i;
const TEXT_CONTENT = 'text/plain';
const TEXT_CONTENT_UTF8 = 'text/plain; charset=utf-8';
/** The normalised `text/plain` content type of a header value, or undefined when it is not one. */
const textPlainType = (value: string): string | undefined => {
    const m = TEXT_PLAIN.exec(value.trim());
    return m ? (m[1] ? TEXT_CONTENT_UTF8 : TEXT_CONTENT) : undefined;
};
/** The options the guard forwards to Playwright (plus `method` on `fetch`; `identityOverride` is the guard's own). */
export const FORWARDED_OPTIONS: readonly string[] = ['data', 'params', 'headers', 'timeout', 'failOnStatusCode', 'ignoreHTTPSErrors', 'maxRedirects', 'maxRetries'];
const OPTION_KEYS = new Set([...FORWARDED_OPTIONS, 'identityOverride']);
const REDIRECTS = new Set([301, 302, 303, 307, 308]);
/** Playwright's default redirect limit; the guard follows (same-origin) redirects of a GET / HEAD itself. */
const DEFAULT_MAX_REDIRECTS = 20;

/**
 * GD-10 (inventory GR-I3): the content types a READ POST (POST_READ: a search such as `POST /v1/certificates`) may
 * declare for a 415 negative (core#2140), besides JSON / text/plain: `application/xml`, `application/octet-stream`
 * (what an untyped client really sends: Playwright sends it for an untyped string / Buffer), and
 * `multipart/form-data; boundary=<1-70 RFC 2046 characters, no space>`. Never `application/x-www-form-urlencoded`,
 * never a type with any other parameter. Why only a read POST: Spring's FormContentFilter reads PUT / PATCH / DELETE
 * form fields as request parameters (a `_method` field could change the method), but a read POST cannot be turned into
 * a mutation by a body it does not parse — `POST /v1/certificates` takes only a JSON `@Valid @RequestBody`
 * (interfaces CertificateController.java:94-108), core declares no XML data format (`core/pom.xml`: jackson-dataformat-csv
 * only) and no `hiddenmethod` / `formcontent` / `multipart` configuration (`application.yml`), so Spring answers
 * `HttpMediaTypeNotSupportedException` before any controller, which core has no handler for (the generic `Exception`
 * handler, api/ExceptionHandlingAdvice.java:734-739: the 500 of core#2140). Group 1 of the multipart form is the boundary.
 */
const READ_POST_TYPES = /^(application\/xml|application\/octet-stream|multipart\/form-data;\s*boundary=([0-9A-Za-z'()+_,\-./:=?]{1,70}))$/i;
/** The normalised GD-10 content type of a header value, or undefined when it is not one. */
export const readPostType = (value: string): string | undefined => {
    const m = READ_POST_TYPES.exec(value.trim());
    if (!m) return undefined;
    return m[2] !== undefined ? `multipart/form-data; boundary=${m[2]}` : m[1].toLowerCase();
};
/** A `_method` anywhere in a body text (any case): a form reader could take it for a method override. */
const METHOD_IN_TEXT = /_method/i;

/** Why a header (lower-cased name) may not be sent, or undefined (rule b). */
function headerProblem(name: string, value: string, ctx: { protocol: boolean; identityOverride: boolean; readPost: boolean }): string | undefined {
    if (METHOD_HEADER.test(name)) return 'a method-override header';
    if (name === 'content-type') {
        const v = value.trim().toLowerCase();
        // GD-10: the three read-POST types, on a POST_READ route only (the body and identity conditions: the snapshot).
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

/** The request the guard judged and sends (fix pass 5, F1): every input read once, plain data only. */
interface Snapshot {
    method: Method;
    /** The URL as written (a string), first argument only. */
    url: string;
    sent: SentUrl;
    /** The query Playwright will send: the URL's, replaced by string / URLSearchParams params, appended by object params. */
    query: URLSearchParams;
    /** Forwarded params: a string (encodedParams) or a plain string map. */
    params?: string | Record<string, string>;
    /** Forwarded headers, lower-cased; content-type set to application/json for a body unless a protocol type was given. */
    headers?: Record<string, string>;
    body: BodySnapshot;
    /** timeout / failOnStatusCode / ignoreHTTPSErrors / maxRetries, as given. */
    pass: Record<string, number | boolean>;
    /** GET / HEAD: how many same-origin redirects the guard follows; others: 0. */
    maxRedirects: number;
    /** The caller asked to send an identity header of its own (never forwarded; judged: GD-11 probes refuse it). */
    identityOverride: boolean;
}

interface RequestLike {
    url(): string;
    method(): string;
    headers?(): Record<string, string>;
    postDataBuffer?(): Buffer | null;
}

const isRequestLike = (v: unknown): v is RequestLike =>
    !!v && typeof v === 'object' && !(v instanceof String) && !(v instanceof URL) && typeof (v as RequestLike).url === 'function' && typeof (v as RequestLike).method === 'function';

/** A plain object (no class instance, no Map / URLSearchParams / Headers): `{}` or `Object.create(null)`. */
const isPlainRecord = (v: unknown): v is Record<string, unknown> => {
    if (!v || typeof v !== 'object' || Array.isArray(v)) return false;
    const p = Object.getPrototypeOf(v);
    return p === Object.prototype || p === null;
};

// ------------------------------------------------------------------ the guard

export interface GuardOptions {
    /** Called right before a request is sent (an observer: tests, logging). */
    onRequest?: (method: Method, url: string) => void;
    /** `@local` specs: platform endpoints and any object on a proven local stack (TIER_KIND=local + this run's proof). */
    localStack?: boolean;
}

/**
 * Test-only seams (tests/unit): the ledger lines, run id, tier identity and environment the guard judges against.
 * Specs never pass them (specGuards refuses `guardApiForUnitTests` outside tests/unit): ownership and the tier come from
 * the process (review Q13).
 */
export interface GuardTestSeams extends LiveOptions {}

/** The request options the guard reads besides the body (fix pass 5: the forwarded options, `identityOverride`). */
export interface RequestShape {
    params?: Params;
    /** Refused (the guard reads JSON bodies only). */
    form?: unknown;
    /** Refused (the guard reads JSON bodies only). */
    multipart?: unknown;
    headers?: Record<string, string>;
    timeout?: number;
    failOnStatusCode?: boolean;
    ignoreHTTPSErrors?: boolean;
    /** GET / HEAD: the same-origin redirects the guard follows (default 20); any other method: 0 only. */
    maxRedirects?: number;
    maxRetries?: number;
    /** Allow identity headers (authorization, ssl-client-cert, cookie): a 401 / 403 negative with another identity. */
    identityOverride?: boolean;
}

export interface GuardedApi extends APIRequestContext {
    /** A fresh random uuid the guard accepts as a mutation target (negative cases answering 404). */
    probeUuid(): string;
    /** The guard's verdict without sending anything (throws when refused). `options`: as for a request (RequestShape). */
    check(method: string, url: string, data?: unknown, options?: RequestShape): Promise<void>;
}

/** The uuids a request names and, for a target, the ledger type the route acts on (undefined: a body association). */
interface Claim {
    /** The ledger type the uuid's line must have (undefined: any own type). */
    type?: string;
    /** Where the request named it, for the refusal (`the request acts on raProfiles`, `the body field groupUuids names groups`). */
    why?: string;
    /**
     * Named in a body the server does not read as JSON (`text/plain`, a non-JSON Buffer): no field or list types it, so
     * only a LIVE-checked ledger type may back it — an id-named line is refused (fix pass 7, N6-1).
     */
    free?: boolean;
}
type Claims = Map<string, Claim>;

/** Contexts made by the guard (the runtime brand `requireGuarded` checks). */
const GUARDED = new WeakSet<object>();

/** The reason `requireGuarded` gives (the live proof tells it apart from an ownership refusal). */
export const NOT_GUARDED_REASON = 'a mutating request needs the guarded API context (the `api` fixture or getGuardedApiContext), not a raw APIRequestContext';

export function isGuardedApi(api: unknown): api is GuardedApi {
    return typeof api === 'object' && api !== null && GUARDED.has(api);
}

/** The context, when the guard made it; else OwnObjectViolation (a mutating helper handed a raw context). */
export function requireGuarded(api: APIRequestContext, where: string): GuardedApi {
    if (!isGuardedApi(api)) throw new OwnObjectViolation(where, {}, NOT_GUARDED_REASON, undefined, 'not-guarded');
    return api;
}

export interface AllowListedPostOptions {
    env?: NodeJS.ProcessEnv;
    /**
     * The request carries no credentials (the ACME client's global `fetch`: its URLs come from the tier's ACME
     * directory): the origin rule is skipped; every other URL rule holds.
     */
    unauthenticated?: boolean;
}

/**
 * The URL itself when a RAW POST to it is allowed: judged like the guard judges a URL (written form, printable ASCII,
 * the path as written equal to the effective one, unreserved segments, BASE_URL's origin unless `unauthenticated`, no
 * `_method` query parameter), then a read-only or protocol path of the segment-strict allow-list; else
 * OwnObjectViolation (kind `request`).
 */
export function allowListedPost(url: string, opts: AllowListedPostOptions = {}): string {
    const r = resolveSentUrl(url, { env: opts.env, anyOrigin: opts.unauthenticated === true });
    const apiPath = 'sent' in r ? apiPathOfPathname(r.sent.effective.pathname) : undefined;
    const problem = 'problem' in r ? r.problem : (structuralPathProblem(r.sent) ??
        (hasMethodParam(r.sent.effective.searchParams) ? 'a _method query parameter (a method override)' : undefined) ??
        (apiPath && isRawPostAllowed(apiPath) ? undefined : 'not a read-only or protocol POST (a create goes through the guarded context, which checks its body)'));
    if (problem) throw new OwnObjectViolation(`allowListedPost ${apiPath ?? '(outside /api)'}`, {}, problem, undefined, 'request');
    return url;
}

/**
 * The lint's literal-URL check (tags.ts): a raw POST to `url` would be allowed by `allowListedPost` (no BASE_URL, so
 * relative URLs only).
 */
export function isAllowListedPostUrl(url: string): boolean {
    try {
        allowListedPost(url, { env: {} });
        return true;
    } catch {
        return false;
    }
}

type FetchOptions = { method?: string; data?: unknown } & RequestShape & Record<string, unknown>;

/** How the request reached the guard: a method wrapper (`get`, `post`, …), `fetch`, or `check`. */
type Entry = { kind: 'wrapper'; method: Method } | { kind: 'fetch' } | { kind: 'check'; method: string };

function createGuard(api: APIRequestContext, opts: GuardOptions, seams: GuardTestSeams): GuardedApi {
    const probes = new Set<string>();
    const env = seams.env ?? process.env;
    const onRequest = opts.onRequest;
    const localStack = opts.localStack === true;
    const runId = () => seams.runId ?? currentRunId(env);
    const liveOpts = (): LiveOptions => ({
        ...(seams.lines ? { lines: seams.lines } : {}),
        ...(seams.file ? { file: seams.file } : {}),
        runId: runId(),
        tier: seams.tier === undefined ? (tierIdentity(env) ?? null) : seams.tier,
        env,
    });

    /**
     * Rules (a)–(d) and the snapshot (F1): every input read once into plain data; throws OwnObjectViolation (kind
     * `request`) for anything the guard does not forward.
     */
    function snapshot(entry: Entry, urlOrRequest: unknown, dataArg: { given: boolean; value?: unknown }, optionsIn: unknown): Snapshot {
        let helper = 'guardedApi (outside /api)';
        const refuse = (reason: string): never => {
            throw new OwnObjectViolation(helper, {}, reason, undefined, 'request');
        };
        // The options: an allow-list of keys, each read once.
        const o: Record<string, unknown> = {};
        if (optionsIn !== undefined && optionsIn !== null) {
            if (typeof optionsIn !== 'object' || Array.isArray(optionsIn)) refuse('request options that are not an object');
            for (const key of Reflect.ownKeys(optionsIn as object)) {
                if (typeof key !== 'string') refuse('a symbol option key');
                const k = key as string;
                if (k === 'form' || k === 'multipart') refuse('a form / multipart body (the guard reads JSON bodies only)');
                const allowed = OPTION_KEYS.has(k) || (entry.kind === 'fetch' && k === 'method');
                if (!allowed) {
                    refuse(`the option "${k.slice(0, 32)}" (the guard forwards ${FORWARDED_OPTIONS.join(', ')}${entry.kind === 'fetch' ? ' and method' : ''} only; ` +
                        'the URL goes as the first argument)');
                }
                o[k] = (optionsIn as Record<string, unknown>)[k];
            }
        }
        // The URL and a Request object: read once.
        let request: RequestLike | undefined;
        let url: unknown;
        if (entry.kind === 'fetch' && typeof urlOrRequest !== 'string') {
            if (!isRequestLike(urlOrRequest)) refuse('a URL that is not a string (a String / URL object is refused; pass the string)');
            request = urlOrRequest as RequestLike;
            url = request.url();
        } else url = urlOrRequest;
        if (typeof url !== 'string') refuse('a URL that is not a string (a String / URL object is refused; pass the string)');
        // The method.
        let method: string;
        if (entry.kind === 'wrapper') method = entry.method;
        else if (entry.kind === 'check') method = String(entry.method).toUpperCase();
        else {
            const m = o.method !== undefined ? o.method : (request ? request.method() : 'GET');
            if (typeof m !== 'string') refuse('a method that is not a string');
            method = (m as string).toUpperCase();
        }
        if (!METHODS.has(method)) refuse(`the method ${JSON.stringify(method.slice(0, 16))} (GET, HEAD, POST, PUT, PATCH, DELETE and TRACE only)`);
        const M = method as Method;
        helper = `guardedApi ${M} (outside /api)`;
        // (c) the URL as sent.
        const resolved = resolveSentUrl(url, { env });
        if ('problem' in resolved) refuse(`${resolved.problem}: requests go to BASE_URL only, as written`);
        const sent = (resolved as { sent: SentUrl }).sent;
        const apiPath = apiPathOfPathname(sent.effective.pathname);
        helper = `guardedApi ${M} ${apiPath ?? '(outside /api)'}`;
        const protocol = M === 'POST' && !!apiPath && postKind(apiPath) === 'protocol';
        // GD-10: a read POST (POST_READ) may declare the three read-POST content types.
        const readPost = M === 'POST' && !!apiPath && postKind(apiPath) === 'read';
        // identityOverride
        if (o.identityOverride !== undefined && typeof o.identityOverride !== 'boolean') refuse('identityOverride must be a boolean');
        const identityOverride = o.identityOverride === true;
        // B1 fix pass (TRACE) / GD-11 (QAPROBE): a refused-method probe runs as the run's own identity, never with an identity header.
        if (SENTINEL_METHODS.has(M) && identityOverride) refuse(`identityOverride on a ${M} (a refused-method probe carries no identity header)`);
        // params: a string, URLSearchParams (read once with toString) or a plain map of primitives (each read once).
        let params: string | Record<string, string> | undefined;
        const p = o.params;
        if (p === undefined) params = undefined;
        else if (typeof p === 'string') params = p;
        else if (p instanceof URLSearchParams) params = p.toString();
        else if (isPlainRecord(p)) {
            const map: Record<string, string> = {};
            for (const key of Reflect.ownKeys(p)) {
                if (typeof key !== 'string') refuse('a symbol params key');
                const v = (p as Record<string, unknown>)[key as string];
                if (v === undefined) continue;
                if (typeof v !== 'string' && typeof v !== 'number' && typeof v !== 'boolean') refuse('a params value that is not a string, number or boolean');
                map[key as string] = String(v);
            }
            params = map;
        } else refuse('params that are not a string, URLSearchParams or a plain object');
        // The query Playwright sends: encodedParams (a non-empty string) replaces the URL's query, object params append.
        const final = new URL(sent.effective.toString());
        if (typeof params === 'string') {
            if (params) final.search = params;
        } else if (params) for (const [k, v] of Object.entries(params)) final.searchParams.append(k, v);
        // (d) a _method override, in the URL or the params.
        if (hasMethodParam(final.searchParams) || hasMethodParam(sent.effective.searchParams)) refuse('a _method query parameter (a method override)');
        // Headers: the options' (else the Request's), each read once, lower-cased, allow-listed.
        const headersIn = o.headers !== undefined ? o.headers : request?.headers?.();
        let headers: Record<string, string> | undefined;
        if (headersIn !== undefined && headersIn !== null) {
            if (!isPlainRecord(headersIn)) refuse('headers that are not a plain object');
            headers = {};
            for (const key of Reflect.ownKeys(headersIn as object)) {
                if (typeof key !== 'string') refuse('a symbol header name');
                const v = (headersIn as Record<string, unknown>)[key as string];
                if (v === undefined) continue;
                if (typeof v !== 'string') refuse('a header value that is not a string');
                const name = (key as string).toLowerCase();
                if (Object.hasOwn(headers, name)) refuse('the same header twice (in another case)');
                const why = headerProblem(name, v as string, { protocol, identityOverride, readPost });
                if (why) refuse(why);
                headers[name] = name === 'content-type' && (v as string).trim().toLowerCase() === JSON_CONTENT
                    ? JSON_CONTENT
                    : (name === 'content-type' ? (textPlainType(v as string) ?? (readPost ? readPostType(v as string) : undefined)) : undefined) ?? (v as string);
            }
        }
        // The body: the data argument, else the options' data, else the Request's postDataBuffer — read once.
        let data: unknown;
        if (dataArg.given) data = dataArg.value;
        else if (o.data !== undefined) data = o.data;
        else if (request && request.postDataBuffer) data = request.postDataBuffer() ?? undefined;
        // A protocol POST that declares its protocol media type sends a string as written (Playwright re-quotes a string
        // only under a JSON content type); its body is a protocol message, never judged.
        const declared = headers?.['content-type'];
        const protocolType = protocol && !!declared && PROTOCOL_CONTENT.has(declared.toLowerCase());
        // A 415 negative (author decision after fix pass 5): text/plain only on a non-GET request with a string / Buffer
        // body and without an identity header (even with identityOverride); the body goes as written, judged as raw text.
        const textPlain = declared !== undefined && textPlainType(declared) !== undefined;
        if (textPlain) {
            if (BODYLESS.has(M)) refuse('text/plain on a GET / HEAD / TRACE (a 415 negative is a request with a text body)');
            if (Object.keys(headers!).some((h) => IDENTITY_HEADERS.has(h))) {
                refuse('an identity header on a text/plain request (a 415 negative runs as the run\'s own identity)');
            }
        }
        // GD-10: a read-POST content type (headerProblem admitted it on a POST_READ route only): the body goes as
        // written like text/plain (Playwright sends a string raw under any non-JSON type), UTF-8, no NUL, no identity
        // header (even with identityOverride), and its text may not contain `_method` (any case).
        const readPostContent = declared !== undefined && readPost && readPostType(declared) !== undefined;
        if (readPostContent && Object.keys(headers!).some((h) => IDENTITY_HEADERS.has(h))) {
            refuse(`an identity header on a ${declared} request (a 415 negative runs as the run's own identity)`);
        }
        const body: BodySnapshot | { problem: string } = textPlain || readPostContent
            ? snapshotPlainText(data)
            : protocolType && (typeof data === 'string' || data instanceof String)
                ? { view: { kind: 'text', text: String(data) }, send: String(data) }
                : snapshotBody(data);
        if ('problem' in body) return refuse(readPostContent ? body.problem.replace(/^text\/plain/, String(declared)) : body.problem);
        if (readPostContent) {
            const v = body.view;
            if (v.kind === 'unreadable') refuse(`${v.why.replace(/^a text\/plain/, `a ${declared}`)}: the guard cannot read what the server would read`);
            if (v.kind === 'plain' && METHOD_IN_TEXT.test(v.text)) refuse(`a body containing "_method" under ${declared} (a form reader could take it for a method override)`);
        }
        if (body.send !== undefined) {
            if (BODYLESS.has(M)) refuse('a body on a GET / HEAD / TRACE');
            headers = { ...(headers ?? {}) };
            if (!protocolType && !textPlain && !readPostContent) headers['content-type'] = JSON_CONTENT;
        }
        // The other forwarded options, type-checked.
        const pass: Record<string, number | boolean> = {};
        for (const key of ['timeout', 'maxRetries']) {
            const v = o[key];
            if (v === undefined) continue;
            if (typeof v !== 'number' || !Number.isFinite(v) || v < 0 || (key === 'maxRetries' && !Number.isInteger(v))) refuse(`${key} must be a non-negative number`);
            pass[key] = v as number;
        }
        for (const key of ['failOnStatusCode', 'ignoreHTTPSErrors']) {
            const v = o[key];
            if (v === undefined) continue;
            if (typeof v !== 'boolean') refuse(`${key} must be a boolean`);
            pass[key] = v as boolean;
        }
        let maxRedirects = M === 'GET' || M === 'HEAD' ? DEFAULT_MAX_REDIRECTS : 0;
        if (o.maxRedirects !== undefined) {
            const v = o.maxRedirects;
            if (typeof v !== 'number' || !Number.isInteger(v) || v < 0) refuse('maxRedirects must be a non-negative integer');
            if (M !== 'GET' && M !== 'HEAD' && v !== 0) refuse('a mutation or a TRACE never follows a redirect (maxRedirects: 0 only)');
            maxRedirects = v as number;
        }
        return { method: M, url: url as string, sent, query: final.searchParams, params, headers, body: body as BodySnapshot, pass, maxRedirects, identityOverride };
    }

    /** Rules 1–7 on a snapshot (nothing is read from the caller any more). */
    async function judge(s: Snapshot): Promise<void> {
        const method = s.method;
        const apiPath = apiPathOfPathname(s.sent.effective.pathname);
        const helper = `guardedApi ${method} ${apiPath ?? '(outside /api)'}`;
        const refuse = (reason: string, kind: RefusalKind = 'request', ref: { uuid?: string } = {}): never => {
            throw new OwnObjectViolation(helper, ref, reason, undefined, kind);
        };
        const provenLocal = localStack && isLocalTier(env) && hasLocalProof(env);
        /**
         * Every named uuid must be own (or a probe); a TARGET must have a ledger line of exactly the resource type the
         * route acts on (fix pass 6, G2: an id-named `approvals` line cannot authorise an RA profile route), and so must a
         * uuid under a typed body field (fix pass 6b: BODY_FIELD_TYPES, `groupUuids` → groups); any other body
         * association (type undefined) may be any own object.
         */
        const assertOwnAll = async (named: Claims): Promise<void> => {
            const live = liveOpts();
            // The ledger options keep `env` (GD-03: REG_RESTRICTED_USERNAME is read through it); `tier` is set by assertOwnLive.
            const { tier: _tier, ...ledgerOpts } = live;
            for (const [uuid, claim] of named) {
                if (probes.has(uuid)) continue;
                const line = assertOwn({ uuid }, helper, ledgerOpts);
                if (line.derived) {
                    refuse('a derived object (made by the platform for the run) is removed only by the run-end teardown, after its creation-time and adoption checks', 'derived', { uuid });
                }
                if (claim.type !== undefined && line.type !== claim.type) {
                    refuse(`the ledger records it as ${line.type}, but ${claim.why} (an ownership claim counts only for the ` +
                        'resource the request acts on)', 'ownership', { uuid });
                }
                if (claim.free && isIdNamed(line.type)) {
                    refuse(`named in a body the server does not read as JSON, backed by an id-named ledger line (${line.type}: no live check, ` +
                        'so the resource it names cannot be proven)', 'ownership', { uuid });
                }
                await assertOwnLive(api, line.type, { uuid }, helper, live);
            }
        };
        /** One claim; the same uuid with two different types in one request is refused. */
        const addClaim = (claims: Claims, uuid: string, type: string | undefined, why: string): void => {
            const prior = claims.get(uuid);
            if (prior?.type !== undefined && type !== undefined && prior.type !== type) refuse('one uuid named as two different resources in one request', 'request', { uuid });
            claims.set(uuid, type !== undefined ? { ...prior, type, why } : (prior ?? {}));
        };
        /**
         * Fix pass 7 (R7-1): a top-level uuid list body on a route with a path target or on a create is typed by
         * LIST_BODY_TYPES (own with that ledger type, or a probe; null: probes only); on any other such route a
         * non-probe uuid in it is refused. Bulk routes (no path target) are typed by BULK_ROUTES instead.
         */
        const claimList = (claims: Claims, list: unknown[]): void => {
            const route = listBodyRoute(method, apiPath!);
            // B0 micro-pass (R8-1): a LIST_BODY_TYPES body is `List<String>`; a nested list, an object, a number or null
            // would escape the type check (it falls back to any own type), so it is refused like bulkRouteTargets does.
            if (route && list.some((e) => typeof e !== 'string')) {
                refuse(`the list body of ${route.path} holds an element that is not a string (its body is ${route.dto.split(' ')[0]})`, 'request');
            }
            const named = [...new Set(list.filter(isCanonicalUuid).map((u) => (u as string).toLowerCase()))].filter((u) => !probes.has(u));
            if (!named.length) return;
            if (!route) {
                refuse('a top-level uuid list body on a route without a typed list (apiRoutes.ts LIST_BODY_TYPES): the guard cannot tell which ' +
                    'resource it names', 'request', { uuid: named[0] });
            }
            if (route!.type === null) {
                refuse(`the list body of ${route!.path} names a resource the suite has no ledger type for (apiRoutes.ts LIST_BODY_TYPES): probes only`, 'request', { uuid: named[0] });
            }
            for (const uuid of named) addClaim(claims, uuid, route!.type as string, `the list body of ${route!.path} names ${route!.type}`);
        };
        /** Adds the targets to the claims: a non-probe target of a resource without a ledger type, or one uuid as two types, is refused. */
        const claimTargets = (claims: Claims, targets: PathTarget[], what: string): void => {
            for (const t of targets) {
                if (t.type === undefined && !probes.has(t.uuid)) {
                    refuse(`${what} on a resource the suite has no ledger type for (apiRoutes.ts TARGET_TYPES / BULK_ROUTES): ownership cannot be ` +
                        'matched to the resource the request acts on', 'request', { uuid: t.uuid });
                }
                addClaim(claims, t.uuid, t.type, `the request acts on ${t.type}`);
            }
        };
        /** Fix pass 6b: the typed body fields (BODY_FIELD_TYPES); a field of a resource without a ledger type takes probes only. */
        const claimFields = (claims: Claims, typed: Array<[string, string | null, string]>): void => {
            for (const [uuid, type, field] of typed) {
                if (probes.has(uuid)) continue;
                if (type === null) {
                    refuse(`the body field ${field} names a resource the suite has no ledger type for (apiRoutes.ts BODY_FIELD_TYPES): probes only`, 'request', { uuid });
                }
                addClaim(claims, uuid, type as string, `the body field ${field} names ${type}`);
            }
        };
        if (SENTINEL_METHODS.has(method)) {
            // B1 fix pass (author decision 1) / GD-11 (a): a bodyless read held to the GET path rules; a side-effect GET
            // path is refused outright (a server that dispatched the method like GET must never persist anything), own
            // object or not.
            const structural = readPathProblem(s.sent);
            if (structural) refuse(`${structural}: the guard checks plain paths only (${method} too)`);
            const readPath = readApiPath(s.sent.effective);
            if (readPath && sideEffectGet(readPath)) refuse(`a ${method} on a path that persists something for a GET (apiRoutes.ts SIDE_EFFECT_GETS)`);
            return;
        }
        if (method === 'GET' || method === 'HEAD') {
            // Fix pass 6 (G1): the shared structural path rule first, so the side-effect rule matches what the server dispatches.
            const structural = readPathProblem(s.sent);
            if (structural) refuse(`${structural}: the guard checks plain paths only (GET / HEAD too)`);
            // A GET that persists something (apiRoutes.ts SIDE_EFFECT_GETS): like a mutation, only on own objects (fix pass 5).
            const readPath = readApiPath(s.sent.effective);
            const effect = readPath ? sideEffectGet(readPath) : undefined;
            if (effect && !provenLocal) {
                if (!effect.ids.length) refuse('a GET that persists something (apiRoutes.ts SIDE_EFFECT_GETS), without an object of the run in its path');
                if (![...effect.ids, ...effect.parents].every(isCanonicalUuid)) refuse('a GET that persists something, with a path segment that is not a canonical uuid');
                const claims: Claims = new Map();
                claimTargets(claims, effect.ids.map((u, i) => ({ uuid: u.toLowerCase(), type: effect.types[i] })), 'a GET that persists something');
                await assertOwnAll(claims);
            }
            return;
        }
        // 1. the path, as written = as sent
        const structural = structuralPathProblem(s.sent);
        if (structural) refuse(`${structural}: the guard checks plain paths only`);
        if (!apiPath) refuse('a mutating request outside the ILM API is not allowed through the guarded context');
        // 2. read-only and protocol POSTs
        const kind = method === 'POST' ? postKind(apiPath!) : undefined;
        if (kind === 'read' || kind === 'protocol') return;
        // 2b. GD-11 (b): an exact (method, path) pair that reaches no handler (apiRoutes.ts NO_HANDLER_PROBES), sent
        // bodyless, without a query, as the run's own identity: Spring answers 400 before any controller.
        if (noHandlerProbe(method, apiPath!)) {
            if (s.body.view.kind !== 'none') refuse(`a body on the no-handler probe ${method} ${apiPath} (apiRoutes.ts NO_HANDLER_PROBES: bodyless only)`);
            if (s.query.toString()) refuse(`a query on the no-handler probe ${method} ${apiPath} (apiRoutes.ts NO_HANDLER_PROBES: no query)`);
            if (s.identityOverride || Object.keys(s.headers ?? {}).some((h) => IDENTITY_HEADERS.has(h))) {
                refuse(`an identity header or identityOverride on the no-handler probe ${method} ${apiPath} (it runs as the run's own identity)`);
            }
            if (method === 'DELETE') assertNotDryRun(helper, env);
            return;
        }
        // 3. uuid-like path segments
        const segmentProblem = uuidSegmentProblem(s.sent.effective.pathname);
        if (segmentProblem) refuse(segmentProblem);
        // 4. the body, as it will be sent
        const view = s.body.view;
        if (view.kind === 'unreadable') refuse(`${view.why}: the guard cannot read what the server would read`);
        if (view.kind === 'text' && kind !== 'create') refuse('a Buffer body that is not JSON (the server could read what the guard cannot)');
        // 4b. GD-09: the per-route shape rule of a create (`/v1/certificates/import`: certificate-only entries).
        const shape = kind === 'create' && Object.hasOwn(CREATE_BODY_SHAPES, apiPath!) ? CREATE_BODY_SHAPES[apiPath!](view) : undefined;
        if (shape) refuse(shape);
        const json = view.kind === 'json' ? view.value : undefined;
        if (view.kind === 'json' && jsonDepth(json) > MAX_BODY_DEPTH) refuse(`a body nested deeper than ${MAX_BODY_DEPTH} levels`);
        const references = method !== 'DELETE';
        const findings: UuidFindings = { canonical: [], nonCanonical: [] };
        // Text the server does not read as JSON (a non-JSON Buffer on a create; a text/plain body): free text, as written
        // and as a JSON reader would decode it — every canonical uuid in it must be own, any other uuid-like token is refused.
        if (view.kind === 'text' || view.kind === 'plain') {
            merge(findings, stringFindings(view.text, { free: true }));
            merge(findings, stringFindings(unescapeJson(view.text), { free: true }));
        } else {
            // Platform G-2: a route-scoped top-level field waiver (apiRoutes.ts ROUTE_FIELD_WAIVERS), like REFERENCE_FIELDS.
            merge(findings, bodyFindings(json, { references, waive: routeFieldWaivers(method, apiPath!, json) }));
            // Caller-supplied text: every canonical uuid in it, as written and as decoded, must be own (no waivers).
            if (view.kind === 'json' && view.raw !== undefined) {
                for (const t of [view.raw, unescapeJson(view.raw)]) for (const m of t.matchAll(UUID_ANYWHERE)) merge(findings, { canonical: [m[0].toLowerCase()], nonCanonical: [] });
            }
        }
        merge(findings, queryFindings(s.query.toString() ? new URL(`${NO_BASE}?${s.query.toString()}`) : new URL(NO_BASE)));
        if (findings.nonCanonical.length) {
            refuse(`a non-canonical uuid form in the body or query (${findings.nonCanonical.slice(0, 3).join(', ')}): the server may parse it as a uuid; send the canonical form`);
        }
        // 5. platform endpoints, 6. ownership — lifted only by localStack on a proven local stack
        const platform = platformDenied(apiPath!, json);
        if (platform && !provenLocal) refuse(`${platform} is platform-level: @local rows with localStack on a proven local stack only`);
        if (!provenLocal) {
            // GD-13: an exact (method, template, literal) of apiRoutes.ts MALFORMED_UUID_PROBES (`PUT|DELETE /v1/groups|
            // credentials/not-a-uuid`): core answers 422 from SecuredUUID.fromString before any lookup; the literal is not
            // uuid-like (rule 3 ran) and names nothing, so rule 6a and the path-target rule are skipped for it — the body
            // still passes every body rule below.
            const malformed = malformedUuidProbe(method, apiPath!);
            const named = malformed ? undefined : nameSegmentProblem(apiPath!);
            if (named) refuse(named);
            // Body associations first (any own type; a typed body field its type, fix pass 6b), then the targets with the type
            // of the resource (fix pass 6, G2).
            const free = view.kind === 'text' || view.kind === 'plain';
            const claims: Claims = new Map(findings.canonical.map((u) => [u, free ? { free } : {}]));
            claimFields(claims, findings.typed ?? []);
            // A top-level list body: typed by LIST_BODY_TYPES unless it is a bulk route's (no path target, not a create).
            if (Array.isArray(json) && (kind === 'create' || pathTargets(apiPath!).length > 0)) claimList(claims, json);
            if (kind !== 'create') {
                let targets = pathTargets(apiPath!);
                if (!targets.length && !malformed) {
                    const route = bulkRoute(method, apiPath!);
                    if (!route) {
                        refuse('a mutation without a uuid in the path that is neither an allow-listed create (POST_CREATE) nor an allow-listed bulk route ' +
                            '(apiRoutes.ts BULK_ROUTES)');
                    }
                    if (view.kind === 'plain') refuse(`a text/plain body on the bulk route ${route!.path} (its ${route!.dto} body is JSON: the guard cannot read the uuid list from text)`);
                    const bulk = hasFiltersKey(json) ? { problem: 'a bulk body with filters (never accepted: they select objects the guard cannot see)' } : bulkRouteTargets(route!, json);
                    if ('problem' in bulk) refuse(bulk.problem);
                    targets = (bulk as { uuids: string[] }).uuids.map((uuid) => ({ uuid, type: route!.type }));
                }
                claimTargets(claims, targets, `a mutation of ${method} ${apiPath}`.slice(0, 120));
            }
            await assertOwnAll(claims);
        }
        // 7. the dry run, after ownership (Q1 / Q15)
        if (method === 'DELETE') assertNotDryRun(helper, env);
    }

    /** The Playwright options of a snapshot: plain data only, `maxRedirects: 0` (the guard follows redirects itself). */
    const forward = (s: Snapshot): Record<string, unknown> => ({
        ...(s.params !== undefined ? { params: s.params } : {}),
        ...(s.headers !== undefined ? { headers: s.headers } : {}),
        ...(s.body.send !== undefined ? { data: s.body.send } : {}),
        ...s.pass,
        maxRedirects: 0,
    });

    /** Send a judged snapshot; a GET / HEAD follows same-origin redirects through the URL and side-effect rules. */
    async function transmit(s: Snapshot): Promise<APIResponse> {
        onRequest?.(s.method, s.url);
        if (s.method !== 'GET' && s.method !== 'HEAD') return api.fetch(s.url, { ...forward(s), method: s.method } as Parameters<APIRequestContext['fetch']>[1]);
        const read = (u: string, o: Record<string, unknown>) =>
            s.method === 'GET' ? api.get(u, o as Parameters<APIRequestContext['get']>[1]) : api.head(u, o as Parameters<APIRequestContext['head']>[1]);
        let res = await read(s.url, forward(s));
        let current = new URL(s.sent.effective.toString());
        current.search = s.query.toString();
        for (let hop = 0; hop < s.maxRedirects; hop++) {
            if (typeof res?.status !== 'function' || !REDIRECTS.has(res.status())) break;
            const location = res.headers()['location'];
            if (!location) break;
            let next: URL;
            try {
                next = new URL(location, current);
            } catch {
                break;
            }
            const r = resolveSentUrl(next.toString(), { env });
            if ('problem' in r) break; // another origin, user info, not http(s): not followed, the 3xx is returned
            // Fix pass 6 (G1): the hop's path as the Location writes it and as it will be sent, by the shared structural rule.
            if (pathCharProblem(rawPathOf(location)) || readPathProblem(r.sent)) break;
            const nextPath = readApiPath(r.sent.effective);
            if (nextPath && sideEffectGet(nextPath)) break;
            if (hasMethodParam(r.sent.effective.searchParams)) break;
            current = next;
            onRequest?.(s.method, next.toString());
            res = await read(next.toString(), { ...(s.headers !== undefined ? { headers: s.headers } : {}), ...s.pass, maxRedirects: 0 });
        }
        return res;
    }

    async function check(method: string, url: string, data?: unknown, options: RequestShape = {}): Promise<void> {
        await judge(snapshot({ kind: 'check', method }, url, { given: true, value: data }, options));
    }

    const wrapper = (method: Method) => async (url: string, options?: FetchOptions): Promise<APIResponse> => {
        const s = snapshot({ kind: 'wrapper', method }, url, { given: false }, options);
        await judge(s);
        return transmit(s);
    };

    const guarded = {
        get: wrapper('GET'),
        head: wrapper('HEAD'),
        post: wrapper('POST'),
        put: wrapper('PUT'),
        patch: wrapper('PATCH'),
        delete: wrapper('DELETE'),
        fetch: async (urlOrRequest: string | RequestLike, options?: FetchOptions): Promise<APIResponse> => {
            const s = snapshot({ kind: 'fetch' }, urlOrRequest, { given: false }, options);
            await judge(s);
            return transmit(s);
        },
        dispose: async (options?: { reason?: string }) => api.dispose(options),
        storageState: (options?: Parameters<APIRequestContext['storageState']>[0]) => api.storageState(options),
        probeUuid: () => {
            const u = crypto.randomUUID();
            probes.add(u);
            return u;
        },
        check,
    };
    GUARDED.add(guarded);
    return guarded as unknown as GuardedApi;
}

/**
 * Wrap an authenticated context; dispose the guarded one (it disposes the wrapped context). Only `localStack` and
 * `onRequest` are read from `opts`: the ledger, run id, tier and environment are always the process's own (Q13).
 */
export function guardApi(api: APIRequestContext, opts: GuardOptions = {}): GuardedApi {
    return createGuard(api, { onRequest: opts.onRequest, localStack: opts.localStack }, {});
}

/** Unit tests only: the guard judging against injected ledger lines, run id, tier and environment. */
export function guardApiForUnitTests(api: APIRequestContext, opts: GuardOptions & GuardTestSeams = {}): GuardedApi {
    const { onRequest, localStack, ...seams } = opts;
    return createGuard(api, { onRequest, localStack }, seams);
}

/**
 * `getAuthenticatedApiContext` wrapped in the guard: the API context of REG-* / API-* specs that do not use the `api`
 * fixture. Signature stable: `getGuardedApiContext(request, env, opts?)`. Dispose it in finally.
 */
export async function getGuardedApiContext(request: APIRequestContext, env: import('../env').TestEnv, opts: GuardOptions = {}): Promise<GuardedApi> {
    // Loaded lazily: unit tests import this module without an environment.
    const { getAuthenticatedApiContext } = require('../../fixtures/testFixtures') as typeof import('../../fixtures/testFixtures');
    return guardApi(await getAuthenticatedApiContext(request, env), opts);
}
