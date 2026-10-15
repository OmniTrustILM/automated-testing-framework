/**
 * authApi — users, roles, memberships and permission documents through the guarded API (auth-rbac area, B3).
 *
 * Every helper that CHANGES something takes an `OwnRef` (what `recordCreated` returns) and proves it first with
 * `assertOwnLive` (ledger line of this run + live run-prefixed name; decision Q1); the guarded `api` judges the request
 * again. Reads take any context. Absence is read from the authoritative LIST, never from a detail GET: the detail of a
 * deleted role or user answers 500 instead of 404 (known bug core#2511, `ownObjects.FULL_LIST_TYPES`).
 *
 * Contract used here (interfaces `UserManagementController` / `RoleManagementController`, core `UserManagementServiceImpl`,
 * `RoleManagementServiceImpl`; rules auth-rbac C1–C6, D1–D4, E6):
 * - users: enable / disable → 200 + the user (idempotent); delete → 204; `PATCH /v1/users/{u}/roles` replaces the role
 *   list (`[]` clears); `PUT` / `DELETE /v1/users/{u}/roles/{r}` add / remove one;
 * - roles: `PUT` changes description and e-mail only (the name is immutable, core#2297 note); `PATCH /v1/roles/{r}/users`
 *   replaces the member list; `POST /v1/roles/{r}/permissions` replaces the permission document.
 */
import { APIRequestContext, APIResponse, expect } from '@playwright/test';
import { GuardedApi, requireGuarded } from './guardedApi';
import { assertNotCaller } from './identities';
import { assertOwnLive } from './ownObjects';
import { apiJson, requiredCustomAttributes } from './regressionApi';
import { OwnRef, recordDeleted, regName } from './regressionRun';

type Json = Record<string, any>;

/** What a status-sensitive call answered. */
export interface Reply {
    status: number;
    text: string;
    json: any;
    contentType: string;
}

export async function reply(res: APIResponse): Promise<Reply> {
    const text = await res.text();
    let json: any;
    try {
        json = text.trim() ? JSON.parse(text) : undefined;
    } catch {
        json = undefined;
    }
    return { status: res.status(), text, json, contentType: res.headers()['content-type'] ?? '' };
}

// ------------------------------------------------------------------ reads

export async function getUser(api: APIRequestContext, uuid: string): Promise<Json> {
    return apiJson(api, 'GET', `/api/v1/users/${uuid}`);
}

export async function getRole(api: APIRequestContext, uuid: string): Promise<Json> {
    return apiJson(api, 'GET', `/api/v1/roles/${uuid}`);
}

/** The uuids of the roles a user holds (`GET /v1/users/{u}/roles`), sorted. */
export async function userRoleUuids(api: APIRequestContext, userUuid: string): Promise<string[]> {
    const rows = await apiJson<Json[]>(api, 'GET', `/api/v1/users/${userUuid}/roles`);
    return rows.map((r) => String(r.uuid)).sort();
}

/** The uuids of the users a role holds (`GET /v1/roles/{r}/users`), sorted. */
export async function roleUserUuids(api: APIRequestContext, roleUuid: string): Promise<string[]> {
    const rows = await apiJson<Json[]>(api, 'GET', `/api/v1/roles/${roleUuid}/users`);
    return rows.map((r) => String(r.uuid)).sort();
}

/** Every row of a full list (`/v1/users`, `/v1/roles`) — the authoritative place to prove presence or absence (core#2511). */
export async function listAll(api: APIRequestContext, kind: 'users' | 'roles'): Promise<Json[]> {
    return apiJson<Json[]>(api, 'GET', `/api/v1/${kind}`);
}

/** The rows of a full list whose `key` equals `value` (a name, a username). */
export async function rowsNamed(api: APIRequestContext, kind: 'users' | 'roles', value: string): Promise<Json[]> {
    const key = kind === 'users' ? 'username' : 'name';
    return (await listAll(api, kind)).filter((r) => r[key] === value);
}

// ------------------------------------------------------------------ raw creates (the caller records what they made)

/**
 * `POST /v1/users` for a username, answer returned (never asserted): the duplicate-name probes need the status and body.
 * The caller records a created user in the ledger FIRST (`recordCreated('users', …)`) when the answer is 2xx.
 */
export async function postUser(api: GuardedApi, username: string, fields: { enabled?: boolean } = {}): Promise<Reply> {
    requireGuarded(api, 'postUser');
    const data = {
        username,
        firstName: 'QA',
        lastName: 'Regression',
        email: `${username}@example.test`,
        enabled: fields.enabled ?? false,
        description: 'REG run (API-AUTH probe)',
        groupUuids: [],
        customAttributes: await requiredCustomAttributes(api, 'users', regName('ca')),
    };
    return reply(await api.post('/api/v1/users', { data }));
}

/** `POST /v1/roles` for a name, answer returned (never asserted); the caller records a created role first. */
export async function postRole(api: GuardedApi, name: string, description = 'REG run (API-AUTH probe)'): Promise<Reply> {
    requireGuarded(api, 'postRole');
    const data = { name, description, customAttributes: await requiredCustomAttributes(api, 'roles', regName('ca')) };
    return reply(await api.post('/api/v1/roles', { data }));
}

// ------------------------------------------------------------------ users (own TMP users)

/** Enable / disable an OWN user; the answer is returned, never asserted (a repeat must answer 200 too). */
export async function setOwnUserEnabled(api: GuardedApi, user: OwnRef, enabled: boolean): Promise<Reply> {
    requireGuarded(api, 'setOwnUserEnabled');
    await assertOwnLive(api, 'users', user, 'setOwnUserEnabled');
    await assertNotCaller(api, user.uuid, `${enabled ? 'enable' : 'disable'} user`);
    return reply(await api.patch(`/api/v1/users/${user.uuid}/${enabled ? 'enable' : 'disable'}`));
}

/** `PUT /v1/users/{u}` on an OWN user (first name, last name, e-mail, description; `groupUuids: []` made explicit). */
export async function updateOwnUser(api: GuardedApi, user: OwnRef, fields: { firstName?: string; lastName?: string; email?: string; description?: string }): Promise<Reply> {
    requireGuarded(api, 'updateOwnUser');
    await assertOwnLive(api, 'users', user, 'updateOwnUser');
    const customAttributes = await requiredCustomAttributes(api, 'users', regName('ca'));
    return reply(await api.put(`/api/v1/users/${user.uuid}`, { data: { groupUuids: [], customAttributes, ...fields } }));
}

/** `PUT /v1/users/{u}/roles/{r}` (add one role) between two OWN objects. */
export async function addOwnUserRole(api: GuardedApi, user: OwnRef, role: OwnRef): Promise<Reply> {
    requireGuarded(api, 'addOwnUserRole');
    await assertOwnLive(api, 'users', user, 'addOwnUserRole (user)');
    await assertOwnLive(api, 'roles', role, 'addOwnUserRole (role)');
    // The mapping declares `consumes = application/json`: an empty JSON object keeps the content type honest.
    return reply(await api.put(`/api/v1/users/${user.uuid}/roles/${role.uuid}`, { data: {} }));
}

/** `DELETE /v1/users/{u}/roles/{r}` (remove one role) between two OWN objects. */
export async function removeOwnUserRole(api: GuardedApi, user: OwnRef, role: OwnRef): Promise<Reply> {
    requireGuarded(api, 'removeOwnUserRole');
    await assertOwnLive(api, 'users', user, 'removeOwnUserRole (user)');
    await assertOwnLive(api, 'roles', role, 'removeOwnUserRole (role)');
    return reply(await api.delete(`/api/v1/users/${user.uuid}/roles/${role.uuid}`));
}

/** `PATCH /v1/users/{u}/roles` with the full list (`[]` clears) — OWN user, OWN roles. */
export async function replaceOwnUserRoles(api: GuardedApi, user: OwnRef, roles: OwnRef[]): Promise<Reply> {
    requireGuarded(api, 'replaceOwnUserRoles');
    await assertOwnLive(api, 'users', user, 'replaceOwnUserRoles (user)');
    for (const r of roles) await assertOwnLive(api, 'roles', r, 'replaceOwnUserRoles (role)');
    return reply(await api.patch(`/api/v1/users/${user.uuid}/roles`, { data: roles.map((r) => r.uuid) }));
}

/** `PATCH /v1/roles/{r}/users` with the full member list (`[]` clears) — OWN role, OWN users. */
export async function replaceOwnRoleUsers(api: GuardedApi, role: OwnRef, users: OwnRef[]): Promise<Reply> {
    requireGuarded(api, 'replaceOwnRoleUsers');
    await assertOwnLive(api, 'roles', role, 'replaceOwnRoleUsers (role)');
    for (const u of users) await assertOwnLive(api, 'users', u, 'replaceOwnRoleUsers (user)');
    return reply(await api.patch(`/api/v1/roles/${role.uuid}/users`, { data: users.map((u) => u.uuid) }));
}

// ------------------------------------------------------------------ roles (own roles)

/**
 * `PUT /v1/roles/{r}` on an OWN role. `name` is sent on purpose when given: the contract accepts it and ignores it (the
 * auth service's update DTO has no name; core#2297 note, rules D1).
 */
export async function updateOwnRole(api: GuardedApi, role: OwnRef, fields: { name?: string; description?: string; email?: string }): Promise<Reply> {
    requireGuarded(api, 'updateOwnRole');
    await assertOwnLive(api, 'roles', role, 'updateOwnRole');
    const customAttributes = await requiredCustomAttributes(api, 'roles', regName('ca'));
    return reply(await api.put(`/api/v1/roles/${role.uuid}`, { data: { customAttributes, ...fields } }));
}

// ------------------------------------------------------------------ permission documents

/** One resource of a permission document (`POST /v1/roles/{r}/permissions`). */
export interface ResourceGrant {
    name: string;
    allowAllActions?: boolean;
    actions?: string[];
    /** Object level: `undefined` = leave the resource's objects as they are, `[]` = clear them (rules E6). */
    objects?: Array<{ uuid: string; name: string; allow?: string[]; deny?: string[] }>;
}

export interface PermissionDocument {
    allowAllResources: boolean;
    resources?: ResourceGrant[];
}

/** The request body of `POST /v1/roles/{r}/permissions` (every resource gets an explicit `allowAllActions`). */
export function permissionBody(doc: PermissionDocument): Json {
    return {
        allowAllResources: doc.allowAllResources,
        resources: (doc.resources ?? []).map((r) => ({
            name: r.name,
            allowAllActions: r.allowAllActions ?? false,
            actions: r.actions ?? [],
            ...(r.objects === undefined ? {} : { objects: r.objects.map((o) => ({ uuid: o.uuid, name: o.name, allow: o.allow ?? [], deny: o.deny ?? [] })) }),
        })),
    };
}

/** Replace the permission document of an OWN role; returns the stored document the call answered. */
export async function saveOwnPermissions(api: GuardedApi, role: OwnRef, doc: PermissionDocument): Promise<Reply> {
    requireGuarded(api, 'saveOwnPermissions');
    await assertOwnLive(api, 'roles', role, 'saveOwnPermissions');
    return reply(await api.post(`/api/v1/roles/${role.uuid}/permissions`, { data: permissionBody(doc) }));
}

/** The stored document of a role (`GET /v1/roles/{r}/permissions`, verbose: resource-level actions repeat on objects). */
export async function readPermissions(api: APIRequestContext, roleUuid: string): Promise<Json> {
    return apiJson(api, 'GET', `/api/v1/roles/${roleUuid}/permissions`);
}

/** The actions stored for one resource of a document, sorted ([] when the resource is absent). */
export function actionsOf(doc: Json, resource: string): string[] {
    return [...((doc.resources ?? []).find((r: Json) => r.name === resource)?.actions ?? [])].sort();
}

// ------------------------------------------------------------------ deletes

/**
 * Delete an OWN user or role, wait until the authoritative list no longer names it, then close its ledger line. A 5xx
 * detail read is never proof (core#2511): only the list decides. Returns the DELETE status.
 */
export async function deleteOwn(api: GuardedApi, kind: 'users' | 'roles', ref: OwnRef, spec: string, note: string): Promise<number> {
    requireGuarded(api, 'deleteOwn');
    await assertOwnLive(api, kind, ref, `deleteOwn ${kind}`);
    const res = await api.delete(`/api/v1/${kind}/${ref.uuid}`);
    const status = res.status();
    if (status < 300) {
        await expect
            .poll(async () => {
                const rows = await listAll(api, kind);
                return rows.length > 0 && !rows.some((r) => r.uuid === ref.uuid);
            }, { timeout: 30_000, message: `${kind} ${ref.uuid} is still listed after its DELETE answered ${status}` })
            .toBe(true);
        recordDeleted(kind, ref, spec, note);
    }
    return status;
}
