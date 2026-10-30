/**
 * permissionObjects — the own objects the permission table acts on, and the dedicated second identity.
 *
 * Creates once per run (create-only, recorded before any assertion) the RA profiles, groups and certificates the fixture
 * documents name, creates the dedicated restricted ILM user, and applies a fixture role to it through a role switch. The
 * restricted user is the only user the suite changes. Objects are found again through the ledger, so a repeat creates nothing;
 * a restricted user that exists but is not this run's makes the caller skip with a named reason.
 */

import { APIRequestContext, expect } from '@playwright/test';
import { PermissionDocument, readPermissions, replaceOwnUserRoles, saveOwnPermissions, setOwnUserEnabled } from './authApi';
import { callAs, Credentials, parseProfile, Profile } from './identities';
import { GuardedApi } from '../guard/types';
import { selfSignedPem } from '../pkiBuilders';
import { apiJson } from '../apiReads';
import { pickHealthyAuthority, RaProfileSourceMissing, createOwnRaProfileLike, raProfileBodyLike } from '../ownRaProfiles';
import { OwnRef, readLedger } from '../ledger/ledger';
import { runName, runId } from '../ledger/runState';
import { createOwnGroup } from '../ownGroups';
import { uploadOwnCertificate } from '../ownCertificates';
import { createOwnRole } from '../ownRoles';
import { createOwn } from '../ownCrud';
import { userBody } from '../ownUsers';
import type { JsonObject } from '../json';
import { rowsOf } from '../json';
import { Fixture, RbacRefs, fixtureDocument, CertKey, CERT_KEYS, expectedResourceActions, CERT_PLAN } from './permissionMatrix';


/** The newest `created` line of this run for a type and name that no later `deleted` line closed, as an OwnRef (or undefined). */
function ledgerRef(type: string, name: string): OwnRef | undefined {
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
        return createOwnRaProfileLike(api, spec, 'ra', { source: pick, name, note: `RBAC fixture RA profile ${key.toUpperCase()}; connector attributes copied read-only` });
    };
    const group = async (key: 'g1' | 'g2'): Promise<OwnRef> => {
        const name = runName(`rbac-${key}`);
        const known = ledgerRef('groups', name);
        if (known) return known;
        return createOwnGroup(api, spec, 'grp', { name, description: `REG run ${runId()}: RBAC fixture group ${key.toUpperCase()}`, note: `RBAC fixture group ${key.toUpperCase()}` });
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
    const roles = await apiJson<JsonObject[]>(api, 'GET', '/api/v1/roles');
    const auditor = roles.find((r) => r.name === 'auditor');
    if (!auditor) throw new Error('the auditor system role is not listed (API-AUTH-23 seeds it); F6 cannot be derived');
    const stored = await readPermissions(api, String(auditor.uuid));
    return {
        allowAllResources: false,
        resources: rowsOf(stored.resources).map((r) => ({ name: String(r.name), allowAllActions: r.allowAllActions === true, actions: [...((r.actions ?? []) as string[])] })),
    };
}

/** The own fixture role of a fixture (made once per run) with its permission document saved. */
async function ensureFixtureRole(api: GuardedApi, f: Fixture, refs: Partial<RbacRefs>, spec: string, auditor?: PermissionDocument): Promise<{ role: OwnRef; doc: PermissionDocument }> {
    const name = runName(`rbac-${f.toLowerCase()}`);
    let role = ledgerRef('roles', name);
    if (!role) {
        role = await createOwnRole(api, spec, 'rbac', { name, description: `REG run ${runId()}: RBAC fixture ${f}`, note: `RBAC fixture role ${f}` });
    }
    const doc = fixtureDocument(f, refs, auditor);
    const saved = await saveOwnPermissions(api, role, doc);
    expect(saved.status, `saving the permission document of ${f}: ${saved.text.slice(0, 300)}`).toBe(200);
    return { role, doc };
}


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
    const rows = (await apiJson<JsonObject[]>(api, 'GET', '/api/v1/users')).filter((u) => String(u.username).toLowerCase() === dedicatedUser.username.toLowerCase());
    if (rows.length) {
        // Never adopted by name (guard request GR-3 decides adoption, later and only under a safe condition): the row skips.
        throw new RestrictedUserNotOwn();
    }
    // Ledger before assertion, but ONLY after a 2xx answer that names the uuid (createOwn): a `users` line for the DED
    // name makes the guard treat that user as own, so it is never written for a failed or speculative create.
    const created = await createOwn(api, spec, {
        type: 'users',
        path: '/api/v1/users',
        name: dedicatedUser.username,
        nameField: 'username',
        note: 'the dedicated second identity (DED): ILM user of the identity-provider account',
        body: await userBody(api, dedicatedUser.username, { enabled: true, description: 'REG run (API-AUTH probe)' }),
    }).catch((e: unknown) => {
        throw new Error(`creating the DED user: ${e instanceof Error ? e.message : String(e)}`);
    });
    const { answer, ...ref } = created;
    expect(answer.status, `creating the DED user: ${answer.text.slice(0, 300)}`).toBe(201);
    return ref;
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


/**
 * The body `POST /v1/authorities/{A}/raProfiles` takes for a new RA profile whose connector attributes are copied (read-only)
 * from an enabled RA profile of the authority — what `createOwnRaProfileLike` posts, without posting: the matrix sends it AS
 * DED (a 403 for every fixture but F5; F5's 200 is a create under a pre-existing authority, recorded by the caller).
 */
export async function raProfileCreateBody(api: APIRequestContext, source: { uuid: string; authorityUuid: string }, name: string): Promise<JsonObject> {
    return raProfileBodyLike(api, source, name, `REG run ${runId()}: RBAC create probe`);
}
