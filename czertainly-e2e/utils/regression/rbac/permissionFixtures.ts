/**
 * permissionFixtures — the RBAC decision table and the objects it acts on: the fixture roles F0…F6 as permission documents
 * and the expected answers of matrices A and B (rule-derived; a mismatch is a finding to confirm, never an adjusted oracle),
 * the own RA profiles, groups and certificates the documents name (created once per run, recorded before any assertion), and
 * the dedicated second identity's ILM user, which the suite creates, records and is the only user it changes.
 */
import { APIRequestContext, expect } from '@playwright/test';
import { PermissionDocument, postUser, readPermissions, replaceOwnUserRoles, saveOwnPermissions, setOwnUserEnabled } from './authApi';
import { callAs, Credentials, parseProfile, Profile } from './identities';
import { GuardedApi } from '../guard/types';
import { selfSignedPem } from '../pkiBuilders';
import { apiJson } from '../apiReads';
import { pickHealthyAuthority, RaProfileSourceMissing, createOwnRaProfileLike, raProfileBodyLike } from '../ownRaProfiles';
import { OwnRef, readLedger, recordCreated } from '../ledger/ledger';
import { runName, runId } from '../ledger/runState';
import { createOwnGroup } from '../ownGroups';
import { uploadOwnCertificate } from '../ownCertificates';
import { createRole } from '../ownRoles';

type Json = Record<string, any>;

// ------------------------------------------------------------------ the decision table (pure)

/** The fixture roles of matrices A and B. F6 is a custom role derived from the `auditor` document. */
export type Fixture = 'F0' | 'F1' | 'F2' | 'F2b' | 'F3' | 'F4a' | 'F4b' | 'F4c' | 'F5' | 'F6';

export const FIXTURES: readonly Fixture[] = ['F0', 'F1', 'F2', 'F2b', 'F3', 'F4a', 'F4b', 'F4c', 'F5', 'F6'];

/** An object the documents name: uuid and display name of an OWN object (ledger line of this run). */
export interface Named {
    uuid: string;
    name: string;
}

/** The own objects of the RBAC data table a document refers to. */
export interface RbacRefs {
    p1: Named;
    p2: Named;
    g1: Named;
    g2: Named;
}

const obj = (n: Named, allow: string[] = [], deny: string[] = []) => ({ uuid: n.uuid, name: n.name, allow, deny });

/**
 * The permission document of a fixture. `auditor` is the document of the system role `auditor`, read live
 * (API-AUTH-23 derives it): only F6 uses it.
 */
export function fixtureDocument(f: Fixture, refs: Partial<RbacRefs>, auditor?: PermissionDocument): PermissionDocument {
    // F0 / F1 / F6 name no object: a caller without the data table (REG-AUTH-08) passes `{}`.
    const need = <K extends keyof RbacRefs>(key: K): RbacRefs[K] => {
        const v = refs[key];
        if (!v) throw new Error(`fixture ${f} names ${String(key)}, which the caller did not provide`);
        return v;
    };
    const r = { get p1() { return need('p1'); }, get p2() { return need('p2'); }, get g1() { return need('g1'); }, get g2() { return need('g2'); } };
    const certificates = (actions: string[]) => ({ name: 'certificates', actions });
    const authorities = { name: 'authorities', actions: ['list', 'detail'] };
    switch (f) {
        case 'F0':
            return { allowAllResources: false, resources: [] };
        case 'F1':
            return { allowAllResources: false, resources: [certificates(['list', 'detail'])] };
        case 'F2':
            return { allowAllResources: false, resources: [certificates(['list', 'detail', 'create', 'issue']), { name: 'raProfiles', actions: ['list'], objects: [obj(r.p1, ['detail', 'members'])] }, authorities] };
        case 'F2b':
            return { allowAllResources: false, resources: [certificates(['list', 'detail', 'create', 'issue']), { name: 'raProfiles', actions: [], objects: [obj(r.p1, ['list', 'detail', 'members'])] }, authorities] };
        case 'F3':
            return { allowAllResources: false, resources: [{ name: 'groups', actions: [], objects: [obj(r.g1, ['members'])] }] };
        case 'F4a':
        case 'F4b':
        case 'F4c': {
            const deny = f === 'F4a' ? ['detail'] : f === 'F4b' ? ['members'] : ['list'];
            return { allowAllResources: false, resources: [{ name: 'raProfiles', actions: ['list', 'detail', 'members'], objects: [obj(r.p2, [], deny)] }, certificates(['list', 'detail']), authorities] };
        }
        case 'F5':
            return { allowAllResources: true, resources: [{ name: 'raProfiles', actions: [], objects: [obj(r.p2, [], ['detail', 'members'])] }] };
        case 'F6':
            if (!auditor) throw new Error('F6 is derived from the auditor document: pass it (read GET /v1/roles/{auditor}/permissions)');
            return auditor;
    }
}

// ------------------------------------------------------------------ expectations

/** The pair a 403 names: `Access Denied. Required '<action>' permission for '<resource>'` (rule G2). */
export interface Pair {
    action: string;
    resource: string;
}

/** A cell: 200 (allowed), 403 (refused, pair not pinned) or 403 with the pinned pair. */
export type Cell = 200 | 403 | { status: 403; pair: Pair };

const ok: Cell = 200;
const no: Cell = 403;
const denied = (action: string, resource: string): Cell => ({ status: 403, pair: { action, resource } });
const dtCert = denied('Detail', 'Certificate');
const mbRap = denied('Members', 'RA Profile');
const dtRap = denied('Detail', 'RA Profile');

export const cellStatus = (c: Cell): number => (typeof c === 'number' ? c : c.status);
export const cellPair = (c: Cell): Pair | undefined => (typeof c === 'number' ? undefined : c.pair);

const row = (...cells: Cell[]): Record<Fixture, Cell> => {
    if (cells.length !== FIXTURES.length) throw new Error(`a matrix row needs ${FIXTURES.length} cells, got ${cells.length}`);
    return Object.fromEntries(FIXTURES.map((f, i) => [f, cells[i]])) as Record<Fixture, Cell>;
};

/** The certificates of the data table: in RA profile P1 / P2; no RA profile; in group G1 / G2 / both. */
export type CertKey = 'c1' | 'c2' | 'c3' | 'cg1' | 'cg2' | 'cg12';
export const CERT_KEYS: readonly CertKey[] = ['c1', 'c2', 'c3', 'cg1', 'cg2', 'cg12'];

/**
 * Matrix A — `GET /v1/certificates/{uuid}` per certificate (columns: F0 F1 F2 F2b F3 F4a F4b F4c F5 F6). A certificate in
 * a group and one with no RA profile share a row where the expected matrices do (cg1 / cg12; cg2 / c3).
 */
export const MATRIX_A_DETAIL: Record<CertKey, Record<Fixture, Cell>> = {
    c1: row(dtCert, mbRap, ok, ok, dtCert, ok, ok, ok, ok, ok),
    c2: row(dtCert, mbRap, mbRap, mbRap, dtCert, ok, mbRap, ok, mbRap, ok),
    cg1: row(dtCert, mbRap, mbRap, mbRap, ok, ok, ok, ok, ok, ok),
    cg12: row(dtCert, mbRap, mbRap, mbRap, ok, ok, ok, ok, ok, ok),
    cg2: row(dtCert, mbRap, mbRap, mbRap, dtCert, ok, ok, ok, ok, ok),
    c3: row(dtCert, mbRap, mbRap, mbRap, dtCert, ok, ok, ok, ok, ok),
};

/**
 * Matrix A — the rows of `POST /v1/certificates` the caller can see. `present` MUST be listed, `absent` MUST NOT; the
 * rest is not asserted. F4b / F5 leave c3, cg1, cg2 and cg12 unasserted on purpose: that is hypothesis H-1 (an RA-profile
 * deny may hide certificates without an RA profile: `NOT IN (forbidden)` with a NULL column) — API-AUTH-34 targets it.
 */
export const MATRIX_A_LIST: Record<Fixture, { present: CertKey[]; absent: CertKey[] }> = {
    F0: { present: [], absent: [...CERT_KEYS] },
    F1: { present: [], absent: [...CERT_KEYS] },
    F2: { present: ['c1'], absent: ['c2', 'c3', 'cg1', 'cg2', 'cg12'] },
    F2b: { present: ['c1'], absent: ['c2', 'c3', 'cg1', 'cg2', 'cg12'] },
    F3: { present: ['cg1', 'cg12'], absent: ['c1', 'c2', 'c3', 'cg2'] },
    F4a: { present: [...CERT_KEYS], absent: [] },
    F4b: { present: ['c1'], absent: ['c2'] },
    F4c: { present: [...CERT_KEYS], absent: [] },
    F5: { present: ['c1'], absent: ['c2'] },
    F6: { present: [...CERT_KEYS], absent: [] },
};

/** Matrix A — what the profile reports beyond the defaults: extra listings, and the exact resource-level actions. */
export const MATRIX_A_PROFILE: Record<Fixture, { extraListings: string[] | 'all-listable'; actions: Record<string, string[]> | 'all' | 'read-only' }> = {
    F0: { extraListings: [], actions: {} },
    F1: { extraListings: [], actions: { certificates: ['detail', 'list'] } },
    F2: { extraListings: ['raProfiles', 'authorities'], actions: { certificates: ['create', 'detail', 'issue', 'list'], raProfiles: ['list'], authorities: ['detail', 'list'] } },
    F2b: { extraListings: ['raProfiles', 'authorities'], actions: { certificates: ['create', 'detail', 'issue', 'list'], authorities: ['detail', 'list'] } },
    F3: { extraListings: ['users'], actions: {} },
    F4a: { extraListings: ['raProfiles', 'authorities'], actions: { certificates: ['detail', 'list'], raProfiles: ['detail', 'list', 'members'], authorities: ['detail', 'list'] } },
    F4b: { extraListings: ['raProfiles', 'authorities'], actions: { certificates: ['detail', 'list'], raProfiles: ['detail', 'list', 'members'], authorities: ['detail', 'list'] } },
    F4c: { extraListings: ['raProfiles', 'authorities'], actions: { certificates: ['detail', 'list'], raProfiles: ['detail', 'list', 'members'], authorities: ['detail', 'list'] } },
    F5: { extraListings: 'all-listable', actions: 'all' },
    F6: { extraListings: 'all-listable', actions: 'read-only' },
};

const dtAuthority = denied('Detail', 'Authority');
const crRap = denied('Create', 'RA Profile');

/** Matrix B — `GET /v1/raProfiles`: the rows seen (P1 / P2) or the refusal. */
export type RaListCell = { status: 200; has: Array<'p1' | 'p2'>; lacks: Array<'p1' | 'p2'> } | { status: 403; pair: Pair };
const all: RaListCell = { status: 200, has: ['p1', 'p2'], lacks: [] };
export const MATRIX_B_RA_LIST: Record<Fixture, RaListCell> = {
    F0: { status: 403, pair: { action: 'List', resource: 'Authority' } },
    F1: { status: 403, pair: { action: 'List', resource: 'Authority' } },
    F2: all,
    F2b: { status: 200, has: ['p1'], lacks: ['p2'] },
    F3: { status: 403, pair: { action: 'List', resource: 'Authority' } },
    F4a: all,
    F4b: all,
    F4c: { status: 200, has: ['p1'], lacks: ['p2'] },
    F5: all,
    F6: all,
};

/** Matrix B — `GET /v1/raProfiles/{P1}`, `{P2}`, `POST /v1/authorities/{A}/raProfiles`, v2 issue on P1 / P2. */
export const MATRIX_B_RA_DETAIL_P1: Record<Fixture, Cell> = row(no, no, ok, ok, no, ok, ok, ok, ok, ok);
export const MATRIX_B_RA_DETAIL_P2: Record<Fixture, Cell> = row(no, no, dtRap, dtRap, no, dtRap, ok, ok, dtRap, ok);
export const MATRIX_B_RA_CREATE: Record<Fixture, Cell> = row(dtAuthority, dtAuthority, crRap, crRap, dtAuthority, crRap, crRap, crRap, ok, crRap);
export const MATRIX_B_ISSUE_P1: Record<Fixture, Cell> = row(no, no, ok, ok, no, no, no, no, ok, no);
export const MATRIX_B_ISSUE_P2: Record<Fixture, Cell> = row(no, no, no, no, no, no, no, no, no, no);

/** Matrix B — administration: `GET /v1/roles`, `GET /v1/users`, `POST /v1/roles`, `GET /v1/users/{id}/permissions`. */
export const MATRIX_B_ROLES_LIST: Record<Fixture, Cell> = row(no, no, no, no, no, no, no, no, ok, ok);
export const MATRIX_B_USERS_LIST: Record<Fixture, Cell> = MATRIX_B_ROLES_LIST;
export const MATRIX_B_ROLE_CREATE: Record<Fixture, Cell> = row(no, no, no, no, no, no, no, no, ok, denied('Create', 'Role'));
export const MATRIX_B_USER_PERMISSIONS: Record<Fixture, Cell> = row(no, no, no, no, no, no, no, no, ok, ok);

/** Matrix B — fixtures whose nested-bean gate sample must answer 403 each, never a silent 2xx (F2, F2b, F5 are not asserted). */
export const NESTED_GATE_FIXTURES: readonly Fixture[] = ['F0', 'F1', 'F3', 'F4a', 'F4b', 'F4c', 'F6'];

/** API-AUTH-33 — the deny-per-action nuances (AR-404). */
export const DENY_NUANCES: Record<'F4a' | 'F4b' | 'F4c', { p2Detail: Cell; certificatesOfP2: 'visible' | 'hidden'; p2InRaList: boolean }> = {
    F4a: { p2Detail: dtRap, certificatesOfP2: 'visible', p2InRaList: true },
    F4b: { p2Detail: ok, certificatesOfP2: 'hidden', p2InRaList: true },
    F4c: { p2Detail: ok, certificatesOfP2: 'visible', p2InRaList: false },
};

// ------------------------------------------------------------------ the 403 body

/** The contract of a 403 (rule G2): problem+json, `code: ACCESS_DENIED`, the pair in the message. */
export function accessDeniedProblems(contentType: string, json: any, pair: Pair | undefined): string[] {
    const problems: string[] = [];
    if (!/^application\/problem\+json/.test(contentType)) problems.push(`content type ${contentType || '(none)'}, expected application/problem+json`);
    if (!json || typeof json !== 'object') return [...problems, 'the body is not a JSON object'];
    if (json.code !== 'ACCESS_DENIED') problems.push(`code ${String(json.code)}, expected ACCESS_DENIED`);
    const message = String(json.message ?? '');
    if (!/^Access Denied\. Required '[^']+' permission for '[^']+'$/.test(message)) problems.push(`message "${message}" does not match "Access Denied. Required '<Action>' permission for '<Resource>'"`);
    if (pair && message !== `Access Denied. Required '${pair.action}' permission for '${pair.resource}'`) problems.push(`message "${message}", expected the pair ${pair.action} / ${pair.resource}`);
    return problems;
}

/**
 * The expected resource-level actions of a document (what `allowedActions` must report once the role is in force): the
 * resources a document names with actions, sorted — `allowAllResources` documents are not comparable this way.
 */
export function expectedResourceActions(doc: PermissionDocument): Record<string, string[]> | undefined {
    if (doc.allowAllResources) return undefined;
    const out: Record<string, string[]> = {};
    for (const r of doc.resources ?? []) if (r.actions?.length) out[r.name] = [...r.actions].sort();
    return out;
}

// ------------------------------------------------------------------ the objects and the restricted user

/** The newest `created` line of this run for a type and name that no later `deleted` line closed, as an OwnRef (or undefined). */
export function ledgerRef(type: string, name: string): OwnRef | undefined {
    let found: OwnRef | undefined;
    for (const l of readLedger()) {
        if (l.runId !== runId() || l.type !== type || l.name !== name) continue;
        found = l.event === 'created' ? { uuid: l.uuid, name: l.name, kind: 'own' } : undefined;
    }
    return found;
}

export interface RbacObjects extends RbacRefs {
    authorityUuid: string;
    /** The enabled RA profile of the authority whose connector attributes the fixture RA profiles copied (read-only). */
    source: { uuid: string; authorityUuid: string };
    p1: OwnRef;
    p2: OwnRef;
    g1: OwnRef;
    g2: OwnRef;
    certs: Record<CertKey, OwnRef>;
}

/** Which RA profile and groups each certificate of the table carries. */
export const CERT_PLAN: Record<CertKey, { ra?: 'p1' | 'p2'; groups: Array<'g1' | 'g2'> }> = {
    c1: { ra: 'p1', groups: [] },
    c2: { ra: 'p2', groups: [] },
    c3: { groups: [] },
    cg1: { groups: ['g1'] },
    cg2: { groups: ['g2'] },
    cg12: { groups: ['g1', 'g2'] },
};

/**
 * The run's RBAC objects (made once, found again through the ledger). Throws `RaProfileSourceMissing` when no healthy CA
 * has an enabled RA profile to copy: the caller skips with the named deploy gate, never a pass.
 */
export async function ensureRbacObjects(api: GuardedApi, spec: string): Promise<RbacObjects> {
    const pick = await pickHealthyAuthority(api);
    if ('skip' in pick) throw new RaProfileSourceMissing(pick.skip);

    const raProfile = async (key: 'p1' | 'p2'): Promise<OwnRef> => {
        const name = runName(`rbac-${key}`);
        const known = ledgerRef('raProfiles', name);
        if (known) return known;
        return createOwnRaProfileLike(api, spec, pick, name, `RBAC fixture RA profile ${key.toUpperCase()}; connector attributes copied read-only`);
    };
    const group = async (key: 'g1' | 'g2'): Promise<OwnRef> => {
        const name = runName(`rbac-${key}`);
        const known = ledgerRef('groups', name);
        if (known) return known;
        return createOwnGroup(api, spec, name, { description: `REG run ${runId()}: RBAC fixture group ${key.toUpperCase()}` }, `RBAC fixture group ${key.toUpperCase()}`);
    };

    const p1 = await raProfile('p1');
    const p2 = await raProfile('p2');
    const g1 = await group('g1');
    const g2 = await group('g2');
    const refs = { p1, p2, g1, g2 };

    const certs = {} as Record<CertKey, OwnRef>;
    for (const key of CERT_KEYS) {
        const cn = runName(`rbac-${key}`);
        const known = ledgerRef('certificates', cn);
        if (known) {
            certs[key] = known;
            continue;
        }
        const { pem } = selfSignedPem(cn);
        const uploaded = await uploadOwnCertificate(api, pem, cn, spec, `RBAC fixture certificate ${key} (self-signed upload)`);
        certs[key] = uploaded;
        const plan = CERT_PLAN[key];
        if (plan.ra || plan.groups.length) {
            await apiJson(api, 'PATCH', `/api/v1/certificates/${uploaded.uuid}`, {
                ...(plan.ra ? { raProfileUuid: refs[plan.ra].uuid } : {}),
                ...(plan.groups.length ? { groupUuids: plan.groups.map((g) => refs[g].uuid) } : {}),
            });
        }
    }
    return { authorityUuid: pick.authorityUuid, source: { uuid: pick.uuid, authorityUuid: pick.authorityUuid }, ...refs, certs };
}

/** The `auditor` system role's permission document, read live and rewritten as a plain document (the source of fixture F6). */
export async function auditorDocument(api: APIRequestContext): Promise<PermissionDocument> {
    const roles = await apiJson<Json[]>(api, 'GET', '/api/v1/roles');
    const auditor = roles.find((r) => r.name === 'auditor');
    if (!auditor) throw new Error('the auditor system role is not listed (API-AUTH-23 seeds it); F6 cannot be derived');
    const stored = await readPermissions(api, auditor.uuid);
    return {
        allowAllResources: false,
        resources: (stored.resources ?? []).map((r: Json) => ({ name: r.name, allowAllActions: r.allowAllActions === true, actions: [...(r.actions ?? [])] })),
    };
}

/** The own fixture role of a fixture (made once per run) with its permission document saved. */
export async function ensureFixtureRole(api: GuardedApi, f: Fixture, refs: Partial<RbacRefs>, spec: string, auditor?: PermissionDocument): Promise<{ role: OwnRef; doc: PermissionDocument }> {
    const name = runName(`rbac-${f.toLowerCase()}`);
    let role = ledgerRef('roles', name);
    if (!role) {
        role = recordCreated('roles', await createRole(api, name, { description: `REG run ${runId()}: RBAC fixture ${f}` }), spec, `RBAC fixture role ${f}`);
    }
    const doc = fixtureDocument(f, refs, auditor);
    const saved = await saveOwnPermissions(api, role, doc);
    expect(saved.status, `saving the permission document of ${f}: ${saved.text.slice(0, 300)}`).toBe(200);
    return { role, doc };
}

// ------------------------------------------------------------------ DED

/** The skip reason of every second-identity row when an earlier (aborted or kept) run left the dedicated ILM user behind. */
export const RESTRICTED_USER_NOT_OWN_REASON = 'dedicated test user exists but is not this run\'s — delete it or wait for the next clean run';

/** Thrown when the dedicated user exists but this run did not create it (the guard only lets a run act on its own). */
export class RestrictedUserNotOwn extends Error {
    constructor() {
        super(RESTRICTED_USER_NOT_OWN_REASON);
        this.name = 'RestrictedUserNotOwn';
    }
}

/**
 * The ILM user of the dedicated identity-provider account, created by this run (enabled, no role) and ledgered, or the one
 * an earlier call of this run created. A user of that name that this run did not create is NOT adopted (guard request
 * GR-3 decides adoption): the helper stops with the reason.
 */
export async function ensureRestrictedUser(api: GuardedApi, spec: string, dedicatedUser: Credentials): Promise<OwnRef> {
    const known = ledgerRef('users', dedicatedUser.username);
    if (known) return known;
    const rows = (await apiJson<Json[]>(api, 'GET', '/api/v1/users')).filter((u) => String(u.username).toLowerCase() === dedicatedUser.username.toLowerCase());
    if (rows.length) {
        // Never adopted by name (guard request GR-3 decides adoption, later and only under a safe condition): the row skips.
        throw new RestrictedUserNotOwn();
    }
    const made = await postUser(api, dedicatedUser.username, { enabled: true });
    const uuid = made.json?.uuid ? String(made.json.uuid) : undefined;
    // Ledger before assertion, but ONLY after a 2xx answer that names the uuid: a `users` line
    // for the DED name makes the guard treat that user as own, so it is never written for a failed or speculative create.
    const created2xx = made.status >= 200 && made.status < 300;
    const ref = uuid && created2xx ? recordCreated('users', { uuid, name: dedicatedUser.username }, spec, 'the dedicated second identity (DED): ILM user of the identity-provider account') : undefined;
    expect(made.status, `creating the DED user: ${made.text.slice(0, 300)}`).toBe(201);
    return ref!;
}

/** Enable / disable the dedicated ILM user as the admin (never the admin's own account: `setOwnUserEnabled` checks). */
export async function setRestrictedEnabled(api: GuardedApi, user: OwnRef, enabled: boolean): Promise<{ status: number; text: string }> {
    const r = await setOwnUserEnabled(api, user, enabled);
    return { status: r.status, text: r.text };
}

/**
 * `ensureRestrictedUser`, with a left-behind user as a named SKIP: `skip(reason)` is called with
 * RESTRICTED_USER_NOT_OWN_REASON (pass `(reason) => test.skip(true, reason)`); every other error propagates.
 */
export async function ensureRestrictedUserOrSkip(api: GuardedApi, spec: string, dedicatedUser: Credentials, skip: (reason: string) => void): Promise<OwnRef> {
    try {
        return await ensureRestrictedUser(api, spec, dedicatedUser);
    } catch (e) {
        if (e instanceof RestrictedUserNotOwn) skip(e.message);
        throw e;
    }
}

/** The profile of the identity that owns `token`, `undefined` while it is refused. */
async function profileAs(api: GuardedApi, token: string): Promise<Profile | undefined> {
    const res = await callAs(api, token, 'GET', '/api/v1/auth/profile');
    return res.status === 200 ? parseProfile(res.json) : undefined;
}

export interface RoleSwitch {
    setRoles(roles: OwnRef[]): Promise<void>;
    setEnabled(enabled: boolean): Promise<{ status: number; text: string }>;
    /** Poll DED's profile until it reflects the document (at most 30 s, 1 s steps): the role switch barrier. */
    barrier(doc: PermissionDocument): Promise<Profile>;
    profile(): Promise<Profile | undefined>;
}

/**
 * The changes the admin makes to DED between matrix rows. After `PATCH /v1/users/{DED}/roles` the per-user authentication
 * cache is evicted (`UMS:287`), so on ONE core instance the next request is decided with the new role; the barrier
 * only waits for that, asserts nothing else, and fails with a cache-window message rather than retrying a status.
 */
export function restrictedRoleSwitch(api: GuardedApi, user: OwnRef, token: string): RoleSwitch {
    return {
        async setRoles(roles) {
            const r = await replaceOwnUserRoles(api, user, roles);
            expect(r.status, `assigning the fixture role to DED: ${r.text.slice(0, 300)}`).toBe(200);
        },
        setEnabled: (enabled) => setRestrictedEnabled(api, user, enabled),
        async barrier(doc) {
            const want = expectedResourceActions(doc);
            let last: Profile | undefined;
            await expect
                .poll(
                    async () => {
                        last = await profileAs(api, token);
                        if (!last) return 'profile refused';
                        const got = Object.fromEntries(last.allowedActions.map((a) => [a.resource, [...a.actions].sort()]));
                        // An allow-all document reports every resource: compare only a resource the fixture always names.
                        if (!want) return got.certificates?.includes('list') ? 'in force' : 'allow-all not yet in force';
                        const norm = (o: Record<string, string[]>): string => JSON.stringify(Object.keys(o).sort().map((k) => [k, o[k]]));
                        return norm(got) === norm(want) ? 'in force' : 'role not yet in force';
                    },
                    { timeout: 30_000, intervals: [1_000], message: 'DED\'s profile does not reflect the fixture role within the cache window (one core replica? SYNC_POLICY=create-only? core#2226)' },
                )
                .toBe('in force');
            return last!;
        },
        profile: () => profileAs(api, token),
    };
}

/** Make a fixture role (document saved), give it to DED as the ONLY role and wait until it is in force; returns the role too. */
export async function applyFixtureWithRole(api: GuardedApi, sw: RoleSwitch, f: Fixture, refs: Partial<RbacRefs>, spec: string, auditor?: PermissionDocument): Promise<{ role: OwnRef; doc: PermissionDocument }> {
    const made = await ensureFixtureRole(api, f, refs, spec, auditor);
    await sw.setRoles([made.role]);
    await sw.barrier(made.doc);
    return made;
}

/** `applyFixtureWithRole`, returning only the document. */
export async function applyFixture(api: GuardedApi, sw: RoleSwitch, f: Fixture, refs: Partial<RbacRefs>, spec: string, auditor?: PermissionDocument): Promise<PermissionDocument> {
    return (await applyFixtureWithRole(api, sw, f, refs, spec, auditor)).doc;
}

// ------------------------------------------------------------------ one request body per create the matrix sends as DED

/**
 * The body `POST /v1/authorities/{A}/raProfiles` takes for a new RA profile whose connector attributes are copied (read-only)
 * from an enabled RA profile of the authority — what `createRaProfileLike` posts, without posting: the matrix sends it AS
 * DED (a 403 for every fixture but F5; F5's 200 is a create under a pre-existing authority, recorded by the caller).
 */
export async function raProfileCreateBody(api: APIRequestContext, source: { uuid: string; authorityUuid: string }, name: string): Promise<Json> {
    return raProfileBodyLike(api, source, name, `REG run ${runId()}: RBAC create probe`);
}
