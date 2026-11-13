/**
 * checkRequest — judges one request snapshot against the guard's rules; a refused request is never sent. The order is pinned by unit tests:
 * 1 path, 2 read / protocol allow-list, 3 non-canonical uuids, 4 body, 5 platform deny-list, 6 ownership, 7 dry run;
 * `localStack` on a proven local stack lifts 5-6.
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

interface Checked {
    s: Snapshot;
    state: GuardState;
    method: Snapshot['method'];
    apiPath: string | undefined;
    helper: string;
    refuse: Refuse;
    provenLocal: boolean;
}

type Mutation = Checked & { apiPath: string };

type PostKind = ReturnType<typeof postRouteKind>;

interface MutationBody {
    view: BodyView;
    json: unknown;
}

export async function checkRequest(state: GuardState, s: Snapshot): Promise<void> {
    const apiPath = apiPathOfPathname(s.sent.effective.pathname);
    const helper = `guardedApi ${s.method} ${apiPath ?? '(outside /api)'}`;
    const checked: Checked = { s, state, method: s.method, apiPath, helper, refuse: refuserFor(helper), provenLocal: state.isProvenLocal() };
    if (PROBE_METHODS.has(s.method)) return checkProbeRead(checked);
    if (s.method === 'GET') return checkRead(checked);
    return checkMutation(checked);
}

/** A refused-method probe is a bodyless read held to the GET path rules; a side-effect GET path is refused outright. */
function checkProbeRead({ s, method, refuse }: Checked): void {
    const structural = readPathProblem(s.sent);
    if (structural) refuse(`${structural}: the guard checks plain paths only (${method} too)`);
    const readPath = readApiPath(s.sent.effective);
    if (readPath && sideEffectGet(readPath)) refuse(`a ${method} on a path that persists something for a GET (guard/routes.ts SIDE_EFFECT_GETS)`);
}

async function checkRead({ s, state, helper, refuse, provenLocal }: Checked): Promise<void> {
    const structural = readPathProblem(s.sent);
    if (structural) refuse(`${structural}: the guard checks plain paths only (GET too)`);
    const readPath = readApiPath(s.sent.effective);
    const effect = readPath ? sideEffectGet(readPath) : undefined;
    if (!effect || provenLocal) return;
    if (!effect.ids.length) refuse('a GET that persists something (guard/routes.ts SIDE_EFFECT_GETS), without an object of the run in its path');
    if (![...effect.ids, ...effect.parents].every(isCanonicalUuid)) refuse('a GET that persists something, with a path segment that is not a canonical uuid');
    const claims = new Claims(state, refuse);
    claims.targets(effect.ids.map((u, i) => ({ uuid: u.toLowerCase(), type: effect.types[i] })), 'a GET that persists something');
    await assertOwnAll(state, claims, helper, refuse);
}

async function checkMutation(checked: Checked): Promise<void> {
    const apiPath = checkMutationPath(checked);
    const m: Mutation = { ...checked, apiPath };
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

function checkMutationPath({ s, apiPath, refuse }: Checked): string {
    const structural = structuralPathProblem(s.sent);
    if (structural) refuse(`${structural}: the guard checks plain paths only`);
    if (!apiPath) refuse('a mutating request outside the ILM API is not allowed through the guarded context');
    return apiPath!;
}

/** 2b. A no-handler probe (guard/routes.ts NO_HANDLER_PROBES): bodyless, no query, own identity. True when the request is one and passed. */
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

function checkUuidSegments({ s, refuse }: Mutation): void {
    const segmentProblem = uuidSegmentProblem(s.sent.effective.pathname);
    if (segmentProblem) refuse(segmentProblem);
}

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
 * 4d. A step's `userUuid` equal to the caller's own user is not claimed (that
 * position only, same identity only). Returns the JSON the uuid scan reads.
 */
async function waiveSelfSteps({ state, method, apiPath, provenLocal }: Mutation, { view, json }: MutationBody, otherIdentity: boolean): Promise<unknown> {
    if (provenLocal || view.kind !== 'json' || otherIdentity || !isApprovalProfileWrite(method, apiPath)) return json;
    const named = stepUserUuids(json).filter((u) => !state.probes.has(u));
    const self = named.length ? await state.callerUuid() : undefined;
    return self && named.includes(self) ? withoutSelfSteps(json, self) : json;
}

/** 4. Every uuid the request names, as written and as decoded: non-canonical forms are refused here, canonical ones are claimed by rule 6. */
function findUuids({ s, method, apiPath, refuse }: Mutation, { view, json }: MutationBody, scanned: unknown, kind: PostKind): FoundUuids {
    const references = method !== 'DELETE';
    const findings: FoundUuids = { canonical: [], nonCanonical: [] };
    // Text the server does not read as JSON: every canonical uuid in it must be own, any other uuid-like token is refused.
    if (view.kind === 'text' || view.kind === 'plain') {
        merge(findings, findUuidsInString(view.text, { free: true }));
        merge(findings, findUuidsInString(unescapeJson(view.text), { free: true }));
    } else {
        merge(findings, kind === 'callback'
            ? findUuidsInBody(scanned, { references: false, scanAttributes: true, waivePaths: callbackWaivers(apiPath) })
            : findUuidsInBody(scanned, { references, waive: routeFieldWaivers(method, apiPath, json), waivePaths: routePathWaivers(method, apiPath, json) }));
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

function checkPlatformDeny({ apiPath, refuse, provenLocal }: Mutation, { json }: MutationBody): void {
    const platform = platformDenied(apiPath, json);
    if (platform && !provenLocal) refuse(`${platform} is platform-level: @local rows with localStack on a proven local stack only`);
}

interface OwnershipInput {
    body: MutationBody;
    kind: PostKind;
    findings: FoundUuids;
    otherIdentity: boolean;
}

/** 6. Ownership: every uuid the request names must be an own object of the right type (body associations first, then path targets). */
async function checkOwnership(m: Mutation, { body, kind, findings, otherIdentity }: OwnershipInput): Promise<void> {
    const { state, method, apiPath, helper, refuse } = m;
    const { view, json } = body;
    // Malformed-uuid probes name nothing, so rule 6a and the path-target rule are skipped; the body rules still apply.
    const malformed = malformedUuidProbe(method, apiPath);
    const named = malformed ? undefined : nameSegmentProblem(apiPath);
    if (named) refuse(named);
    const callbackParent = kind === 'callback' ? callbackParentOf(apiPath) : undefined;
    if (kind === 'callback') checkCallbackParent(m, callbackParent);
    const bodyUuids = callbackParent && callbackParent.kind !== 'tokenProfile' ? findings.canonical.filter((u) => u !== callbackParent.uuid) : findings.canonical;
    const claims = new Claims(state, refuse, bodyUuids, view.kind === 'text' || view.kind === 'plain');
    claims.fields(findings.typed ?? []);
    if (Array.isArray(json) && (kind === 'create' || pathTargets(apiPath).length > 0)) claims.list(method, apiPath, json);
    if (callbackParent?.kind === 'tokenProfile') claims.add(callbackParent.uuid, 'tokenProfiles', 'the callback names its token profile');
    const targets = kind !== 'create' && kind !== 'callback' ? claimTargets(m, claims, body, !!malformed) : [];
    const approvals = targets.filter((t) => t.type === 'approvals' && !state.probes.has(t.uuid)).map((t) => t.uuid);
    for (const approval of approvals) {
        const problem = approvalDecisionProblem(method, apiPath, view, otherIdentity);
        if (problem) refuse(problem, 'request', { uuid: approval });
    }
    await assertOwnAll(state, claims, helper, refuse);
    for (const approval of approvals) await assertOwnApprovalDecision(state, approval, helper, refuse);
}

/** Key paths of a callback body that may hold a non-own uuid: attribute definitions core resolves only among the path connector's own. */
const CALLBACK_WAIVERS: ReadonlyArray<readonly string[]> = [['uuid'], ['interfaceUuid'], ['attributes', LIST_ELEMENT, 'uuid']];

/** Callback waivers per route; the RA-profile form's `pathVariable.authorityId` is a connector-side id, so it may be a uuid there only. */
function callbackWaivers(apiPath: string): ReadonlyArray<readonly string[]> {
    return callbackParentOf(apiPath)?.kind === 'authority' ? [...CALLBACK_WAIVERS, ['pathVariable', 'authorityId']] : CALLBACK_WAIVERS;
}

function checkCallbackParent({ state, refuse }: Mutation, parent: ReturnType<typeof callbackParentOf>): void {
    if (!parent) refuse('an attribute callback on a path the guard does not know', 'request');
    if (parent!.kind === 'tokenProfile') return;
    if (!state.callbackTargets[parent!.kind].has(parent!.uuid)) {
        refuse(`an attribute callback on a ${parent!.kind} the preflight did not discover for this run (guard registerCallbackTarget)`, 'request', { uuid: parent!.uuid });
    }
}

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

function checkDryRun({ method, helper, state }: Mutation): void {
    if (method === 'DELETE') assertNotDryRun(helper, state.env);
}
