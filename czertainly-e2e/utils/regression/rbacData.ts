/**
 * rbacData — the objects the RBAC matrices act on, and the dedicated second identity's ILM user (auth-rbac area;
 * phase-05 `rbacData.ts` + the DED part of `identities.ts`).
 *
 * Data (plan §3.1, all created by the run, names run-prefixed, recorded in the ledger before any assertion, deleted by the
 * run-end teardown): two RA profiles P1 / P2 on the first healthy CA (own RA profiles under the pre-existing authority A:
 * a create under a pre-existing parent, decision R6-4), two groups G1 / G2, and six uploaded self-signed certificates c1…cg12
 * that are then given their RA profile / groups through `PATCH /v1/certificates/{uuid}` (the update-objects call; the
 * fallback "issue c1 / c2 through P1 / P2" is not used: it needs a CA round trip). Every `ensure*` finds an earlier
 * object of this run in the ledger first, so a repeated call (`--repeat-each`, several matrix tests) makes nothing new.
 *
 * DED: the matching ILM user of the dedicated identity-provider account. The suite creates it (DevOps request 2: "the suite
 * creates the matching ILM user itself and assigns that user's role on every run. It never touches other users"), ledgers it,
 * and changes ONLY that user. Its username is the account's, not run-prefixed, so the guard's name rule cannot recognise it
 * as this run's: that is guard request GR-3 (patches README). A DED user that exists already is never adopted here.
 */
import { APIRequestContext, expect } from '@playwright/test';
import { PermissionDocument, postUser, readPermissions, replaceOwnUserRoles, saveOwnPermissions, setOwnUserEnabled } from './authApi';
import { CERT_KEYS, CertKey, expectedResourceActions, Fixture, fixtureDocument, RbacRefs } from './rbacFixtures';
import { callAs, Credentials, parseProfile, Profile } from './identities';
import { GuardedApi } from './guardedApi';
import { selfSignedPem } from './pki';
import {
    apiJson, apiJsonWithDate, createRaProfileLike, enableOwnRaProfile, pickHealthyAuthority, RaProfileSourceMissing, recordDerivedKeyOf, requiredCustomAttributes, toRequestAttribute,
} from './regressionApi';
import { createdAfterFrom, OwnRef, readLedger, recordCreated, regName, RUN_ID } from './regressionRun';

type Json = Record<string, any>;

/** The newest `created` line of this run for a type and name that no later `deleted` line closed, as an OwnRef (or undefined). */
export function ledgerRef(type: string, name: string): OwnRef | undefined {
    let found: OwnRef | undefined;
    for (const l of readLedger()) {
        if (l.runId !== RUN_ID || l.type !== type || l.name !== name) continue;
        found = l.event === 'created' ? { uuid: l.uuid, name: l.name, kind: 'own' } : undefined;
    }
    return found;
}

/** The REQUIRED custom attributes of a resource a tier defines (a create without them answers 422 there), filled: the ONE shared filler. */
const requiredAttributes = (api: APIRequestContext, resource: string, value: string): Promise<Json[]> => requiredCustomAttributes(api, resource, value);

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

/** Which RA profile and groups each certificate of the table carries (plan §3.1). */
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
        const name = regName(`rbac-${key}`);
        const known = ledgerRef('raProfiles', name);
        if (known) return known;
        const ref = recordCreated('raProfiles', await createRaProfileLike(api, pick, name), spec, `RBAC fixture RA profile ${key.toUpperCase()}; connector attributes copied read-only`, { authority: pick.authorityUuid });
        await enableOwnRaProfile(api, pick.authorityUuid, ref);
        return ref;
    };
    const group = async (key: 'g1' | 'g2'): Promise<OwnRef> => {
        const name = regName(`rbac-${key}`);
        const known = ledgerRef('groups', name);
        if (known) return known;
        const created = await apiJson<Json>(api, 'POST', '/api/v1/groups', {
            name, description: `REG run ${RUN_ID}: RBAC fixture group ${key.toUpperCase()}`, customAttributes: await requiredAttributes(api, 'groups', regName('ca')),
        });
        return recordCreated('groups', { uuid: created.uuid, name }, spec, `RBAC fixture group ${key.toUpperCase()}`);
    };

    const p1 = await raProfile('p1');
    const p2 = await raProfile('p2');
    const g1 = await group('g1');
    const g2 = await group('g2');
    const refs = { p1, p2, g1, g2 };

    const certs = {} as Record<CertKey, OwnRef>;
    for (const key of CERT_KEYS) {
        const cn = regName(`rbac-${key}`);
        const known = ledgerRef('certificates', cn);
        if (known) {
            certs[key] = known;
            continue;
        }
        const { pem } = selfSignedPem(cn);
        const { body, serverAt, elapsedMs } = await apiJsonWithDate<Json>(api, 'POST', '/api/v1/certificates/upload', {
            certificate: Buffer.from(pem).toString('base64'),
            customAttributes: await requiredAttributes(api, 'certificates', regName('ca')),
        });
        certs[key] = recordCreated('certificates', { uuid: body.uuid, name: cn }, spec, `RBAC fixture certificate ${key} (self-signed upload)`);
        await recordDerivedKeyOf(api, body.uuid, serverAt ? createdAfterFrom(serverAt, elapsedMs) : undefined, spec);
        const plan = CERT_PLAN[key];
        if (plan.ra || plan.groups.length) {
            await apiJson(api, 'PATCH', `/api/v1/certificates/${body.uuid}`, {
                ...(plan.ra ? { raProfileUuid: refs[plan.ra].uuid } : {}),
                ...(plan.groups.length ? { groupUuids: plan.groups.map((g) => refs[g].uuid) } : {}),
            });
        }
    }
    return { authorityUuid: pick.authorityUuid, source: { uuid: pick.uuid, authorityUuid: pick.authorityUuid }, ...refs, certs };
}

/** The `auditor` system role's permission document, read live and rewritten as a plain document (F6, decision D4). */
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
    const name = regName(`rbac-${f.toLowerCase()}`);
    let role = ledgerRef('roles', name);
    if (!role) {
        const created = await apiJson<Json>(api, 'POST', '/api/v1/roles', { name, description: `REG run ${RUN_ID}: RBAC fixture ${f}`, customAttributes: await requiredCustomAttributes(api, 'roles', regName('ca')) });
        role = recordCreated('roles', { uuid: created.uuid, name }, spec, `RBAC fixture role ${f}`);
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
export async function ensureRestrictedUser(api: GuardedApi, spec: string, ded: Credentials): Promise<OwnRef> {
    const known = ledgerRef('users', ded.username);
    if (known) return known;
    const rows = (await apiJson<Json[]>(api, 'GET', '/api/v1/users')).filter((u) => String(u.username).toLowerCase() === ded.username.toLowerCase());
    if (rows.length) {
        // Never adopted by name (guard request GR-3 decides adoption, later and only under a safe condition): the row skips.
        throw new RestrictedUserNotOwn();
    }
    const made = await postUser(api, ded.username, { enabled: true });
    const uuid = made.json?.uuid ? String(made.json.uuid) : undefined;
    // Ledger before assertion, but ONLY after a 2xx answer that names the uuid (merge F3, guard pass GD-03): a `users` line
    // for the DED name makes the guard treat that user as own, so it is never written for a failed or speculative create.
    const created2xx = made.status >= 200 && made.status < 300;
    const ref = uuid && created2xx ? recordCreated('users', { uuid, name: ded.username }, spec, 'the dedicated second identity (DED): ILM user of the identity-provider account') : undefined;
    expect(made.status, `creating the DED user: ${made.text.slice(0, 300)}`).toBe(201);
    return ref!;
}

/** Enable / disable the dedicated ILM user as the admin (never the admin's own account: `setOwnUserEnabled` checks). */
export async function setRestrictedEnabled(api: GuardedApi, user: OwnRef, enabled: boolean): Promise<{ status: number; text: string }> {
    const r = await setOwnUserEnabled(api, user, enabled);
    return { status: r.status, text: r.text };
}

/**
 * `ensureRestrictedUser`, with a left-behind user as a named SKIP (Fable F5): `skip(reason)` is called with
 * RESTRICTED_USER_NOT_OWN_REASON (pass `(reason) => test.skip(true, reason)`); every other error propagates.
 */
export async function ensureRestrictedUserOrSkip(api: GuardedApi, spec: string, ded: Credentials, skip: (reason: string) => void): Promise<OwnRef> {
    try {
        return await ensureRestrictedUser(api, spec, ded);
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
    /** Poll DED's profile until it reflects the document (at most 30 s, 1 s steps): the role switch barrier (plan §0). */
    barrier(doc: PermissionDocument): Promise<Profile>;
    profile(): Promise<Profile | undefined>;
}

/**
 * The changes the admin makes to DED between matrix rows. After `PATCH /v1/users/{DED}/roles` the per-user authentication
 * cache is evicted (rule B4, `UMS:287`), so on ONE core instance the next request is decided with the new role; the barrier
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
    const detail = await apiJson<Json>(api, 'GET', `/api/v1/authorities/${source.authorityUuid}/raProfiles/${source.uuid}`);
    return {
        name,
        description: `REG run ${RUN_ID}: RBAC create probe`,
        attributes: (detail.attributes ?? []).filter((a: Json) => !a.type || a.type === 'data').map(toRequestAttribute),
        customAttributes: await requiredCustomAttributes(api, 'raProfiles', regName('ca')),
    };
}
