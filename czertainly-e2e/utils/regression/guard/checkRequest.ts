/**
 * checkRequest — judges one snapshot against the guard's rules 1–7.
 *
 * WHAT: the second half of every guarded request. A refused-method probe (TRACE, QAPROBE) goes to `checkProbeRead`, a
 * GET to `checkRead`, every other method to `checkMutation`. `checkMutation` runs its rules in a fixed order, each rule
 * a named function: checkMutationPath (1), the read-only and protocol POSTs (2), checkNoHandlerProbe (2b),
 * checkUuidSegments (3), checkBody (4, 4b), waiveSelfSteps (4d), findUuids (4), checkPlatformDeny (5), checkOwnership
 * (6) and checkDryRun (7).
 * WHY: the order of the rules is part of the specification: a request that breaks two rules is refused with the message
 * of the earlier one, and the unit tests pin those messages. A rule that moves changes which message a caller sees, so
 * the order lives in one short function and each rule can be read, and reordered, as a named step.
 * HOW: nothing is read from the caller any more: every rule reads the snapshot. Rule 6 is skipped for a proven local
 * stack (`localStack` on a local tier with this run's proof), as is rule 5. A refused request is never sent.
 *
 * The rules (the options, header, URL and `_method` rules a–d are in readRequest.ts):
 * GET passes a, b, c, d and the structural path rule (urls.ts `readPathProblem`: no `//`, dot segment, `;`,
 * `%2f` / `%5c` / `%2e`, backslash, parser-changed path or `/API` spelling), carries no body, and a GET that persists
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
 * Approvals, on top of rules 4–6:
 *   - approvals (approvals.ts): an approval profile step may name the caller's own user (`GET /v1/auth/profile`) on an own
 *     profile write; an approval named in a path may only be decided (four PATCH routes) as the run's own user, and
 *     only when its ledger line names an own certificate and an own approval profile that its live detail confirms.
 * `localStack: true` (`@local` specs only) lifts rules 5 and 6 only while TIER_KIND=local in the process environment and
 * this run holds its unexpired local-backend proof (tier/localProof.ts `hasLocalProof`); on a shared tier it changes nothing.
 */
import { isCanonicalUuid, merge, findUuidsInString, unescapeJson, UUID_ANYWHERE, FoundUuids } from './uuids';
import { apiPathOfPathname, nameSegmentProblem, NO_BASE, readApiPath, readPathProblem, structuralPathProblem, uuidSegmentProblem } from './urls';
import { platformDenied, postRouteKind } from './allowLists';
import { bulkRouteTargets, hasFiltersKey, jsonDepth, MAX_BODY_DEPTH, PathTarget, pathTargets } from './targets';
import { BodyView, CREATE_BODY_SHAPES, findUuidsInBody, findUuidsInQuery } from './bodies';
import { approvalDecisionProblem, isApprovalProfileWrite, stepUserUuids, withoutSelfSteps } from './approvals';
import { IDENTITY_HEADERS, PROBE_METHODS } from './headers';
import { bulkRoute, malformedUuidProbe, noHandlerProbe, routeFieldWaivers, sideEffectGet } from './routes';
import { assertOwnAll, assertOwnApprovalDecision, Claims } from './claims';
import { Refuse, refuserFor } from './refuse';
import { assertNotDryRun } from '../run/flags';
import type { GuardState } from './guardState';
import type { Snapshot } from './readRequest';

/** What every rule of one check needs: the snapshot, the guard's state, the refusal label and the proven-local flag. */
interface Checked {
    s: Snapshot;
    state: GuardState;
    method: Snapshot['method'];
    /** The API path (`/v1/...`) when the URL lies under `/api`. */
    apiPath: string | undefined;
    helper: string;
    refuse: Refuse;
    /** `localStack` on a proven local stack: lifts the platform deny-list and the ownership rules. */
    provenLocal: boolean;
}

/** A mutation after rule 1: the API path is known. */
type Mutation = Checked & { apiPath: string };

type PostKind = ReturnType<typeof postRouteKind>;

/** The body of a mutation as the rules read it. */
interface MutationBody {
    view: BodyView;
    /** The JSON value (undefined for a body that is not JSON). */
    json: unknown;
}

/** Rules 1–7 on a snapshot (nothing is read from the caller any more). */
export async function checkRequest(state: GuardState, s: Snapshot): Promise<void> {
    const apiPath = apiPathOfPathname(s.sent.effective.pathname);
    const helper = `guardedApi ${s.method} ${apiPath ?? '(outside /api)'}`;
    const checked: Checked = { s, state, method: s.method, apiPath, helper, refuse: refuserFor(helper), provenLocal: state.isProvenLocal() };
    if (PROBE_METHODS.has(s.method)) return checkProbeRead(checked);
    if (s.method === 'GET') return checkRead(checked);
    return checkMutation(checked);
}

/**
 * A refused-method probe is a bodyless read held to the GET path rules; a side-effect GET
 * path is refused outright (a server that dispatched the method like GET must never persist anything), own
 * object or not.
 */
function checkProbeRead({ s, method, refuse }: Checked): void {
    const structural = readPathProblem(s.sent);
    if (structural) refuse(`${structural}: the guard checks plain paths only (${method} too)`);
    const readPath = readApiPath(s.sent.effective);
    if (readPath && sideEffectGet(readPath)) refuse(`a ${method} on a path that persists something for a GET (guard/routes.ts SIDE_EFFECT_GETS)`);
}

/** A GET: the shared structural path rule first, then the side-effect rule; a GET that persists something is judged like a mutation. */
async function checkRead({ s, state, helper, refuse, provenLocal }: Checked): Promise<void> {
    // The shared structural path rule first, so the side-effect rule matches what the server dispatches.
    const structural = readPathProblem(s.sent);
    if (structural) refuse(`${structural}: the guard checks plain paths only (GET too)`);
    // A GET that persists something (guard/routes.ts SIDE_EFFECT_GETS): like a mutation, only on own objects.
    const readPath = readApiPath(s.sent.effective);
    const effect = readPath ? sideEffectGet(readPath) : undefined;
    if (!effect || provenLocal) return;
    if (!effect.ids.length) refuse('a GET that persists something (guard/routes.ts SIDE_EFFECT_GETS), without an object of the run in its path');
    if (![...effect.ids, ...effect.parents].every(isCanonicalUuid)) refuse('a GET that persists something, with a path segment that is not a canonical uuid');
    const claims = new Claims(state, refuse);
    claims.targets(effect.ids.map((u, i) => ({ uuid: u.toLowerCase(), type: effect.types[i] })), 'a GET that persists something');
    await assertOwnAll(state, claims, helper, refuse);
}

/** Every other method, in the order of the rules (a refused request is never sent). */
async function checkMutation(checked: Checked): Promise<void> {
    const apiPath = checkMutationPath(checked);
    const m: Mutation = { ...checked, apiPath };
    // 2. read-only and protocol POSTs
    const kind = m.method === 'POST' ? postRouteKind(apiPath) : undefined;
    if (kind === 'read' || kind === 'protocol') return;
    if (checkNoHandlerProbe(m)) return;
    checkUuidSegments(m);
    const body = checkBody(m, kind);
    const otherIdentity = hasIdentity(m.s);
    const scanned = await waiveSelfSteps(m, body, otherIdentity);
    const findings = findUuids(m, body, scanned);
    checkPlatformDeny(m, body);
    if (!m.provenLocal) await checkOwnership(m, { body, kind, findings, otherIdentity });
    checkDryRun(m);
}

const hasIdentity = (s: Snapshot): boolean => s.identityOverride || Object.keys(s.headers ?? {}).some((h) => IDENTITY_HEADERS.has(h));

/** 1. The path, as written = as sent; a mutation lies under `/api`. */
function checkMutationPath({ s, apiPath, refuse }: Checked): string {
    const structural = structuralPathProblem(s.sent);
    if (structural) refuse(`${structural}: the guard checks plain paths only`);
    if (!apiPath) refuse('a mutating request outside the ILM API is not allowed through the guarded context');
    return apiPath!;
}

/**
 * 2b. No-handler probes: an exact (method, path) pair that reaches no handler (guard/routes.ts NO_HANDLER_PROBES), sent
 * bodyless, without a query, as the run's own identity: Spring answers 400 before any controller. True when the
 * request is such a probe (and passed).
 */
function checkNoHandlerProbe({ s, method, apiPath, helper, refuse, state }: Mutation): boolean {
    if (!noHandlerProbe(method, apiPath)) return false;
    if (s.body.view.kind !== 'none') refuse(`a body on the no-handler probe ${method} ${apiPath} (guard/routes.ts NO_HANDLER_PROBES: bodyless only)`);
    if (s.query.toString()) refuse(`a query on the no-handler probe ${method} ${apiPath} (guard/routes.ts NO_HANDLER_PROBES: no query)`);
    if (hasIdentity(s)) {
        refuse(`an identity header or identityOverride on the no-handler probe ${method} ${apiPath} (it runs as the run's own identity)`);
    }
    if (method === 'DELETE') assertNotDryRun(helper, state.env);
    return true;
}

/** 3. Uuid-like path segments. */
function checkUuidSegments({ s, refuse }: Mutation): void {
    const segmentProblem = uuidSegmentProblem(s.sent.effective.pathname);
    if (segmentProblem) refuse(segmentProblem);
}

/** 4. The body, as it will be sent; 4b. the per-route shape rule of a create (`/v1/certificates/import`: certificate-only entries). */
function checkBody({ s, apiPath, refuse }: Mutation, kind: PostKind): MutationBody {
    const view = s.body.view;
    if (view.kind === 'unreadable') refuse(`${view.why}: the guard cannot read what the server would read`);
    if (view.kind === 'text' && kind !== 'create') refuse('a Buffer body that is not JSON (the server could read what the guard cannot)');
    const shapeRule = kind === 'create' && Object.hasOwn(CREATE_BODY_SHAPES, apiPath) ? CREATE_BODY_SHAPES[apiPath] : undefined;
    const shape = shapeRule?.(view);
    if (shape) refuse(shape);
    const json = view.kind === 'json' ? view.value : undefined;
    if (view.kind === 'json' && jsonDepth(json) > MAX_BODY_DEPTH) refuse(`a body nested deeper than ${MAX_BODY_DEPTH} levels`);
    return { view, json };
}

/**
 * 4d. On an own approval profile write, a step's `userUuid` equal to the caller's own user is not
 * claimed (that position only; a request with another identity, or a caller that cannot be read, gets no waiver).
 * Returns the JSON value the uuid scan reads.
 */
async function waiveSelfSteps({ state, method, apiPath, provenLocal }: Mutation, { view, json }: MutationBody, otherIdentity: boolean): Promise<unknown> {
    if (provenLocal || view.kind !== 'json' || otherIdentity || !isApprovalProfileWrite(method, apiPath)) return json;
    const named = stepUserUuids(json).filter((u) => !state.probes.has(u));
    const self = named.length ? await state.callerUuid() : undefined;
    return self && named.includes(self) ? withoutSelfSteps(json, self) : json;
}

/**
 * 4. Every uuid the request names, as written and as decoded. A non-canonical uuid form is refused here; the canonical
 * ones are claimed by rule 6.
 */
function findUuids({ s, method, apiPath, refuse }: Mutation, { view, json }: MutationBody, scanned: unknown): FoundUuids {
    const references = method !== 'DELETE';
    const findings: FoundUuids = { canonical: [], nonCanonical: [] };
    // Text the server does not read as JSON (a non-JSON Buffer on a create; a text/plain body): free text, as written
    // and as a JSON reader would decode it — every canonical uuid in it must be own, any other uuid-like token is refused.
    if (view.kind === 'text' || view.kind === 'plain') {
        merge(findings, findUuidsInString(view.text, { free: true }));
        merge(findings, findUuidsInString(unescapeJson(view.text), { free: true }));
    } else {
        // A route-scoped top-level field waiver (guard/routes.ts ROUTE_FIELD_WAIVERS), like REFERENCE_FIELDS.
        merge(findings, findUuidsInBody(scanned, { references, waive: routeFieldWaivers(method, apiPath, json) }));
        // Caller-supplied text: every canonical uuid in it, as written and as decoded, must be own (no waivers).
        if (view.kind === 'json' && view.raw !== undefined) {
            for (const t of [view.raw, unescapeJson(view.raw)]) for (const found of t.matchAll(UUID_ANYWHERE)) merge(findings, { canonical: [found[0].toLowerCase()], nonCanonical: [] });
        }
    }
    merge(findings, findUuidsInQuery(s.query.toString() ? new URL(`${NO_BASE}?${s.query.toString()}`) : new URL(NO_BASE)));
    if (findings.nonCanonical.length) {
        refuse(`a non-canonical uuid form in the body or query (${findings.nonCanonical.slice(0, 3).join(', ')}): the server may parse it as a uuid; send the canonical form`);
    }
    return findings;
}

/** 5. Platform endpoints: lifted only by `localStack` on a proven local stack. */
function checkPlatformDeny({ apiPath, refuse, provenLocal }: Mutation, { json }: MutationBody): void {
    const platform = platformDenied(apiPath, json);
    if (platform && !provenLocal) refuse(`${platform} is platform-level: @local rows with localStack on a proven local stack only`);
}

/** What rule 6 reads besides the request: the body, the route kind, the uuids found and whether another identity is sent. */
interface OwnershipInput {
    body: MutationBody;
    kind: PostKind;
    findings: FoundUuids;
    otherIdentity: boolean;
}

/**
 * 6. Ownership, before the dry run: every uuid the request names must be an own object of the right type. Body
 * associations first (any own type; a typed body field its type), then the targets with the type of the resource.
 */
async function checkOwnership(m: Mutation, { body, kind, findings, otherIdentity }: OwnershipInput): Promise<void> {
    const { state, method, apiPath, helper, refuse } = m;
    const { view, json } = body;
    // Malformed-uuid probes: an exact (method, template, literal) of guard/routes.ts MALFORMED_UUID_PROBES (`PUT|DELETE /v1/groups|
    // credentials/not-a-uuid`): core answers 422 from SecuredUUID.fromString before any lookup; the literal is not
    // uuid-like (rule 3 ran) and names nothing, so rule 6a and the path-target rule are skipped for it — the body
    // still passes every body rule below.
    const malformed = malformedUuidProbe(method, apiPath);
    const named = malformed ? undefined : nameSegmentProblem(apiPath);
    if (named) refuse(named);
    const claims = new Claims(state, refuse, findings.canonical, view.kind === 'text' || view.kind === 'plain');
    claims.fields(findings.typed ?? []);
    // A top-level list body: typed by LIST_BODY_TYPES unless it is a bulk route's (no path target, not a create).
    if (Array.isArray(json) && (kind === 'create' || pathTargets(apiPath).length > 0)) claims.list(method, apiPath, json);
    const targets = kind !== 'create' ? claimTargets(m, claims, body, !!malformed) : [];
    // An approval in the path may only be decided, as the run's own user (route, identity, body first).
    const approvals = targets.filter((t) => t.type === 'approvals' && !state.probes.has(t.uuid)).map((t) => t.uuid);
    for (const approval of approvals) {
        const problem = approvalDecisionProblem(method, apiPath, view, otherIdentity);
        if (problem) refuse(problem, 'request', { uuid: approval });
    }
    await assertOwnAll(state, claims, helper, refuse);
    for (const approval of approvals) await assertOwnApprovalDecision(state, approval, helper, refuse);
}

/** The targets of a mutation that is not a create: those in the path, else those of an allow-listed bulk route. They join the claims. */
function claimTargets({ method, apiPath, refuse }: Mutation, claims: Claims, { view, json }: MutationBody, malformed: boolean): PathTarget[] {
    let targets = pathTargets(apiPath);
    if (!targets.length && !malformed) {
        const route = bulkRoute(method, apiPath);
        if (!route) {
            refuse('a mutation without a uuid in the path that is neither an allow-listed create (POST_CREATE) nor an allow-listed bulk route ' +
                '(guard/routes.ts BULK_ROUTES)');
        }
        if (view.kind === 'plain') refuse(`a text/plain body on the bulk route ${route!.path} (its ${route!.dto} body is JSON: the guard cannot read the uuid list from text)`);
        const bulk = hasFiltersKey(json) ? { problem: 'a bulk body with filters (never accepted: they select objects the guard cannot see)' } : bulkRouteTargets(route!, json);
        if ('problem' in bulk) refuse(bulk.problem);
        targets = (bulk as { uuids: string[] }).uuids.map((uuid) => ({ uuid, type: route!.type }));
    }
    claims.targets(targets, `a mutation of ${method} ${apiPath}`.slice(0, 120));
    return targets;
}

/** 7. The dry run, after ownership: a DELETE under API_TEARDOWN_DRY_RUN throws DryRunRefusal. */
function checkDryRun({ method, helper, state }: Mutation): void {
    if (method === 'DELETE') assertNotDryRun(helper, state.env);
}
