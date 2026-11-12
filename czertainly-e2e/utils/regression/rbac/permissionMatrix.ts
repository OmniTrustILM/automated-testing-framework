/**
 * permissionMatrix — the permission fixture roles and the answers each one must get (pure data).
 *
 * WHAT: Defines the fixture roles F0 to F6 as permission documents, the expected status of each certificate, RA-profile, role and user call
 * per fixture, the deny nuances, and the contract of an access-denied body.
 * WHY: A reader wants to read the decision table without the live code around it, and the table must stay rule-derived: a mismatch is a
 * finding to confirm, never an oracle to adjust.
 * HOW: Plain constants and pure functions; nothing here reads the environment or calls the server.
 */

import { PermissionDocument } from './authApi';
import { Profile } from './identities';


/** The fixture roles of the certificate and administration tables. F6 is a custom role derived from the `auditor` document. */
export type Fixture = 'F0' | 'F1' | 'F2' | 'F2b' | 'F3' | 'F4a' | 'F4b' | 'F4c' | 'F5' | 'F6';

export const FIXTURES: readonly Fixture[] = ['F0', 'F1', 'F2', 'F2b', 'F3', 'F4a', 'F4b', 'F4c', 'F5', 'F6'];

/** An object the documents name: uuid and display name of an OWN object (ledger line of this run). */
interface Named {
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
 * Certificate table — `GET /v1/certificates/{uuid}` per certificate (columns: F0 F1 F2 F2b F3 F4a F4b F4c F5 F6). A certificate in
 * a group and one with no RA profile share a row where the expected tables do (cg1 / cg12; cg2 / c3).
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
 * Certificate table — the rows of `POST /v1/certificates` the caller can see. `present` MUST be listed, `absent` MUST NOT; the
 * rest is not asserted. F4b / F5 leave c3, cg1, cg2 and cg12 unasserted on purpose: an open question the live test targets (an RA-profile
 * deny may hide certificates without an RA profile: `NOT IN (forbidden)` with a NULL column): API-AUTH-34.
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

/** Certificate table — what the profile reports beyond the defaults: extra listings, and the exact resource-level actions. */
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

/** Administration table — `GET /v1/raProfiles`: the rows seen (P1 / P2) or the refusal. */
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

/** Administration table — `GET /v1/raProfiles/{P1}`, `{P2}`, `POST /v1/authorities/{A}/raProfiles`, v2 issue on P1 / P2. */
export const MATRIX_B_RA_DETAIL_P1: Record<Fixture, Cell> = row(no, no, ok, ok, no, ok, ok, ok, ok, ok);
export const MATRIX_B_RA_DETAIL_P2: Record<Fixture, Cell> = row(no, no, dtRap, dtRap, no, dtRap, ok, ok, dtRap, ok);
export const MATRIX_B_RA_CREATE: Record<Fixture, Cell> = row(dtAuthority, dtAuthority, crRap, crRap, dtAuthority, crRap, crRap, crRap, ok, crRap);
export const MATRIX_B_ISSUE_P1: Record<Fixture, Cell> = row(no, no, ok, ok, no, no, no, no, ok, no);
export const MATRIX_B_ISSUE_P2: Record<Fixture, Cell> = row(no, no, no, no, no, no, no, no, no, no);

/** Administration table — administration: `GET /v1/roles`, `GET /v1/users`, `POST /v1/roles`, `GET /v1/users/{id}/permissions`. */
export const MATRIX_B_ROLES_LIST: Record<Fixture, Cell> = row(no, no, no, no, no, no, no, no, ok, ok);
export const MATRIX_B_USERS_LIST: Record<Fixture, Cell> = MATRIX_B_ROLES_LIST;
export const MATRIX_B_ROLE_CREATE: Record<Fixture, Cell> = row(no, no, no, no, no, no, no, no, ok, denied('Create', 'Role'));
export const MATRIX_B_USER_PERMISSIONS: Record<Fixture, Cell> = row(no, no, no, no, no, no, no, no, ok, ok);

/**
 * Administration table — fixtures whose nested-bean gate sample must answer 403 each, never a silent 2xx (F2, F2b, F5 are not asserted).
 */
export const NESTED_GATE_FIXTURES: readonly Fixture[] = ['F0', 'F1', 'F3', 'F4a', 'F4b', 'F4c', 'F6'];

/** API-AUTH-33 — the deny-per-action nuances. */
export const DENY_NUANCES: Record<'F4a' | 'F4b' | 'F4c', { p2Detail: Cell; certificatesOfP2: 'visible' | 'hidden'; p2InRaList: boolean }> = {
    F4a: { p2Detail: dtRap, certificatesOfP2: 'visible', p2InRaList: true },
    F4b: { p2Detail: ok, certificatesOfP2: 'hidden', p2InRaList: true },
    F4c: { p2Detail: ok, certificatesOfP2: 'visible', p2InRaList: false },
};


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

/** Which RA profile and groups each certificate of the table carries. */
export const CERT_PLAN: Record<CertKey, { ra?: 'p1' | 'p2'; groups: Array<'g1' | 'g2'> }> = {
    c1: { ra: 'p1', groups: [] },
    c2: { ra: 'p2', groups: [] },
    c3: { groups: [] },
    cg1: { groups: ['g1'] },
    cg2: { groups: ['g2'] },
    cg12: { groups: ['g1', 'g2'] },
};
