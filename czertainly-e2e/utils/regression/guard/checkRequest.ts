/**
 * checkRequest — judges one request snapshot against the guard's rules 1-7 (second half of every guarded request).
 *
 * A refused request is never sent. The rule order is part of the specification: a request that breaks two rules gets the
 * message of the earlier one (the unit tests pin it). Mutations are checked, in order, for:
 *   1. a safe path under /api/v1|v2; 2. the read-only allow-list and protocol POSTs; 3. non-canonical uuids; 4. the body;
 *   5. the platform deny-list; 6. ownership (a live run-prefixed name plus a `created` ledger line, or a probe uuid);
 *   7. DELETE under API_TEARDOWN_DRY_RUN throws DryRunRefusal.
 * `localStack: true` (`@local` specs only) lifts rules 5 and 6 only on a proven local stack.
 */
import { isCanonicalUuid, merge, findUuidsInString, unescapeJson, UUID_ANYWHERE, FoundUuids } from './uuids';
import { apiPathOfPathname, nameSegmentProblem, NO_BASE, readApiPath, readPathProblem, structuralPathProblem, uuidSegmentProblem } from './urls';
import { callbackParentOf, platformDenied, postRouteKind } from './allowLists';
import { bulkRouteTargets, hasFiltersKey, jsonDepth, MAX_BODY_DEPTH, PathTarget, pathTargets } from './targets';
import { BodyView, CREATE_BODY_SHAPES, findUuidsInBody, findUuidsInQuery, LIST_ELEMENT } from './bodies';
import { approvalDecisionProblem, isApprovalProfileWrite, stepUserUuids, withoutSelfSteps } from './approvals';
import { IDENTITY_HEADERS, PROBE_METHODS } from './headers';
import { bulkRoute, malformedUuidProbe, noHandlerProbe, routeFieldWaivers, routePathWaivers, sideEffectGet } from './routes';
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
    const findings = findUuids(m, body, scanned, kind);
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
function findUuids({ s, method, apiPath, refuse }: Mutation, { view, json }: MutationBody, scanned: unknown, kind: PostKind): FoundUuids {
    const references = method !== 'DELETE';
    const findings: FoundUuids = { canonical: [], nonCanonical: [] };
    // Text the server does not read as JSON (a non-JSON Buffer on a create; a text/plain body): free text, as written
    // and as a JSON reader would decode it — every canonical uuid in it must be own, any other uuid-like token is refused.
    if (view.kind === 'text' || view.kind === 'plain') {
        merge(findings, findUuidsInString(view.text, { free: true }));
        merge(findings, findUuidsInString(unescapeJson(view.text), { free: true }));
    } else {
        // A route-scoped top-level field waiver (guard/routes.ts ROUTE_FIELD_WAIVERS), like REFERENCE_FIELDS.
        merge(findings, kind === 'callback'
            ? findUuidsInBody(scanned, { references: false, scanAttributes: true, waivePaths: callbackWaivers(apiPath) })
            : findUuidsInBody(scanned, { references, waive: routeFieldWaivers(method, apiPath, json), waivePaths: routePathWaivers(method, apiPath, json) }));
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
    const callbackParent = kind === 'callback' ? callbackParentOf(apiPath) : undefined;
    // An attribute callback: its path id must be what the preflight registered (or an own token profile), and the body may name that parent too.
    if (kind === 'callback') checkCallbackParent(m, callbackParent);
    const bodyUuids = callbackParent && callbackParent.kind !== 'tokenProfile' ? findings.canonical.filter((u) => u !== callbackParent.uuid) : findings.canonical;
    const claims = new Claims(state, refuse, bodyUuids, view.kind === 'text' || view.kind === 'plain');
    claims.fields(findings.typed ?? []);
    // A top-level list body: typed by LIST_BODY_TYPES unless it is a bulk route's (no path target, not a create).
    if (Array.isArray(json) && (kind === 'create' || pathTargets(apiPath).length > 0)) claims.list(method, apiPath, json);
    if (callbackParent?.kind === 'tokenProfile') claims.add(callbackParent.uuid, 'tokenProfiles', 'the callback names its token profile');
    const targets = kind !== 'create' && kind !== 'callback' ? claimTargets(m, claims, body, !!malformed) : [];
    // An approval in the path may only be decided, as the run's own user (route, identity, body first).
    const approvals = targets.filter((t) => t.type === 'approvals' && !state.probes.has(t.uuid)).map((t) => t.uuid);
    for (const approval of approvals) {
        const problem = approvalDecisionProblem(method, apiPath, view, otherIdentity);
        if (problem) refuse(problem, 'request', { uuid: approval });
    }
    await assertOwnAll(state, claims, helper, refuse);
    for (const approval of approvals) await assertOwnApprovalDecision(state, approval, helper, refuse);
}

/**
 * The key paths of an attribute callback's body that may hold a non-own uuid: the attribute DEFINITION the callback names (`uuid`, and the
 * `uuid` of each `attributes[]` item, `interfaceUuid` the connector interface): core resolves them only among the path connector's own
 * definitions (CallbackServiceImpl.getBaseAttributeFromExistingDefinition, the NG dispatch's interface check). Any other uuid, in `body`,
 * `pathVariable`, `filter` or inside an attribute's content, is an object core would expand: it must be own or the registered parent.
 */
const CALLBACK_WAIVERS: ReadonlyArray<readonly string[]> = [['uuid'], ['interfaceUuid'], ['attributes', LIST_ELEMENT, 'uuid']];

/**
 * The waivers of one callback route. The RA-profile form's `pathVariable.authorityId` is the CONNECTOR-SIDE id of the authority instance
 * (the static value of the attribute's callback mapping the preflight read: no ILM inventory object, core passes it on to the connector as
 * a path variable and expands nothing for it), so it may be a uuid there and only there.
 */
function callbackWaivers(apiPath: string): ReadonlyArray<readonly string[]> {
    return callbackParentOf(apiPath)?.kind === 'authority' ? [...CALLBACK_WAIVERS, ['pathVariable', 'authorityId']] : CALLBACK_WAIVERS;
}

/** The callback's path id: a registered authority / connector of this run, or (checked as a claim) an own token profile. */
function checkCallbackParent({ state, refuse }: Mutation, parent: ReturnType<typeof callbackParentOf>): void {
    if (!parent) refuse('an attribute callback on a path the guard does not know', 'request');
    if (parent!.kind === 'tokenProfile') return;
    if (!state.callbackTargets[parent!.kind].has(parent!.uuid)) {
        refuse(`an attribute callback on a ${parent!.kind} the preflight did not discover for this run (guard registerCallbackTarget)`, 'request', { uuid: parent!.uuid });
    }
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
