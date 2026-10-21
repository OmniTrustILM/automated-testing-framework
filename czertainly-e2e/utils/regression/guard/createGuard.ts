/**
 * The guard: it wraps an APIRequestContext so that nothing the run did not create can be changed. A refusal is an
 * OwnObjectViolation whose `kind` says why: `ownership` (not this run's object), `derived` (an object the platform
 * made for a run object, e.g. a key or an onboarded certificate), `request` (the URL, options, headers, body format, a
 * non-canonical uuid, a platform endpoint, a name-keyed path, a path-less mutation off the allow-lists) or
 * `not-guarded` (a raw context in a mutating helper).
 *
 * The guard judges what is SENT, and sends what it judged. It reads every request input once into a snapshot (the URL
 * string, the method, each allowed option, each header, each `params` entry, the body serialised once), judges the
 * snapshot and hands Playwright only the snapshot. Getters, `toJSON`, Proxies, stateful `toString`s and Request objects
 * are never read twice, and an option the guard does not know never reaches Playwright. A string body is sent as
 * Playwright sends it under `application/json` (as written when it parses as JSON, else re-quoted) and judged as
 * exactly that; a Buffer is sent byte for byte; a string or Buffer under `text/plain` is sent as written and judged as
 * raw text.
 *
 * Rules for every method:
 *   a. Options: only `data`, `params`, `headers`, `timeout`, `failOnStatusCode`, `ignoreHTTPSErrors`, `maxRedirects`,
 *      `maxRetries` (and `method` for `fetch`; `identityOverride` is the guard's own switch and is never forwarded).
 *   b. Headers: `content-type` (`application/json`; protocol media types on a protocol POST; `text/plain` with an
 *      optional `charset=utf-8` on a non-GET with a string or Buffer body and no identity header; the read-POST types of
 *      headers.ts), `accept`, `if-*`. Identity headers only with `identityOverride: true` (401 / 403 negatives). A
 *      method-override header and everything else is refused.
 *   c. URL: written as `/...` or `<scheme>://`, printable ASCII only, resolving exactly like Playwright's
 *      `new URL(url, BASE_URL)` to http(s) without user info on BASE_URL's origin.
 *   d. A `_method` query parameter is refused, in the URL and in `params`.
 * GET and HEAD pass a, b, c, d and the structural path rule (urls.ts `readPathProblem`: no `//`, dot segment, `;`,
 * `%2f` / `%5c` / `%2e`, backslash, parser-changed path or `/API` spelling), carry no body, and a GET that persists
 * something (guard/routes.ts SIDE_EFFECT_GETS) is allowed only on own objects of the type the route names or on probe
 * uuids. Redirects are followed by the guard, only to BASE_URL's origin and through the same rules.
 * TRACE and QAPROBE (PROBE_METHODS, the refused-method probes) are bodyless reads held to the GET rules and
 * stricter: no identity header, no `text/plain`, never a redirect follow, never a side-effect GET path. Sent through
 * `fetch` only. Any other method token stays refused.
 * Every other method, in this order (a refused request is never sent; `maxRedirects` is always 0):
 *   1. Path: the structural rule, the path as written equals the effective pathname, every segment matches
 *      `^[A-Za-z0-9._~-]+$`, and the path lies under `/api/v1|v2`.
 *   2. A POST to the read-only allow-list (lists, searches, validations) or to client protocol traffic (ACME / SCEP /
 *      CMP) is allowed; the body is a query or a protocol message.
 *   3. Uuid-like values: a path segment, query key / value or body string that a server parser could read as a uuid but
 *      is not canonical is refused, never canonicalised (padded, Java-lenient groups, `urn:uuid:`, padded base64; the
 *      unpadded 22-character form only under a uuid-typed key; see uuids.ts).
 *   4. The body as it will be sent: a duplicate JSON key at any depth, nesting deeper than MAX_BODY_DEPTH, a non-JSON
 *      Buffer outside an allow-listed create, a `text/plain` body with NUL, or on a bulk route, is refused; every
 *      canonical uuid in a text body must be own or a probe.
 *   5. The platform deny-list (allowLists.ts `PLATFORM_DENY`) is refused unless `localStack` on a proven local stack.
 *   6. Ownership, before the dry run and lifted only by `localStack` on a proven local stack:
 *        (a) every path segment is a canonical uuid or an API word (a name-keyed path cannot be proven own);
 *        (b) uuids in the path must be own, except a scope parent (an own child may live under a foreign parent);
 *        (c) a mutation without a uuid in the path is an allow-listed create or an allow-listed bulk route whose body is
 *            exactly its DTO (a non-empty canonical uuid list, no other field);
 *        (d) every canonical uuid in a body string outside attribute subtrees must be own; a top-level string field of
 *            REFERENCE_FIELDS may name a pre-existing object on an own create or update, never on a DELETE;
 *        (e) every canonical uuid in the effective query string must be own.
 *      "Own" means a ledger `created` line of this run and a live run-prefixed name (`assertOwnLive`), or a probe uuid.
 *      A derived ledger object is refused. A target must have a ledger line of exactly the type of the resource the
 *      route acts on; a uuid that is the whole value of a typed body field must have a ledger line of that type.
 *   7. DELETE under API_TEARDOWN_DRY_RUN throws DryRunRefusal.
 * Approvals and saved views, on top of rules 4–6:
 *   - saved views (savedViews.ts): `POST /v1/listViews` is a create and `PUT /v1/listViews/{own}` an update of exactly
 *     the saved-view body shape (run-prefixed name, no foreign key); `defaultView: true` only while no other default
 *     view of that user and resource is a pre-existing one (read live; shared tiers);
 *   - approvals (approvals.ts): an approval profile step may name the caller's own user (`GET /v1/auth/profile`) on an own
 *     profile write; an approval named in a path may only be decided (four PATCH routes) as the run's own user, and
 *     only when its ledger line names an own certificate and an own approval profile that its live detail confirms.
 * `localStack: true` (`@local` specs only) lifts rules 5 and 6 only while TIER_KIND=local in the process environment and
 * this run holds its unexpired local-backend proof (tier/localProof.ts `hasLocalProof`); on a shared tier it changes nothing.
 * `probeUuid()` returns a fresh random uuid the guard accepts as a mutation target, for negative cases that must answer
 * 404; it cannot name an existing object. Every uuid check reads the live object through the raw context (GET).
 * The ledger, run id, tier identity and environment the guard judges against are the process's own; unit tests inject
 * them through `guardApiWithSeams` only (the spec lint refuses that name outside tests/unit).
 */
import { getAuthenticatedApiContext } from '../../auth/apiContext';
import { isCanonicalUuid, merge, findUuidsInString, unescapeJson, UUID_ANYWHERE, FoundUuids } from './uuids';
import { apiPathOfPathname, hasMethodParam, nameSegmentProblem, NO_BASE, pathCharProblem, rawPathOf, readApiPath, readPathProblem, resolveSentUrl, SentUrl, structuralPathProblem, uuidSegmentProblem } from './urls';
import { platformDenied, POST_CREATE, postRouteKind } from './allowLists';
import { bulkRouteTargets, hasFiltersKey, jsonDepth, MAX_BODY_DEPTH, PathTarget, pathTargets, isPlainObject } from './targets';
import { findUuidsInBody, BodySnapshot, CREATE_BODY_SHAPES, findUuidsInQuery, readJsonBody, readTextBody } from './bodies';
import { approvalDecisionProblem, approvalLiveProblem, callerUuidOf, isApprovalProfileWrite, stepUserUuids, withoutSelfSteps } from './approvals';
import { foreignDefaultViews, SAVED_VIEW_CREATE, SAVED_VIEW_TARGET, savedViewBodyProblem, viewRowsOf } from './savedViews';
import { BODYLESS, DEFAULT_MAX_REDIRECTS, FORWARDED_OPTIONS, headerProblem, IDENTITY_HEADERS, JSON_CONTENT, Method, METHOD_IN_TEXT, METHODS, OPTION_KEYS, PROTOCOL_CONTENT, readPostType, REDIRECTS, PROBE_METHODS, textPlainType } from './headers';
import { Claims, GUARDED, GuardedApi, GuardOptions, GuardTestSeams, RequestShape } from './types';
import { BODY_FIELD_TYPES, bulkRoute, listBodyRoute, malformedUuidProbe, noHandlerProbe, routeFieldWaivers, sideEffectGet } from './routes';
import { assertNotDryRun } from '../run/flags';
import { assertOwn, assertOwnLive, isIdNamed, LiveOptions, OwnObjectViolation, checkOwnership, RefusalKind } from '../ledger/ownership';
import { currentRunId } from '../run/runId';
import { hasLocalProof } from '../tier/localProof';
import { isLocalTier, tierIdentity } from '../tier/kind';
import * as crypto from 'crypto';
import type { APIRequestContext, APIResponse } from '@playwright/test';

/** The request the guard judged and sends: every input read once, plain data only. */
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
    /** The caller asked to send an identity header of its own (never forwarded; judged: the refused-method and no-handler probes refuse it). */
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
    /** The caller's own user uuid (approval profile steps, (`GET /v1/auth/profile` through the wrapped context), cached once read. */
    let caller: string | undefined;
    const callerUuid = async (): Promise<string | undefined> => {
        if (caller) return caller;
        try {
            const r = await api.get('/api/v1/auth/profile', { failOnStatusCode: false });
            if (r.ok()) caller = callerUuidOf(await r.json());
        } catch {
            caller = undefined;
        }
        return caller;
    };

    /**
     * Rules (a)–(d) and the snapshot: every input read once into plain data; throws OwnObjectViolation (kind
     * `request`) for anything the guard does not forward.
     */
    function readRequest(entry: Entry, urlOrRequest: unknown, dataArg: { given: boolean; value?: unknown }, optionsIn: unknown): Snapshot {
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
        const protocol = M === 'POST' && !!apiPath && postRouteKind(apiPath) === 'protocol';
        // A read POST (POST_READ) may declare the three read-POST content types.
        const readPost = M === 'POST' && !!apiPath && postRouteKind(apiPath) === 'read';
        // identityOverride
        if (o.identityOverride !== undefined && typeof o.identityOverride !== 'boolean') refuse('identityOverride must be a boolean');
        const identityOverride = o.identityOverride === true;
        // A refused-method probe (TRACE, QAPROBE) runs as the run's own identity, never with an identity header.
        if (PROBE_METHODS.has(M) && identityOverride) refuse(`identityOverride on a ${M} (a refused-method probe carries no identity header)`);
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
        // A 415 negative: text/plain only on a non-GET request with a string / Buffer
        // body and without an identity header (even with identityOverride); the body goes as written, judged as raw text.
        const textPlain = declared !== undefined && textPlainType(declared) !== undefined;
        if (textPlain) {
            if (BODYLESS.has(M)) refuse('text/plain on a GET / HEAD / TRACE (a 415 negative is a request with a text body)');
            if (Object.keys(headers!).some((h) => IDENTITY_HEADERS.has(h))) {
                refuse('an identity header on a text/plain request (a 415 negative runs as the run\'s own identity)');
            }
        }
        // A read-POST content type (headerProblem admitted it on a POST_READ route only): the body goes as
        // written like text/plain (Playwright sends a string raw under any non-JSON type), UTF-8, no NUL, no identity
        // header (even with identityOverride), and its text may not contain `_method` (any case).
        const readPostContent = declared !== undefined && readPost && readPostType(declared) !== undefined;
        if (readPostContent && Object.keys(headers!).some((h) => IDENTITY_HEADERS.has(h))) {
            refuse(`an identity header on a ${declared} request (a 415 negative runs as the run's own identity)`);
        }
        const body: BodySnapshot | { problem: string } = textPlain || readPostContent
            ? readTextBody(data)
            : protocolType && (typeof data === 'string' || data instanceof String)
                ? { view: { kind: 'text', text: String(data) }, send: String(data) }
                : readJsonBody(data);
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
    async function checkRequest(s: Snapshot): Promise<void> {
        const method = s.method;
        const apiPath = apiPathOfPathname(s.sent.effective.pathname);
        const helper = `guardedApi ${method} ${apiPath ?? '(outside /api)'}`;
        const refuse = (reason: string, kind: RefusalKind = 'request', ref: { uuid?: string } = {}): never => {
            throw new OwnObjectViolation(helper, ref, reason, undefined, kind);
        };
        const provenLocal = localStack && isLocalTier(env) && hasLocalProof(env);
        /**
         * Every named uuid must be own (or a probe); a TARGET must have a ledger line of exactly the resource type the
         * route acts on (an id-named `approvals` line cannot authorise an RA profile route), and so must a
         * uuid under a typed body field (BODY_FIELD_TYPES, `groupUuids` → groups); any other body
         * association (type undefined) may be any own object.
         */
        const assertOwnAll = async (named: Claims): Promise<void> => {
            const live = liveOpts();
            // The ledger options keep `env` (REG_RESTRICTED_USERNAME is read through it); `tier` is set by assertOwnLive.
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
         * A top-level uuid list body on a route with a path target or on a create is typed by
         * LIST_BODY_TYPES (own with that ledger type, or a probe; null: probes only); on any other such route a
         * non-probe uuid in it is refused. Bulk routes (no path target) are typed by BULK_ROUTES instead.
         */
        const claimList = (claims: Claims, list: unknown[]): void => {
            const route = listBodyRoute(method, apiPath!);
            // A LIST_BODY_TYPES body is `List<String>`; a nested list, an object, a number or null
            // would escape the type check (it falls back to any own type), so it is refused like bulkRouteTargets does.
            if (route && list.some((e) => typeof e !== 'string')) {
                refuse(`the list body of ${route.path} holds an element that is not a string (its body is ${route.dto.split(' ')[0]})`, 'request');
            }
            const named = [...new Set(list.filter(isCanonicalUuid).map((u) => (u as string).toLowerCase()))].filter((u) => !probes.has(u));
            if (!named.length) return;
            if (!route) {
                refuse('a top-level uuid list body on a route without a typed list (guard/routes.ts LIST_BODY_TYPES): the guard cannot tell which ' +
                    'resource it names', 'request', { uuid: named[0] });
            }
            if (route!.type === null) {
                refuse(`the list body of ${route!.path} names a resource the suite has no ledger type for (guard/routes.ts LIST_BODY_TYPES): probes only`, 'request', { uuid: named[0] });
            }
            for (const uuid of named) addClaim(claims, uuid, route!.type as string, `the list body of ${route!.path} names ${route!.type}`);
        };
        /** Adds the targets to the claims: a non-probe target of a resource without a ledger type, or one uuid as two types, is refused. */
        const claimTargets = (claims: Claims, targets: PathTarget[], what: string): void => {
            for (const t of targets) {
                if (t.type === undefined && !probes.has(t.uuid)) {
                    refuse(`${what} on a resource the suite has no ledger type for (guard/routes.ts TARGET_TYPES / BULK_ROUTES): ownership cannot be ` +
                        'matched to the resource the request acts on', 'request', { uuid: t.uuid });
                }
                addClaim(claims, t.uuid, t.type, `the request acts on ${t.type}`);
            }
        };
        /** The typed body fields (BODY_FIELD_TYPES); a field of a resource without a ledger type takes probes only. */
        const claimFields = (claims: Claims, typed: Array<[string, string | null, string]>): void => {
            for (const [uuid, type, field] of typed) {
                if (probes.has(uuid)) continue;
                if (type === null) {
                    refuse(`the body field ${field} names a resource the suite has no ledger type for (guard/routes.ts BODY_FIELD_TYPES): probes only`, 'request', { uuid });
                }
                addClaim(claims, uuid, type as string, `the body field ${field} names ${type}`);
            }
        };
        if (PROBE_METHODS.has(method)) {
            // A refused-method probe is a bodyless read held to the GET path rules; a side-effect GET
            // path is refused outright (a server that dispatched the method like GET must never persist anything), own
            // object or not.
            const structural = readPathProblem(s.sent);
            if (structural) refuse(`${structural}: the guard checks plain paths only (${method} too)`);
            const readPath = readApiPath(s.sent.effective);
            if (readPath && sideEffectGet(readPath)) refuse(`a ${method} on a path that persists something for a GET (guard/routes.ts SIDE_EFFECT_GETS)`);
            return;
        }
        if (method === 'GET' || method === 'HEAD') {
            // The shared structural path rule first, so the side-effect rule matches what the server dispatches.
            const structural = readPathProblem(s.sent);
            if (structural) refuse(`${structural}: the guard checks plain paths only (GET / HEAD too)`);
            // A GET that persists something (guard/routes.ts SIDE_EFFECT_GETS): like a mutation, only on own objects.
            const readPath = readApiPath(s.sent.effective);
            const effect = readPath ? sideEffectGet(readPath) : undefined;
            if (effect && !provenLocal) {
                if (!effect.ids.length) refuse('a GET that persists something (guard/routes.ts SIDE_EFFECT_GETS), without an object of the run in its path');
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
        const kind = method === 'POST' ? postRouteKind(apiPath!) : undefined;
        if (kind === 'read' || kind === 'protocol') return;
        // 2b. No-handler probes: an exact (method, path) pair that reaches no handler (guard/routes.ts NO_HANDLER_PROBES), sent
        // bodyless, without a query, as the run's own identity: Spring answers 400 before any controller.
        if (noHandlerProbe(method, apiPath!)) {
            if (s.body.view.kind !== 'none') refuse(`a body on the no-handler probe ${method} ${apiPath} (guard/routes.ts NO_HANDLER_PROBES: bodyless only)`);
            if (s.query.toString()) refuse(`a query on the no-handler probe ${method} ${apiPath} (guard/routes.ts NO_HANDLER_PROBES: no query)`);
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
        // 4b. The per-route shape rule of a create (`/v1/certificates/import`: certificate-only entries).
        const shape = kind === 'create' && Object.hasOwn(CREATE_BODY_SHAPES, apiPath!) ? CREATE_BODY_SHAPES[apiPath!](view) : undefined;
        if (shape) refuse(shape);
        const json = view.kind === 'json' ? view.value : undefined;
        if (view.kind === 'json' && jsonDepth(json) > MAX_BODY_DEPTH) refuse(`a body nested deeper than ${MAX_BODY_DEPTH} levels`);
        // 4c. The saved-view body shape (create and update), on every tier like CREATE_BODY_SHAPES.
        const viewTarget = method === 'PUT' ? SAVED_VIEW_TARGET.exec(apiPath!) : null;
        const savedView = (kind === 'create' && apiPath === SAVED_VIEW_CREATE) || !!viewTarget;
        if (savedView) {
            const problem = savedViewBodyProblem(view, viewTarget ? 'update' : 'create', runId());
            if (problem) refuse(problem);
        }
        const otherIdentity = s.identityOverride || Object.keys(s.headers ?? {}).some((h) => IDENTITY_HEADERS.has(h));
        // 4d. On an own approval profile write, a step's `userUuid` equal to the caller's own user is not
        // claimed (that position only; a request with another identity, or a caller that cannot be read, gets no waiver).
        let scanned = json;
        if (!provenLocal && view.kind === 'json' && !otherIdentity && isApprovalProfileWrite(method, apiPath!)) {
            const named = stepUserUuids(json).filter((u) => !probes.has(u));
            const self = named.length ? await callerUuid() : undefined;
            if (self && named.includes(self)) scanned = withoutSelfSteps(json, self);
        }
        const references = method !== 'DELETE';
        const findings: FoundUuids = { canonical: [], nonCanonical: [] };
        // Text the server does not read as JSON (a non-JSON Buffer on a create; a text/plain body): free text, as written
        // and as a JSON reader would decode it — every canonical uuid in it must be own, any other uuid-like token is refused.
        if (view.kind === 'text' || view.kind === 'plain') {
            merge(findings, findUuidsInString(view.text, { free: true }));
            merge(findings, findUuidsInString(unescapeJson(view.text), { free: true }));
        } else {
            // A route-scoped top-level field waiver (guard/routes.ts ROUTE_FIELD_WAIVERS), like REFERENCE_FIELDS.
            merge(findings, findUuidsInBody(scanned, { references, waive: routeFieldWaivers(method, apiPath!, json) }));
            // Caller-supplied text: every canonical uuid in it, as written and as decoded, must be own (no waivers).
            if (view.kind === 'json' && view.raw !== undefined) {
                for (const t of [view.raw, unescapeJson(view.raw)]) for (const m of t.matchAll(UUID_ANYWHERE)) merge(findings, { canonical: [m[0].toLowerCase()], nonCanonical: [] });
            }
        }
        merge(findings, findUuidsInQuery(s.query.toString() ? new URL(`${NO_BASE}?${s.query.toString()}`) : new URL(NO_BASE)));
        if (findings.nonCanonical.length) {
            refuse(`a non-canonical uuid form in the body or query (${findings.nonCanonical.slice(0, 3).join(', ')}): the server may parse it as a uuid; send the canonical form`);
        }
        // 5. platform endpoints, 6. ownership — lifted only by localStack on a proven local stack
        const platform = platformDenied(apiPath!, json);
        if (platform && !provenLocal) refuse(`${platform} is platform-level: @local rows with localStack on a proven local stack only`);
        if (!provenLocal) {
            // Malformed-uuid probes: an exact (method, template, literal) of guard/routes.ts MALFORMED_UUID_PROBES (`PUT|DELETE /v1/groups|
            // credentials/not-a-uuid`): core answers 422 from SecuredUUID.fromString before any lookup; the literal is not
            // uuid-like (rule 3 ran) and names nothing, so rule 6a and the path-target rule are skipped for it — the body
            // still passes every body rule below.
            const malformed = malformedUuidProbe(method, apiPath!);
            const named = malformed ? undefined : nameSegmentProblem(apiPath!);
            if (named) refuse(named);
            // Body associations first (any own type; a typed body field its type), then the targets with the type
            // of the resource.
            const free = view.kind === 'text' || view.kind === 'plain';
            const claims: Claims = new Map(findings.canonical.map((u) => [u, free ? { free } : {}]));
            claimFields(claims, findings.typed ?? []);
            // A top-level list body: typed by LIST_BODY_TYPES unless it is a bulk route's (no path target, not a create).
            if (Array.isArray(json) && (kind === 'create' || pathTargets(apiPath!).length > 0)) claimList(claims, json);
            let targets: PathTarget[] = [];
            if (kind !== 'create') {
                targets = pathTargets(apiPath!);
                if (!targets.length && !malformed) {
                    const route = bulkRoute(method, apiPath!);
                    if (!route) {
                        refuse('a mutation without a uuid in the path that is neither an allow-listed create (POST_CREATE) nor an allow-listed bulk route ' +
                            '(guard/routes.ts BULK_ROUTES)');
                    }
                    if (view.kind === 'plain') refuse(`a text/plain body on the bulk route ${route!.path} (its ${route!.dto} body is JSON: the guard cannot read the uuid list from text)`);
                    const bulk = hasFiltersKey(json) ? { problem: 'a bulk body with filters (never accepted: they select objects the guard cannot see)' } : bulkRouteTargets(route!, json);
                    if ('problem' in bulk) refuse(bulk.problem);
                    targets = (bulk as { uuids: string[] }).uuids.map((uuid) => ({ uuid, type: route!.type }));
                }
                claimTargets(claims, targets, `a mutation of ${method} ${apiPath}`.slice(0, 120));
            }
            // An approval in the path may only be decided, as the run's own user (route, identity, body first).
            const approvals = targets.filter((t) => t.type === 'approvals' && !probes.has(t.uuid)).map((t) => t.uuid);
            for (const _approval of approvals) {
                const problem = approvalDecisionProblem(method, apiPath!, view, otherIdentity);
                if (problem) refuse(problem, 'request', { uuid: _approval });
            }
            await assertOwnAll(claims);
            for (const approval of approvals) await assertOwnApprovalDecision(approval, helper, refuse);
            // `defaultView: true` clears the default of every other view of the user and resource (shared tiers).
            if (savedView && isPlainObject(json) && json.defaultView === true) await assertNoForeignDefaultView(json, viewTarget?.[1]?.toLowerCase(), refuse);
        }
        // 7. the dry run, after ownership
        if (method === 'DELETE') assertNotDryRun(helper, env);
    }

    type Refuse = (reason: string, kind?: RefusalKind, ref?: { uuid?: string }) => never;

    /**
     * The approval's `approvals` line of this run names an own certificate and an own approval profile
     * (`parents.certificate`, `parents.approvalProfile`: own, non-derived lines of exactly those types, read live), and
     * the approval's live detail names exactly those two (a read through the wrapped context, like every live check).
     */
    async function assertOwnApprovalDecision(uuid: string, helper: string, refuse: Refuse): Promise<void> {
        const live = liveOpts();
        const { tier: _tier, ...ledgerOpts } = live;
        const line = assertOwn({ uuid }, helper, ledgerOpts);
        const single = (key: string): string | undefined => {
            const v = line.parents?.[key];
            return typeof v === 'string' ? v : undefined;
        };
        const parents: Array<[string | undefined, string]> = [[single('certificate'), 'certificates'], [single('approvalProfile'), 'approvalProfiles']];
        for (const [p, type] of parents) {
            if (!p) refuse(`the approvals line names no own ${type === 'certificates' ? 'certificate' : 'approval profile'} (parents certificate, approvalProfile)`, 'ownership', { uuid });
            const pl = assertOwn({ uuid: p! }, helper, ledgerOpts);
            if (pl.type !== type || pl.derived) refuse(`the approval's ${type} parent is not an own ${type} line of this run`, 'ownership', { uuid: p });
            await assertOwnLive(api, type, { uuid: p! }, helper, live);
        }
        const res = await api.get(`/api/v1/approvals/${uuid}`, { failOnStatusCode: false });
        if (!res.ok()) refuse(`the approval's live detail answered ${res.status()}: its certificate and approval profile cannot be proven`, 'ownership', { uuid });
        let detail: unknown;
        try {
            detail = await res.json();
        } catch {
            detail = undefined;
        }
        const why = approvalLiveProblem(detail, parents[0][0]!.toLowerCase(), parents[1][0]!.toLowerCase());
        if (why) refuse(why, 'ownership', { uuid });
    }

    /**
     * A saved view saved with `defaultView: true` (create, or update of the own view `target`) clears the
     * default flag of every other view of the caller and resource: sent only when none of those is a pre-existing view
     * (the caller's views read live; a view counts as own with a `savedViews` line of this run).
     */
    async function assertNoForeignDefaultView(body: Record<string, unknown>, target: string | undefined, refuse: Refuse): Promise<void> {
        const url = target ? '/api/v1/listViews' : `/api/v1/listViews?resource=${encodeURIComponent(String(body.resource))}`;
        const res = await api.get(url, { failOnStatusCode: false });
        if (!res.ok()) refuse(`defaultView: true needs the caller's views (GET ${url.split('?')[0]} answered ${res.status()})`);
        let rows;
        try {
            rows = viewRowsOf(await res.json());
        } catch {
            rows = undefined;
        }
        if (!rows) refuse('defaultView: true needs the caller\'s views, and the list answer is not a list of views');
        const resource = target ? rows!.find((r) => r.uuid === target)?.resource : String(body.resource);
        if (!resource) refuse('defaultView: true on a view the caller\'s list does not show (its resource cannot be read)', 'ownership', { uuid: target });
        const { tier: _tier, ...ledgerOpts } = liveOpts();
        const foreign = foreignDefaultViews(rows!, resource!, target, (u) => {
            const o = checkOwnership({ uuid: u }, ledgerOpts);
            return o.own && o.line?.type === 'savedViews';
        });
        if (foreign.length) {
            refuse('defaultView: true would clear the default flag of a pre-existing view of this user and resource (core ListViewWriter.save → clearDefaultExcept)', 'ownership', { uuid: foreign[0] });
        }
    }

    /** The Playwright options of a snapshot: plain data only, `maxRedirects: 0` (the guard follows redirects itself). */
    const buildSentOptions = (s: Snapshot): Record<string, unknown> => ({
        ...(s.params !== undefined ? { params: s.params } : {}),
        ...(s.headers !== undefined ? { headers: s.headers } : {}),
        ...(s.body.send !== undefined ? { data: s.body.send } : {}),
        ...s.pass,
        maxRedirects: 0,
    });

    /** Send a judged snapshot; a GET / HEAD follows same-origin redirects through the URL and side-effect rules. */
    async function sendRequest(s: Snapshot): Promise<APIResponse> {
        onRequest?.(s.method, s.url);
        if (s.method !== 'GET' && s.method !== 'HEAD') return api.fetch(s.url, { ...buildSentOptions(s), method: s.method } as Parameters<APIRequestContext['fetch']>[1]);
        const read = (u: string, o: Record<string, unknown>) =>
            s.method === 'GET' ? api.get(u, o as Parameters<APIRequestContext['get']>[1]) : api.head(u, o as Parameters<APIRequestContext['head']>[1]);
        let res = await read(s.url, buildSentOptions(s));
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
            // The hop's path as the Location writes it and as it will be sent, by the shared structural rule.
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
        await checkRequest(readRequest({ kind: 'check', method }, url, { given: true, value: data }, options));
    }

    const wrapper = (method: Method) => async (url: string, options?: FetchOptions): Promise<APIResponse> => {
        const s = readRequest({ kind: 'wrapper', method }, url, { given: false }, options);
        await checkRequest(s);
        return sendRequest(s);
    };

    const guarded = {
        get: wrapper('GET'),
        head: wrapper('HEAD'),
        post: wrapper('POST'),
        put: wrapper('PUT'),
        patch: wrapper('PATCH'),
        delete: wrapper('DELETE'),
        fetch: async (urlOrRequest: string | RequestLike, options?: FetchOptions): Promise<APIResponse> => {
            const s = readRequest({ kind: 'fetch' }, urlOrRequest, { given: false }, options);
            await checkRequest(s);
            return sendRequest(s);
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
 * `onRequest` are read from `opts`: the ledger, run id, tier and environment are always the process's own.
 */
export function guardApi(api: APIRequestContext, opts: GuardOptions = {}): GuardedApi {
    return createGuard(api, { onRequest: opts.onRequest, localStack: opts.localStack }, {});
}

/** Unit tests only: the guard judging against injected ledger lines, run id, tier and environment. */
export function guardApiWithSeams(api: APIRequestContext, opts: GuardOptions & GuardTestSeams = {}): GuardedApi {
    const { onRequest, localStack, ...seams } = opts;
    return createGuard(api, { onRequest, localStack }, seams);
}

/**
 * `getAuthenticatedApiContext` wrapped in the guard: the API context of REG-* / API-* specs that do not use the `api`
 * fixture. Signature stable: `getGuardedApiContext(request, env, opts?)`. Dispose it in finally.
 */
export async function getGuardedApiContext(request: APIRequestContext, env: import('../../env').TestEnv, opts: GuardOptions = {}): Promise<GuardedApi> {
    return guardApi(await getAuthenticatedApiContext(request, env), opts);
}
