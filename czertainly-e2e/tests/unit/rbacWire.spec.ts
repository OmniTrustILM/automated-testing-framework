/**
 * The rbac/ helpers on the wire: the real guard and a real APIRequestContext against a stateful loopback fake core. Users
 * and roles (authApi; deletes proven by the list, foreign objects refused before sending), `callAs` (the other identity's
 * token on that request only), the dedicated user, the role switch and the barrier, and the RBAC objects (permissionObjects).
 */
import { APIRequestContext, expect, test } from '@playwright/test';
import * as forge from 'node-forge';
import { probeRole, probeUser, replaceOwnRoleUsers, replaceOwnUserRoles, roleUserUuids, saveOwnPermissions, setOwnUserEnabled, updateOwnRole, updateOwnUser, userRoleUuids, addOwnUserRole, removeOwnUserRole, readPermissions, deleteOwnUserOrRole } from '../../utils/regression/rbac/authApi';
import { usersOrRolesNamed } from '../../utils/regression/listReads';
import { GuardedApi } from '../../utils/regression/guard/types';
import { callAs, callWithAuthorization } from '../../utils/regression/rbac/identities';
import { OwnObjectViolation } from '../../utils/regression/ledger/ownership';
import { applyFixture, applyFixtureWithRole, ensureRbacObjects, ensureRestrictedUser, ensureRestrictedUserOrSkip, RESTRICTED_USER_NOT_OWN_REASON, RestrictedUserNotOwn, restrictedRoleSwitch } from '../../utils/regression/rbac/permissionObjects';
import { createOwnRole } from '../../utils/regression/ownRoles';
import { createOwnUser } from '../../utils/regression/ownUsers';
import { RaProfileSourceMissing } from '../../utils/regression/ownRaProfiles';
import { OwnRef, readLedger, recordCreated } from '../../utils/regression/ledger/ledger';
import { runName } from '../../utils/regression/ledger/runState';
import { Answer, Arrived, LoopbackServer } from './helpers/loopbackServer';
import { FakeCore as BaseCore } from './helpers/fakeCore';
import { registerFakeCore, rawAsGuarded } from './helpers/guardRig';
import { randomBytes } from 'node:crypto';
// Run-scoped generated test passwords (merge follow-up 2026-10-15): no password-like literal in the file.
const GEN_PW_1 = `qa-${randomBytes(9).toString('base64url')}`;
const GEN_PW_2 = `qa-${randomBytes(9).toString('base64url')}`;

type Json = Record<string, any>;
const U = (n: number) => `00000000-0000-4000-8000-${String(n).padStart(12, '0')}`;
const ADM_UUID = U(900);
const C_EJBCA = U(2);
const A_EJBCA = U(12);
const R_SRC = U(21);
const SYSTEM_ROLE = U(31);
const FOREIGN_USER = U(32);

class AuthCore extends BaseCore {
    protected uuidPrefix = 'bbbbbbbb-0000-4000-8000-';
    users = new Map<string, Json>();
    roles = new Map<string, Json>();
    groups = new Map<string, Json>();
    raProfiles = new Map<string, Json>();
    certs = new Map<string, Json>();
    protected seq = 1000;
    /** The CA is healthy and has an enabled RA profile to copy. */
    caHealthy = true;
    /** What `POST /users` answers for a username that exists (the known bug core#2297 answers 500). */
    duplicateStatus = 500;
    /** Merge F3: `POST /users` answers this non-2xx status WITH a uuid in the body and creates nothing. */
    failCreateWithUuid: number | undefined;
    /** The username whose bearer is `DED-TOKEN` (the dedicated identity-provider account). */
    dedicatedUsername = 'qa-restricted-account';

    constructor() {
        super();
        this.roles.set(SYSTEM_ROLE, { uuid: SYSTEM_ROLE, name: 'admin', systemRole: true, permissions: { allowAllResources: true, resources: [] } });
        this.users.set(FOREIGN_USER, { uuid: FOREIGN_USER, username: 'someone-else', enabled: true, roles: [] });
    }

    /** The profile of the identity behind the bearer: the admin, or the DED user computed from the roles it holds. */
    private profile(auth: string | undefined): Answer {
        if (auth === 'Bearer ADM-TOKEN') {
            return { status: 200, body: { uuid: ADM_UUID, username: 'admin-test', enabled: true, roles: [], permissions: { allowedListings: ['approvals', 'certificates', 'dashboard'], allowedActions: [] } } };
        }
        if (auth === 'Bearer DED-TOKEN') {
            const dedicatedUser = [...this.users.values()].find((u) => u.username === this.dedicatedUsername);
            if (!dedicatedUser || dedicatedUser.enabled === false) return { status: 401, body: { message: 'Unauthorized' } };
            const resources = new Map<string, Set<string>>();
            for (const roleUuid of dedicatedUser.roles as string[]) {
                for (const r of this.roles.get(roleUuid)?.permissions?.resources ?? []) {
                    const set = resources.get(r.name) ?? new Set<string>();
                    for (const a of r.actions ?? []) set.add(a);
                    resources.set(r.name, set);
                }
            }
            const allowedActions = [...resources.entries()].filter(([, s]) => s.size).sort(([a], [b]) => (a < b ? -1 : 1)).map(([resource, s]) => ({ resource, actions: [...s].sort() }));
            return { status: 200, body: { uuid: dedicatedUser.uuid, username: dedicatedUser.username, enabled: true, roles: [], permissions: { allowedListings: ['approvals', 'dashboard'], allowedActions } } };
        }
        return { status: 401, body: { message: 'Unauthorized' } };
    }

    protected respond(a: Arrived): Answer | undefined {
        const [path] = a.url.split('?');
        const body: Json = a.body ? JSON.parse(a.body) : {};
        const auth = a.headers.authorization as string | undefined;
        let m: RegExpExecArray | null;
        if (path === '/api/v1/auth/profile') return this.profile(auth);

        // ---- users
        if (path === '/api/v1/users' && a.method === 'GET') return { status: 200, body: [...this.users.values()].map((u) => ({ uuid: u.uuid, username: u.username, enabled: u.enabled })) };
        if (path === '/api/v1/users' && a.method === 'POST') {
            if (this.failCreateWithUuid !== undefined) return { status: this.failCreateWithUuid, body: { uuid: this.next(), message: 'refused' } };
            if ([...this.users.values()].some((u) => u.username === body.username)) return { status: this.duplicateStatus, body: { message: 'Internal server error.' } };
            const uuid = this.next();
            this.users.set(uuid, { uuid, username: body.username, enabled: body.enabled === true, roles: [], firstName: body.firstName });
            return { status: 201, body: { uuid, username: body.username } };
        }
        if ((m = /^\/api\/v1\/users\/([0-9a-f-]{36})$/.exec(path))) {
            const u = this.users.get(m[1]);
            if (!u) return { status: 500, body: { message: 'Internal server error.' } }; // core#2511
            if (a.method === 'GET') return { status: 200, body: { ...u, roles: u.roles.map((r: string) => ({ uuid: r, name: this.roles.get(r)?.name })) } };
            if (a.method === 'PUT') {
                Object.assign(u, { firstName: body.firstName ?? u.firstName, lastName: body.lastName ?? u.lastName, email: body.email ?? u.email });
                return { status: 200, body: u };
            }
            if (a.method === 'DELETE') {
                this.users.delete(m[1]);
                return { status: 204 };
            }
        }
        if ((m = /^\/api\/v1\/users\/([0-9a-f-]{36})\/(enable|disable)$/.exec(path))) {
            const u = this.users.get(m[1]);
            if (!u) return { status: 500, body: { message: 'Internal server error.' } };
            u.enabled = m[2] === 'enable';
            return { status: 200, body: { ...u } };
        }
        if ((m = /^\/api\/v1\/users\/([0-9a-f-]{36})\/roles$/.exec(path))) {
            const u = this.users.get(m[1]);
            if (!u) return { status: 500, body: { message: 'Internal server error.' } };
            if (a.method === 'PATCH') u.roles = [...new Set<string>(Object.values<string>(body))];
            return { status: 200, body: a.method === 'GET' ? u.roles.map((r: string) => ({ uuid: r, name: this.roles.get(r)?.name })) : { ...u } };
        }
        if ((m = /^\/api\/v1\/users\/([0-9a-f-]{36})\/roles\/([0-9a-f-]{36})$/.exec(path))) {
            const u = this.users.get(m[1]);
            if (!u) return { status: 500, body: { message: 'Internal server error.' } };
            u.roles = a.method === 'PUT' ? [...new Set<string>([...u.roles, m[2]])] : u.roles.filter((r: string) => r !== m![2]);
            return { status: 200, body: { ...u } };
        }

        // ---- roles
        if (path === '/api/v1/roles' && a.method === 'GET') return { status: 200, body: [...this.roles.values()].map((r) => ({ uuid: r.uuid, name: r.name })) };
        if (path === '/api/v1/roles' && a.method === 'POST') {
            if ([...this.roles.values()].some((r) => r.name === body.name)) return { status: 500, body: { message: 'Internal server error.' } };
            const uuid = this.next();
            this.roles.set(uuid, { uuid, name: body.name, description: body.description, email: body.email, permissions: { allowAllResources: false, resources: [] } });
            return { status: 201, body: { uuid, name: body.name } };
        }
        if ((m = /^\/api\/v1\/roles\/([0-9a-f-]{36})$/.exec(path))) {
            const r = this.roles.get(m[1]);
            if (!r) return { status: 500, body: { message: 'Internal server error.' } };
            if (a.method === 'GET') return { status: 200, body: { ...r, users: [...this.users.values()].filter((u) => u.roles.includes(r.uuid)).map((u) => ({ uuid: u.uuid, username: u.username })) } };
            if (a.method === 'PUT') {
                Object.assign(r, { description: body.description ?? r.description, email: body.email ?? r.email }); // the name never changes
                return { status: 200, body: { ...r } };
            }
            if (a.method === 'DELETE') {
                this.roles.delete(m[1]);
                for (const u of this.users.values()) u.roles = u.roles.filter((x: string) => x !== m![1]);
                return { status: 204 };
            }
        }
        if ((m = /^\/api\/v1\/roles\/([0-9a-f-]{36})\/users$/.exec(path))) {
            const r = this.roles.get(m[1]);
            if (!r) return { status: 500, body: { message: 'Internal server error.' } };
            if (a.method === 'PATCH') for (const u of this.users.values()) u.roles = (body as string[]).includes(u.uuid) ? [...new Set<string>([...u.roles, r.uuid])] : u.roles.filter((x: string) => x !== r.uuid);
            return { status: 200, body: a.method === 'GET' ? [...this.users.values()].filter((u) => u.roles.includes(r.uuid)).map((u) => ({ uuid: u.uuid, username: u.username })) : { ...r } };
        }
        if ((m = /^\/api\/v1\/roles\/([0-9a-f-]{36})\/permissions$/.exec(path))) {
            const r = this.roles.get(m[1]);
            if (!r) return { status: 500, body: { message: 'Internal server error.' } };
            if (a.method === 'POST') r.permissions = body;
            return { status: 200, body: r.permissions };
        }

        // ---- the RBAC data table
        if (path === '/api/v1/attributes/custom/resources/users' || /^\/api\/v1\/attributes\/custom\/resources\/(roles|raProfiles|certificates|groups)$/.test(path)) return { status: 200, body: [] };
        if (path === '/api/v1/connectors') return { status: 200, body: [{ uuid: C_EJBCA, name: 'EJBCA-NG-Connector', status: 'connected' }] };
        if (path === `/api/v2/connectors/${C_EJBCA}`) return { status: 200, body: { uuid: C_EJBCA, name: 'EJBCA-NG-Connector', version: 'v1' } };
        if (path === `/api/v1/connectors/${C_EJBCA}/health`) return this.caHealthy ? { status: 200, body: { status: 'ok' } } : { status: 503, body: { message: 'down' } };
        if (path === '/api/v1/authorities') return { status: 200, body: [{ uuid: A_EJBCA, name: 'ca', connectorUuid: C_EJBCA, connectorName: 'EJBCA-NG-Connector', status: 'connected' }] };
        if (path === '/api/v1/raProfiles' && a.method === 'GET') return { status: 200, body: [{ uuid: R_SRC, name: 'source-ra', authorityInstanceUuid: A_EJBCA, enabled: true }, ...[...this.raProfiles.values()]] };
        if (path === `/api/v1/authorities/${A_EJBCA}/raProfiles/${R_SRC}`) {
            return { status: 200, body: { uuid: R_SRC, name: 'source-ra', attributes: [{ version: 2, uuid: U(41), name: 'endEntityProfile', type: 'data', contentType: 'string', content: [{ data: 'EE' }] }] } };
        }
        if (path === `/api/v1/authorities/${A_EJBCA}/raProfiles` && a.method === 'POST') {
            const uuid = this.next();
            this.raProfiles.set(uuid, { uuid, name: body.name, authorityInstanceUuid: A_EJBCA, enabled: false });
            return { status: 200, body: { uuid, name: body.name } };
        }
        if ((m = /^\/api\/v1\/(?:authorities\/[0-9a-f-]{36}\/)?raProfiles\/([0-9a-f-]{36})(\/enable)?$/.exec(path)) && this.raProfiles.has(m[1])) {
            if (m[2]) this.raProfiles.get(m[1])!.enabled = true;
            return { status: 200, body: this.raProfiles.get(m[1]) };
        }
        if (path === '/api/v1/groups' && a.method === 'POST') {
            const uuid = this.next();
            this.groups.set(uuid, { uuid, name: body.name });
            return { status: 200, body: { uuid, name: body.name } };
        }
        if ((m = /^\/api\/v1\/groups\/([0-9a-f-]{36})$/.exec(path)) && this.groups.has(m[1])) return { status: 200, body: this.groups.get(m[1]) };
        if (path === '/api/v1/certificates/upload') {
            const cn = forge.pki.certificateFromPem(Buffer.from(String(body.certificate), 'base64').toString('utf8')).subject.getField('CN').value as string;
            const uuid = this.next();
            this.certs.set(uuid, { uuid, commonName: cn, key: { uuid: this.next() } });
            return { status: 200, body: { uuid } };
        }
        if ((m = /^\/api\/v1\/certificates\/([0-9a-f-]{36})$/.exec(path)) && this.certs.has(m[1])) {
            if (a.method === 'PATCH') Object.assign(this.certs.get(m[1])!, body);
            return { status: 200, body: this.certs.get(m[1]) };
        }
        return { status: 404, body: { message: `no fake route ${a.method} ${path}` } };
    }
}

let server: LoopbackServer;
let core: AuthCore;
let raw: APIRequestContext;
let api: GuardedApi;

registerFakeCore(() => core, (rig) => ({ server, raw, api } = rig), { clear: ['REG_CA_CONNECTORS', 'REG_RESTRICTED_USERNAME', 'REG_RESTRICTED_PASSWORD'], token: 'ADM-TOKEN' });
test.beforeEach(() => {
    core = new AuthCore();
});

const wire = () => server.mutations().map((a) => `${a.method} ${a.url}`);
const bodyOf = (method: string, url: string): any => JSON.parse(server.arrived.find((a) => a.method === method && a.url === url)!.body);

async function refusal(call: Promise<unknown>): Promise<string> {
    try {
        await call;
        return 'sent';
    } catch (e) {
        return e instanceof OwnObjectViolation ? e.kind : `error: ${String(e).slice(0, 160)}`;
    }
}

// ------------------------------------------------------------------ users

test('setOwnUserEnabled: enable / disable are sent for an own user, repeats answer 200 each; the lockout guard refuses the calling account', async () => {
    const user = await createOwnUser(api, 'T', 'state', { enabled: false });
    expect(core.users.get(user.uuid)!.enabled).toBe(false);
    for (const enable of [true, true, false, false]) {
        const r = await setOwnUserEnabled(api, user, enable);
        expect(r.status).toBe(200);
        expect(r.json.enabled).toBe(enable);
    }
    expect(wire().filter((w) => /enable|disable/.test(w))).toEqual([
        `PATCH /api/v1/users/${user.uuid}/enable`, `PATCH /api/v1/users/${user.uuid}/enable`, `PATCH /api/v1/users/${user.uuid}/disable`, `PATCH /api/v1/users/${user.uuid}/disable`,
    ]);
    // L-disable: a ref that IS the calling account (own on paper) is refused by the helper before the request leaves.
    core.users.set(ADM_UUID, { uuid: ADM_UUID, username: runName('self'), enabled: true, roles: [] });
    const self = { uuid: ADM_UUID, name: runName('self'), kind: 'own' } as OwnRef;
    recordCreated('users', self, { spec: 'T' });
    server.reset();
    await expect(setOwnUserEnabled(api, self, false)).rejects.toThrow(/calling account itself/);
    expect(wire()).toEqual([]);
    // A foreign user is refused by the helper (ledger) and by the guard.
    const foreign = { uuid: FOREIGN_USER, name: 'someone-else', kind: 'own' } as OwnRef;
    expect(await refusal(setOwnUserEnabled(api, foreign, false))).toBe('ownership');
    expect(await refusal(api.patch(`/api/v1/users/${FOREIGN_USER}/disable`))).toBe('ownership');
    expect(wire()).toEqual([]);
});

test('updateOwnUser sends the editable fields and groupUuids: []; PUT of a role leaves the name; both membership directions and idempotent add / remove', async () => {
    const user = await createOwnUser(api, 'T', 'member');
    const role = await createOwnRole(api, 'T', 'member-a');
    const other = await createOwnRole(api, 'T', 'member-b');
    expect((await updateOwnUser(api, user, { firstName: 'QA-x' })).status).toBe(200);
    expect(bodyOf('PUT', `/api/v1/users/${user.uuid}`)).toMatchObject({ groupUuids: [], firstName: 'QA-x' });

    expect((await replaceOwnUserRoles(api, user, [role, other])).status).toBe(200);
    expect(await userRoleUuids(api, user.uuid)).toEqual([role.uuid, other.uuid].sort());
    expect(await roleUserUuids(api, role.uuid)).toEqual([user.uuid]);
    expect((await replaceOwnUserRoles(api, user, [])).status).toBe(200);
    expect(await userRoleUuids(api, user.uuid)).toEqual([]);
    for (let i = 0; i < 2; i++) expect((await addOwnUserRole(api, user, role)).status).toBe(200);
    expect(await userRoleUuids(api, user.uuid)).toEqual([role.uuid]);
    for (let i = 0; i < 2; i++) expect((await removeOwnUserRole(api, user, role)).status).toBe(200);
    expect(await userRoleUuids(api, user.uuid)).toEqual([]);
    expect((await replaceOwnRoleUsers(api, role, [user])).status).toBe(200);
    expect(await userRoleUuids(api, user.uuid)).toEqual([role.uuid]);
    expect((await replaceOwnRoleUsers(api, role, [])).status).toBe(200);
    expect(await roleUserUuids(api, role.uuid)).toEqual([]);
    // PUT /users/{u}/roles/{r} carries an empty JSON object (the mapping declares consumes = application/json).
    const put = server.arrived.find((a) => a.method === 'PUT' && /\/roles\//.test(a.url))!;
    expect(put.headers['content-type']).toMatch(/application\/json/);
    expect(JSON.parse(put.body)).toEqual({});
    // A foreign role in the list is refused before the request leaves.
    server.reset();
    expect(await refusal(replaceOwnUserRoles(api, user, [{ uuid: SYSTEM_ROLE, name: 'admin', kind: 'own' } as OwnRef]))).toBe('ownership');
    expect(wire()).toEqual([]);
});

test('deleteOwnUserOrRole: DELETE → 204, the list decides (a deleted user\'s detail answers 500, core#2511), a `deleted` ledger line follows', async () => {
    const user = await createOwnUser(api, 'T', 'gone');
    const status = await deleteOwnUserOrRole(api, 'users', user, 'T', 'unit');
    expect(status).toBe(204);
    expect(core.users.has(user.uuid)).toBe(false);
    expect(readLedger().filter((l) => l.uuid === user.uuid).map((l) => l.event)).toEqual(['created', 'deleted']);
    expect(await usersOrRolesNamed(api, 'users', user.name)).toEqual([]);
    // A deleted object is no longer own: a second delete is refused by the ledger, nothing is sent.
    server.reset();
    expect(await refusal(deleteOwnUserOrRole(api, 'users', user, 'T', 'unit'))).toBe('ownership');
    expect(wire()).toEqual([]);
});

test('updateOwnRole sends `name` on purpose (the contract accepts and ignores it); saveOwnPermissions sends the document the matrix built', async () => {
    const role = await createOwnRole(api, 'T', 'update');
    expect((await updateOwnRole(api, role, { name: 'other-name', description: 'd1', email: 'e@example.test' })).status).toBe(200);
    expect(bodyOf('PUT', `/api/v1/roles/${role.uuid}`)).toMatchObject({ name: 'other-name', description: 'd1', email: 'e@example.test', customAttributes: [] });
    expect(core.roles.get(role.uuid)!.name, 'the fake keeps the name like the platform').toBe(role.name);

    // An object a permission names must be this run's own (the guard types `objects[].uuid` as any own object): a stand-in own object.
    const object = await createOwnUser(api, 'T', 'object');
    const saved = await saveOwnPermissions(api, role, {
        allowAllResources: false,
        resources: [{ name: 'certificates', actions: ['list', 'detail'] }, { name: 'raProfiles', actions: [], objects: [{ uuid: object.uuid, name: 'ra', allow: ['detail'] }] }],
    });
    expect(saved.status).toBe(200);
    expect(bodyOf('POST', `/api/v1/roles/${role.uuid}/permissions`)).toEqual({
        allowAllResources: false,
        resources: [
            { name: 'certificates', allowAllActions: false, actions: ['list', 'detail'] },
            { name: 'raProfiles', allowAllActions: false, actions: [], objects: [{ uuid: object.uuid, name: 'ra', allow: ['detail'], deny: [] }] },
        ],
    });
    expect((await readPermissions(api, role.uuid)).allowAllResources).toBe(false);
    // A permission on a foreign object is refused by the guard, nothing is sent.
    server.reset();
    expect(await refusal(saveOwnPermissions(api, role, { allowAllResources: false, resources: [{ name: 'raProfiles', objects: [{ uuid: U(77), name: 'foreign', allow: ['detail'] }] }] }))).toBe('ownership');
    expect(wire()).toEqual([]);
});

test('probeUser / probeRole return the answer without asserting it (the duplicate probes read the status and body)', async () => {
    const user = await createOwnUser(api, 'T', 'dup');
    const second = await probeUser(api, 'T', user.name);
    expect(second.status).toBe(500);
    expect(second.json).toEqual({ message: 'Internal server error.' });
    const role = await createOwnRole(api, 'T', 'dup');
    expect((await probeRole(api, 'T', role.name)).status).toBe(500);
    // A system role name: a create naming no uuid is allow-listed, the platform answers.
    expect((await probeRole(api, 'T', 'admin')).status).toBe(500);
    expect(await usersOrRolesNamed(api, 'roles', 'admin')).toHaveLength(1);
});

// ------------------------------------------------------------------ one request as another identity

test('callAs: the second identity\'s bearer replaces the admin\'s for that request only; undefined keeps the context\'s own credentials', async () => {
    expect((await callAs(api, 'DED-TOKEN', 'GET', '/api/v1/auth/profile')).status, 'no DED user yet: the fake refuses it').toBe(401);
    expect(server.arrived[0].headers.authorization).toBe('Bearer DED-TOKEN');
    server.reset();
    const own = await callAs(api, undefined, 'GET', '/api/v1/auth/profile');
    expect(own.status).toBe(200);
    expect(own.json.username).toBe('admin-test');
    expect(server.arrived[0].headers.authorization).toBe('Bearer ADM-TOKEN');
    // A raw header value (a PT-03 variant) and a query parameter.
    server.reset();
    const variant = await callWithAuthorization(api, 'Basic bm90OnRoaXM=', 'GET', '/api/v1/auth/profile', { params: { access_token: 'x' } });
    expect(variant.status).toBe(401);
    expect(server.arrived[0].headers.authorization).toBe('Basic bm90OnRoaXM=');
    expect(server.arrived[0].url).toBe('/api/v1/auth/profile?access_token=x');
    // The guard still judges what the identity-override request names: a foreign uuid in a mutation is refused, nothing sent.
    server.reset();
    expect(await refusal(callAs(api, 'DED-TOKEN', 'DELETE', `/api/v1/users/${FOREIGN_USER}`))).toBe('ownership');
    expect(await refusal(callAs(api, 'DED-TOKEN', 'PATCH', `/api/v1/users/${FOREIGN_USER}/disable`))).toBe('ownership');
    expect(wire()).toEqual([]);
    // A probe uuid is fine (401 / 403 negatives answer 404 / refusals).
    const probe = await callAs(api, 'DED-TOKEN', 'DELETE', `/api/v1/roles/${api.probeUuid()}`);
    expect(probe.status).toBe(500); // the fake answers like core#2511; the point is that it was SENT
    expect(wire()).toHaveLength(1);
});

// ------------------------------------------------------------------ the dedicated user, the role switch, the data table

test('ensureRestrictedUser: absent → created enabled and ledgered under the account\'s name; present but not made by this run → not adopted, nothing sent', async () => {
    const dedicatedUser = { username: 'qa-restricted-account', password: GEN_PW_1 };
    const ref = await ensureRestrictedUser(api, 'T', dedicatedUser);
    expect(wire()).toEqual(['POST /api/v1/users']);
    expect(bodyOf('POST', '/api/v1/users')).toMatchObject({ username: dedicatedUser.username, enabled: true });
    expect(readLedger().find((l) => l.uuid === ref.uuid)).toMatchObject({ type: 'users', name: dedicatedUser.username, event: 'created' });
    // The same run asks again: found in the ledger, nothing more is sent.
    server.reset();
    expect((await ensureRestrictedUser(api, 'T', dedicatedUser)).uuid).toBe(ref.uuid);
    expect(wire()).toEqual([]);
});

test('the DED `users` ledger line is written only after a 2xx create — a refused create that carries a uuid in its body leaves the ledger empty', async () => {
    const dedicatedUser = { username: 'qa-restricted-account', password: GEN_PW_1 };
    core.failCreateWithUuid = 422;
    await expect(ensureRestrictedUser(api, 'T', dedicatedUser)).rejects.toThrow(/creating the DED user/);
    expect(wire()).toEqual(['POST /api/v1/users']);
    expect(readLedger().filter((l) => l.type === 'users'), 'no ledger line for a create that was not answered 2xx').toEqual([]);
    core.failCreateWithUuid = 500;
    await expect(ensureRestrictedUser(api, 'T', dedicatedUser)).rejects.toThrow(/creating the DED user/);
    expect(readLedger().filter((l) => l.type === 'users')).toEqual([]);
    // The 2xx case still records (the first test of this group).
    core.failCreateWithUuid = undefined;
    const ref = await ensureRestrictedUser(api, 'T', dedicatedUser);
    expect(readLedger().find((l) => l.uuid === ref.uuid)).toMatchObject({ type: 'users', name: dedicatedUser.username, event: 'created' });
});

test('ensureRestrictedUser: a user of that name this run did not create is not adopted — a named skip for the rows, nothing sent', async () => {
    core.users.set(U(901), { uuid: U(901), username: 'Qa-Restricted-Account', enabled: true, roles: [] });
    const dedicatedUser = { username: 'qa-restricted-account', password: GEN_PW_2 };
    await expect(ensureRestrictedUser(api, 'T', dedicatedUser)).rejects.toBeInstanceOf(RestrictedUserNotOwn);
    const reasons: string[] = [];
    await expect(ensureRestrictedUserOrSkip(api, 'T', dedicatedUser, (r) => reasons.push(r))).rejects.toBeInstanceOf(RestrictedUserNotOwn);
    expect(reasons).toEqual([RESTRICTED_USER_NOT_OWN_REASON]);
    expect(RESTRICTED_USER_NOT_OWN_REASON).toBe('dedicated test user exists but is not this run\'s — delete it or wait for the next clean run');
    expect(wire()).toEqual([]);
    expect(readLedger().filter((l) => l.type === 'users')).toEqual([]);
    // Any other error is not turned into a skip.
    core.users.clear();
    core.duplicateStatus = 500;
    const skipped: string[] = [];
    const ref = await ensureRestrictedUserOrSkip(api, 'T', dedicatedUser, (r) => skipped.push(r));
    expect(ref.name).toBe(dedicatedUser.username);
    expect(skipped).toEqual([]);
});

test('applyFixture: the fixture role is built from its document, becomes DED\'s only role and the barrier sees it in force; the next fixture replaces it', async () => {
    // A run-prefixed account name stands in for DED here: the guard recognises an own object by the run prefix, and DED's real
    // name has none (guard request GR-3). Everything else is the real flow.
    core.dedicatedUsername = runName('ded');
    const dedicatedUser = { username: core.dedicatedUsername, password: GEN_PW_2 };
    const user = await ensureRestrictedUser(api, 'T', dedicatedUser);
    const sw = restrictedRoleSwitch(api, user, 'DED-TOKEN');
    const made = await applyFixtureWithRole(api, sw, 'F1', {}, 'T');
    const doc = made.doc;
    const f1 = [...core.roles.values()].find((r) => r.name === runName('rbac-f1'))!;
    expect(f1.permissions).toEqual({ allowAllResources: false, resources: [{ name: 'certificates', allowAllActions: false, actions: ['list', 'detail'] }] });
    expect(doc).toEqual({ allowAllResources: false, resources: [{ name: 'certificates', actions: ['list', 'detail'] }] });
    expect(core.users.get(user.uuid)!.roles).toEqual([f1.uuid]);
    expect(made.role.uuid, 'the role that is now in force, for the sign-in re-check').toBe(f1.uuid);
    expect((await sw.profile())!.allowedActions).toEqual([{ resource: 'certificates', actions: ['detail', 'list'] }]);
    // F0 (no permissions) replaces it as the ONLY role; the barrier waits for an empty action list.
    await applyFixture(api, sw, 'F0', {}, 'T');
    const f0 = [...core.roles.values()].find((r) => r.name === runName('rbac-f0'))!;
    expect(core.users.get(user.uuid)!.roles).toEqual([f0.uuid]);
    expect((await sw.profile())!.allowedActions).toEqual([]);
    // Disable / enable go through the guard as the admin; DED's token is refused while disabled (the fake's profile 401).
    expect((await sw.setEnabled(false)).status).toBe(200);
    expect(await sw.profile()).toBeUndefined();
    expect((await sw.setEnabled(true)).status).toBe(200);
    expect(await sw.profile()).toBeDefined();
});

test('ensureRbacObjects: two own RA profiles under the pre-existing authority, two groups, six certificates given their RA profile and groups; a second call sends nothing', async () => {
    const refs = await ensureRbacObjects(api, 'T');
    expect(refs.authorityUuid).toBe(A_EJBCA);
    expect([refs.p1.name, refs.p2.name, refs.g1.name, refs.g2.name]).toEqual([runName('rbac-p1'), runName('rbac-p2'), runName('rbac-g1'), runName('rbac-g2')]);
    expect(Object.keys(refs.certs).sort()).toEqual(['c1', 'c2', 'c3', 'cg1', 'cg12', 'cg2']);
    // The source RA profile (pre-existing) is only READ; both own RA profiles are created under the authority and enabled.
    expect(wire().filter((w) => w.includes(R_SRC))).toEqual([]);
    expect(wire().filter((w) => w.startsWith('POST /api/v1/authorities/'))).toHaveLength(2);
    expect(wire().filter((w) => w.endsWith('/enable'))).toHaveLength(2);
    const patches = Object.fromEntries(server.arrived.filter((a) => a.method === 'PATCH').map((a) => [a.url.split('/').pop(), a.body ? JSON.parse(a.body) : {}]));
    expect(patches[refs.certs.c1.uuid]).toEqual({ raProfileUuid: refs.p1.uuid });
    expect(patches[refs.certs.c2.uuid]).toEqual({ raProfileUuid: refs.p2.uuid });
    expect(patches[refs.certs.c3.uuid] ?? {}).toEqual({});
    expect(patches[refs.certs.cg12.uuid]).toEqual({ groupUuids: [refs.g1.uuid, refs.g2.uuid] });
    expect(patches[refs.certs.cg2.uuid]).toEqual({ groupUuids: [refs.g2.uuid] });
    const types = readLedger().filter((l) => l.event === 'created').map((l) => l.type);
    expect(types.filter((t) => t === 'raProfiles')).toHaveLength(2);
    expect(types.filter((t) => t === 'groups')).toHaveLength(2);
    expect(types.filter((t) => t === 'certificates')).toHaveLength(6);
    // Idempotent through the ledger.
    server.reset();
    const again = await ensureRbacObjects(api, 'T');
    expect(again.p1.uuid).toBe(refs.p1.uuid);
    expect(again.certs.cg12.uuid).toBe(refs.certs.cg12.uuid);
    expect(wire()).toEqual([]);
});

test('ensureRbacObjects: no healthy CA → RaProfileSourceMissing with the named deploy gate; nothing is created', async () => {
    core.caHealthy = false;
    await expect(ensureRbacObjects(api, 'T')).rejects.toBeInstanceOf(RaProfileSourceMissing);
    expect(wire()).toEqual([]);
});

test('a raw context handed to a mutating AUTH helper is refused (not-guarded) and nothing is sent', async () => {
    const role = await createOwnRole(api, 'T', 'raw');
    server.reset();
    expect(await refusal(updateOwnRole(rawAsGuarded(raw), role, { description: 'x' }))).toBe('not-guarded');
    expect(wire()).toEqual([]);
});
