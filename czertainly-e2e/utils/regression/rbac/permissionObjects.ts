/**
 * permissionObjects — the own objects the permission table acts on and the dedicated second identity: RA profiles, groups,
 * certificates and the restricted user, created once per run (recorded before any assertion) and found again through the ledger.
 */

import { APIRequestContext, expect } from '@playwright/test';
import { listAll, PermissionDocument, readPermissions, replaceOwnUserRoles, saveOwnPermissions, setOwnUserEnabled } from './authApi';
import { callAs, Credentials, parseProfile, Profile } from './identities';
import { GuardedApi } from '../guard/types';
import { selfSignedPem } from '../pkiBuilders';
import { apiJson } from '../apiReads';
import { pickHealthyAuthority, RaProfileSourceMissing, createOwnRaProfileLike, raProfileBodyLike } from '../ownRaProfiles';
import { OwnRef, readLedger } from '../ledger/ledger';
import { runName, runId } from '../ledger/runState';
import { createOwnGroup, groupUuidsOf } from '../ownGroups';
import { uploadOwnCertificate } from '../ownCertificates';
import { createOwnRole } from '../ownRoles';
import { createOwn } from '../ownCrud';
import { userBody } from '../ownUsers';
import type { JsonObject } from '../json';
import { rowsOf } from '../json';
import { Fixture, RbacRefs, fixtureDocument, CertKey, CERT_KEYS, expectedResourceActions, CERT_PLAN } from './permissionMatrix';


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
    source: { uuid: string; authorityUuid: string };
    p1: OwnRef;
    p2: OwnRef;
    g1: OwnRef;
    g2: OwnRef;
    certs: Record<CertKey, OwnRef>;
}

/**
 * The run's RBAC objects (made once, found again through the ledger); throws `RaProfileSourceMissing` when no healthy CA has an enabled RA
 * profile to copy.
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
        const cert = known ?? await uploadOwnCertificate(api, selfSignedPem(cn).pem, cn, spec, `RBAC fixture certificate ${key} (self-signed upload)`);
        certs[key] = cert;
        const plan = CERT_PLAN[key];
        if (!plan.ra && !plan.groups.length) continue;
        const ra = plan.ra ? refs[plan.ra].uuid : undefined;
        const groups = plan.groups.map((g) => refs[g].uuid);
        // A certificate found again keeps its plan only if the earlier PATCH landed; otherwise the permission rows must not run.
        if (known) {
            const live = await apiJson<JsonObject>(api, 'GET', `/api/v1/certificates/${cert.uuid}`);
            const liveRa = (live.raProfile as JsonObject | undefined)?.uuid;
            if ((!ra || liveRa === ra) && (!groups.length || groupUuidsOf(live).join() === [...groups].sort().join())) continue;
        }
        await apiJson(api, 'PATCH', `/api/v1/certificates/${cert.uuid}`, { ...(ra ? { raProfileUuid: ra } : {}), ...(groups.length ? { groupUuids: groups } : {}) });
    }
    return { authorityUuid: pick.authorityUuid, source: { uuid: pick.uuid, authorityUuid: pick.authorityUuid }, ...refs, certs };
}

export async function auditorDocument(api: APIRequestContext): Promise<PermissionDocument> {
    const roles = await listAll(api, 'roles');
    const auditor = roles.find((r) => r.name === 'auditor');
    if (!auditor) throw new Error('the auditor system role is not listed (API-AUTH-23 seeds it); F6 cannot be derived');
    const stored = await readPermissions(api, String(auditor.uuid));
    return {
        allowAllResources: false,
        resources: rowsOf(stored.resources).map((r) => ({ name: String(r.name), allowAllActions: r.allowAllActions === true, actions: [...((r.actions ?? []) as string[])] })),
    };
}

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


export const RESTRICTED_USER_NOT_OWN_REASON = 'dedicated test user exists but is not this run\'s — delete it or wait for the next clean run';

export class RestrictedUserNotOwn extends Error {
    constructor() {
        super(RESTRICTED_USER_NOT_OWN_REASON);
        this.name = 'RestrictedUserNotOwn';
    }
}

/**
 * The ILM user of the dedicated account, created by this run (enabled, no role) or found again; a user of that name this run did not create
 * is never adopted.
 */
export async function ensureRestrictedUser(api: GuardedApi, spec: string, dedicatedUser: Credentials): Promise<OwnRef> {
    const known = ledgerRef('users', dedicatedUser.username);
    if (known) return known;
    const rows = (await listAll(api, 'users')).filter((u) => String(u.username).toLowerCase() === dedicatedUser.username.toLowerCase());
    if (rows.length) {
        throw new RestrictedUserNotOwn();
    }
    // Ledgered only after a 2xx answer that names the uuid: a `users` line for that name makes the guard treat the user as own.
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

export async function setRestrictedEnabled(api: GuardedApi, user: OwnRef, enabled: boolean): Promise<{ status: number; text: string }> {
    const r = await setOwnUserEnabled(api, user, enabled);
    return { status: r.status, text: r.text };
}

/** `ensureRestrictedUser`, with a left-behind user as a named skip: `skip(reason)` gets RESTRICTED_USER_NOT_OWN_REASON. */
export async function ensureRestrictedUserOrSkip(api: GuardedApi, spec: string, dedicatedUser: Credentials, skip: (reason: string) => void): Promise<OwnRef> {
    try {
        return await ensureRestrictedUser(api, spec, dedicatedUser);
    } catch (e) {
        if (e instanceof RestrictedUserNotOwn) skip(e.message);
        throw e;
    }
}

async function profileAs(api: GuardedApi, token: string): Promise<Profile | undefined> {
    const res = await callAs(api, token, 'GET', '/api/v1/auth/profile');
    return res.status === 200 ? parseProfile(res.json) : undefined;
}

export interface RoleSwitch {
    setRoles(roles: OwnRef[]): Promise<void>;
    setEnabled(enabled: boolean): Promise<{ status: number; text: string }>;
    barrier(doc: PermissionDocument): Promise<Profile>;
    profile(): Promise<Profile | undefined>;
}

/**
 * The changes the admin makes to the restricted user between matrix rows; the barrier waits for the new role to apply on one core instance
 * and asserts nothing else.
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

export async function applyFixtureWithRole(api: GuardedApi, sw: RoleSwitch, f: Fixture, refs: Partial<RbacRefs>, spec: string, auditor?: PermissionDocument): Promise<{ role: OwnRef; doc: PermissionDocument }> {
    const made = await ensureFixtureRole(api, f, refs, spec, auditor);
    await sw.setRoles([made.role]);
    await sw.barrier(made.doc);
    return made;
}

export async function applyFixture(api: GuardedApi, sw: RoleSwitch, f: Fixture, refs: Partial<RbacRefs>, spec: string, auditor?: PermissionDocument): Promise<PermissionDocument> {
    return (await applyFixtureWithRole(api, sw, f, refs, spec, auditor)).doc;
}


/**
 * The body `POST /v1/authorities/{A}/raProfiles` takes for an RA profile whose connector attributes are copied from an enabled one, without
 * posting it: the matrix sends it as the restricted user.
 */
export async function raProfileCreateBody(api: APIRequestContext, source: { uuid: string; authorityUuid: string }, name: string): Promise<JsonObject> {
    return raProfileBodyLike(api, source, name, `REG run ${runId()}: RBAC create probe`);
}
