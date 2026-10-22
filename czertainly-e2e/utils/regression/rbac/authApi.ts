/**
 * authApi — users, roles, memberships and permission documents through the guarded API.
 *
 * WHAT: users, roles, memberships and permission documents through the guarded API. Every helper that changes
 *       something takes an `OwnRef` and proves it with `assertOwnLive` first; reads take any context. Absence is read from the
 *       authoritative LIST, never from a detail GET (the detail of a deleted role or user answers 500, core#2511). Users: enable /
 *       disable, roles replace / add / remove; roles: description and e-mail only (the name is immutable), members, permissions.
 * WHY: Authorisation rows change identities and roles, which only an own object may suffer.
 * HOW: Every change takes an `OwnRef` and proves it with `assertOwnLive`; absence is read from the authoritative list, never from a detail GET.
 */
import { APIRequestContext, APIResponse, expect } from '@playwright/test';
import { GuardedApi, assertGuarded } from '../guard/types';
import { assertNotCaller } from './identities';
import { assertOwnLive } from '../ledger/ownership';
import { ApiAnswer, answerOf, apiJson } from '../apiReads';
import { requiredCustomAttributes } from '../customAttributes';
import { probeCollectionCreate, deleteOwn } from '../ownCrud';
import { roleBody } from '../ownRoles';
import { userBody } from '../ownUsers';
import { OwnRef } from '../ledger/ledger';
import { runName } from '../ledger/runState';
import type { JsonObject } from '../json';

/** One guarded call whose answer is read without throwing on a status (the caller asserts it). */
async function answered(call: () => Promise<APIResponse>): Promise<ApiAnswer> {
    const started = Date.now();
    return answerOf(await call(), started);
}

// ------------------------------------------------------------------ reads

export async function getUser(api: APIRequestContext, uuid: string): Promise<JsonObject> {
    return apiJson(api, 'GET', `/api/v1/users/${uuid}`);
}

export async function getRole(api: APIRequestContext, uuid: string): Promise<JsonObject> {
    return apiJson(api, 'GET', `/api/v1/roles/${uuid}`);
}

/** The uuids of the roles a user holds (`GET /v1/users/{u}/roles`), sorted. */
export async function userRoleUuids(api: APIRequestContext, userUuid: string): Promise<string[]> {
    const rows = await apiJson<JsonObject[]>(api, 'GET', `/api/v1/users/${userUuid}/roles`);
    return rows.map((r) => String(r.uuid)).sort();
}

/** The uuids of the users a role holds (`GET /v1/roles/{r}/users`), sorted. */
export async function roleUserUuids(api: APIRequestContext, roleUuid: string): Promise<string[]> {
    const rows = await apiJson<JsonObject[]>(api, 'GET', `/api/v1/roles/${roleUuid}/users`);
    return rows.map((r) => String(r.uuid)).sort();
}

/** Every row of a full list (`/v1/users`, `/v1/roles`) — the authoritative place to prove presence or absence (core#2511). */
export async function listAll(api: APIRequestContext, kind: 'users' | 'roles'): Promise<JsonObject[]> {
    return apiJson<JsonObject[]>(api, 'GET', `/api/v1/${kind}`);
}

// ------------------------------------------------------------------ raw creates (the caller records what they made)

/**
 * `POST /v1/users` for a username, answer returned (never asserted): the duplicate-name probes need the status and body. A
 * 2xx answer is a user this run made: it is recorded before this returns.
 */
export async function probeUser(api: GuardedApi, spec: string, username: string, fields: { enabled?: boolean } = {}): Promise<ApiAnswer> {
    return probeCollectionCreate(api, spec, {
        type: 'users',
        path: '/api/v1/users',
        nameField: 'username',
        body: { username, ...(await userBody(api, username, { ...fields, description: 'REG run (API-AUTH probe)' })) },
        note: 'duplicate user probe',
    });
}

/** `POST /v1/roles` for a name, answer returned (never asserted); a 2xx answer is recorded before this returns. */
export async function probeRole(api: GuardedApi, spec: string, name: string, description = 'REG run (API-AUTH probe)'): Promise<ApiAnswer> {
    return probeCollectionCreate(api, spec, { type: 'roles', path: '/api/v1/roles', body: { name, ...(await roleBody(api, { description })) }, note: 'duplicate role probe' });
}

// ------------------------------------------------------------------ users (own TMP users)

/** Enable / disable an OWN user; the answer is returned, never asserted (a repeat must answer 200 too). */
export async function setOwnUserEnabled(api: GuardedApi, user: OwnRef, enabled: boolean): Promise<ApiAnswer> {
    assertGuarded(api, 'setOwnUserEnabled');
    await assertOwnLive(api, 'users', user, 'setOwnUserEnabled');
    await assertNotCaller(api, user.uuid, `${enabled ? 'enable' : 'disable'} user`);
    return answered(() => api.patch(`/api/v1/users/${user.uuid}/${enabled ? 'enable' : 'disable'}`));
}

/** `PUT /v1/users/{u}` on an OWN user (first name, last name, e-mail, description; `groupUuids: []` made explicit). */
export async function updateOwnUser(api: GuardedApi, user: OwnRef, fields: { firstName?: string; lastName?: string; email?: string; description?: string }): Promise<ApiAnswer> {
    assertGuarded(api, 'updateOwnUser');
    await assertOwnLive(api, 'users', user, 'updateOwnUser');
    const customAttributes = await requiredCustomAttributes(api, 'users', runName('ca'));
    return answered(() => api.put(`/api/v1/users/${user.uuid}`, { data: { groupUuids: [], customAttributes, ...fields } }));
}

/** `PUT /v1/users/{u}/roles/{r}` (add one role) between two OWN objects. */
export async function addOwnUserRole(api: GuardedApi, user: OwnRef, role: OwnRef): Promise<ApiAnswer> {
    assertGuarded(api, 'addOwnUserRole');
    await assertOwnLive(api, 'users', user, 'addOwnUserRole (user)');
    await assertOwnLive(api, 'roles', role, 'addOwnUserRole (role)');
    // The mapping declares `consumes = application/json`: an empty JSON object keeps the content type honest.
    return answered(() => api.put(`/api/v1/users/${user.uuid}/roles/${role.uuid}`, { data: {} }));
}

/** `DELETE /v1/users/{u}/roles/{r}` (remove one role) between two OWN objects. */
export async function removeOwnUserRole(api: GuardedApi, user: OwnRef, role: OwnRef): Promise<ApiAnswer> {
    assertGuarded(api, 'removeOwnUserRole');
    await assertOwnLive(api, 'users', user, 'removeOwnUserRole (user)');
    await assertOwnLive(api, 'roles', role, 'removeOwnUserRole (role)');
    return answered(() => api.delete(`/api/v1/users/${user.uuid}/roles/${role.uuid}`));
}

/** `PATCH /v1/users/{u}/roles` with the full list (`[]` clears) — OWN user, OWN roles. */
export async function replaceOwnUserRoles(api: GuardedApi, user: OwnRef, roles: OwnRef[]): Promise<ApiAnswer> {
    assertGuarded(api, 'replaceOwnUserRoles');
    await assertOwnLive(api, 'users', user, 'replaceOwnUserRoles (user)');
    for (const r of roles) await assertOwnLive(api, 'roles', r, 'replaceOwnUserRoles (role)');
    return answered(() => api.patch(`/api/v1/users/${user.uuid}/roles`, { data: roles.map((r) => r.uuid) }));
}

/** `PATCH /v1/roles/{r}/users` with the full member list (`[]` clears) — OWN role, OWN users. */
export async function replaceOwnRoleUsers(api: GuardedApi, role: OwnRef, users: OwnRef[]): Promise<ApiAnswer> {
    assertGuarded(api, 'replaceOwnRoleUsers');
    await assertOwnLive(api, 'roles', role, 'replaceOwnRoleUsers (role)');
    for (const u of users) await assertOwnLive(api, 'users', u, 'replaceOwnRoleUsers (user)');
    return answered(() => api.patch(`/api/v1/roles/${role.uuid}/users`, { data: users.map((u) => u.uuid) }));
}

// ------------------------------------------------------------------ roles (own roles)

/**
 * `PUT /v1/roles/{r}` on an OWN role. `name` is sent on purpose when given: the contract accepts it and ignores it (the
 * auth service's update DTO has no name; core#2297 note).
 */
export async function updateOwnRole(api: GuardedApi, role: OwnRef, fields: { name?: string; description?: string; email?: string }): Promise<ApiAnswer> {
    assertGuarded(api, 'updateOwnRole');
    await assertOwnLive(api, 'roles', role, 'updateOwnRole');
    const customAttributes = await requiredCustomAttributes(api, 'roles', runName('ca'));
    return answered(() => api.put(`/api/v1/roles/${role.uuid}`, { data: { customAttributes, ...fields } }));
}

// ------------------------------------------------------------------ permission documents

/** One resource of a permission document (`POST /v1/roles/{r}/permissions`). */
interface ResourceGrant {
    name: string;
    allowAllActions?: boolean;
    actions?: string[];
    /** Object level: `undefined` = leave the resource's objects as they are, `[]` = clear them. */
    objects?: Array<{ uuid: string; name: string; allow?: string[]; deny?: string[] }>;
}

export interface PermissionDocument {
    allowAllResources: boolean;
    resources?: ResourceGrant[];
}

/** The request body of `POST /v1/roles/{r}/permissions` (every resource gets an explicit `allowAllActions`). */
export function permissionBody(doc: PermissionDocument): JsonObject {
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
export async function saveOwnPermissions(api: GuardedApi, role: OwnRef, doc: PermissionDocument): Promise<ApiAnswer> {
    assertGuarded(api, 'saveOwnPermissions');
    await assertOwnLive(api, 'roles', role, 'saveOwnPermissions');
    return answered(() => api.post(`/api/v1/roles/${role.uuid}/permissions`, { data: permissionBody(doc) }));
}

/** The stored document of a role (`GET /v1/roles/{r}/permissions`, verbose: resource-level actions repeat on objects). */
export async function readPermissions(api: APIRequestContext, roleUuid: string): Promise<JsonObject> {
    return apiJson(api, 'GET', `/api/v1/roles/${roleUuid}/permissions`);
}

// ------------------------------------------------------------------ deletes

/**
 * Delete an OWN user or role, wait until the authoritative list no longer names it, then close its ledger line. A 5xx
 * detail read is never proof (core#2511): only the list decides. Returns the DELETE status.
 */
export async function deleteOwnUserOrRole(api: GuardedApi, kind: 'users' | 'roles', ref: OwnRef, spec: string, note: string): Promise<number> {
    const answer = await deleteOwn(api, kind, ref, spec, {
        note,
        readBack: () =>
            expect
                .poll(async () => {
                    const rows = await listAll(api, kind);
                    return rows.length > 0 && !rows.some((r) => r.uuid === ref.uuid);
                }, { timeout: 30_000, message: `${kind} ${ref.uuid} is still listed after its DELETE` })
                .toBe(true),
    });
    return answer.status;
}
