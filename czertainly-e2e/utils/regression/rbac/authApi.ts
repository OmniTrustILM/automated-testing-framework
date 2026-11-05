/**
 * authApi — users, roles, memberships and permission documents through the guarded API.
 * Every helper that changes something takes an `OwnRef` and proves it with `assertOwnLive` first. Absence is read from the
 * list, never from a detail GET (a deleted role or user answers 500, core#2511).
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

async function answered(call: () => Promise<APIResponse>): Promise<ApiAnswer> {
    const started = Date.now();
    return answerOf(await call(), started);
}

export async function getUser(api: APIRequestContext, uuid: string): Promise<JsonObject> {
    return apiJson(api, 'GET', `/api/v1/users/${uuid}`);
}

export async function getRole(api: APIRequestContext, uuid: string): Promise<JsonObject> {
    return apiJson(api, 'GET', `/api/v1/roles/${uuid}`);
}

export async function userRoleUuids(api: APIRequestContext, userUuid: string): Promise<string[]> {
    const rows = await apiJson<JsonObject[]>(api, 'GET', `/api/v1/users/${userUuid}/roles`);
    return rows.map((r) => String(r.uuid)).sort();
}

export async function roleUserUuids(api: APIRequestContext, roleUuid: string): Promise<string[]> {
    const rows = await apiJson<JsonObject[]>(api, 'GET', `/api/v1/roles/${roleUuid}/users`);
    return rows.map((r) => String(r.uuid)).sort();
}

export async function listAll(api: APIRequestContext, kind: 'users' | 'roles'): Promise<JsonObject[]> {
    return apiJson<JsonObject[]>(api, 'GET', `/api/v1/${kind}`);
}

/** `POST /v1/users` for a username, answer returned (never asserted); a 2xx answer is recorded before this returns. */
export async function probeUser(api: GuardedApi, spec: string, username: string, fields: { enabled?: boolean } = {}): Promise<ApiAnswer> {
    return probeCollectionCreate(api, spec, {
        type: 'users',
        path: '/api/v1/users',
        nameField: 'username',
        body: { username, ...(await userBody(api, username, { ...fields, description: 'REG run (API-AUTH probe)' })) },
        note: 'duplicate user probe',
    });
}

export async function probeRole(api: GuardedApi, spec: string, name: string, description = 'REG run (API-AUTH probe)'): Promise<ApiAnswer> {
    return probeCollectionCreate(api, spec, { type: 'roles', path: '/api/v1/roles', body: { name, ...(await roleBody(api, { description })) }, note: 'duplicate role probe' });
}

export async function setOwnUserEnabled(api: GuardedApi, user: OwnRef, enabled: boolean): Promise<ApiAnswer> {
    assertGuarded(api, 'setOwnUserEnabled');
    await assertOwnLive(api, 'users', user, 'setOwnUserEnabled');
    await assertNotCaller(api, user.uuid, `${enabled ? 'enable' : 'disable'} user`);
    return answered(() => api.patch(`/api/v1/users/${user.uuid}/${enabled ? 'enable' : 'disable'}`));
}

export async function updateOwnUser(api: GuardedApi, user: OwnRef, fields: { firstName?: string; lastName?: string; email?: string; description?: string }): Promise<ApiAnswer> {
    assertGuarded(api, 'updateOwnUser');
    await assertOwnLive(api, 'users', user, 'updateOwnUser');
    const customAttributes = await requiredCustomAttributes(api, 'users', runName('ca'));
    return answered(() => api.put(`/api/v1/users/${user.uuid}`, { data: { groupUuids: [], customAttributes, ...fields } }));
}

export async function addOwnUserRole(api: GuardedApi, user: OwnRef, role: OwnRef): Promise<ApiAnswer> {
    assertGuarded(api, 'addOwnUserRole');
    await assertOwnLive(api, 'users', user, 'addOwnUserRole (user)');
    await assertOwnLive(api, 'roles', role, 'addOwnUserRole (role)');
    return answered(() => api.put(`/api/v1/users/${user.uuid}/roles/${role.uuid}`, { data: {} }));
}

export async function removeOwnUserRole(api: GuardedApi, user: OwnRef, role: OwnRef): Promise<ApiAnswer> {
    assertGuarded(api, 'removeOwnUserRole');
    await assertOwnLive(api, 'users', user, 'removeOwnUserRole (user)');
    await assertOwnLive(api, 'roles', role, 'removeOwnUserRole (role)');
    return answered(() => api.delete(`/api/v1/users/${user.uuid}/roles/${role.uuid}`));
}

export async function replaceOwnUserRoles(api: GuardedApi, user: OwnRef, roles: OwnRef[]): Promise<ApiAnswer> {
    assertGuarded(api, 'replaceOwnUserRoles');
    await assertOwnLive(api, 'users', user, 'replaceOwnUserRoles (user)');
    for (const r of roles) await assertOwnLive(api, 'roles', r, 'replaceOwnUserRoles (role)');
    return answered(() => api.patch(`/api/v1/users/${user.uuid}/roles`, { data: roles.map((r) => r.uuid) }));
}

export async function replaceOwnRoleUsers(api: GuardedApi, role: OwnRef, users: OwnRef[]): Promise<ApiAnswer> {
    assertGuarded(api, 'replaceOwnRoleUsers');
    await assertOwnLive(api, 'roles', role, 'replaceOwnRoleUsers (role)');
    for (const u of users) await assertOwnLive(api, 'users', u, 'replaceOwnRoleUsers (user)');
    return answered(() => api.patch(`/api/v1/roles/${role.uuid}/users`, { data: users.map((u) => u.uuid) }));
}

/** `PUT /v1/roles/{r}` on an OWN role; `name` is sent on purpose when given (the contract accepts and ignores it). */
export async function updateOwnRole(api: GuardedApi, role: OwnRef, fields: { name?: string; description?: string; email?: string }): Promise<ApiAnswer> {
    assertGuarded(api, 'updateOwnRole');
    await assertOwnLive(api, 'roles', role, 'updateOwnRole');
    const customAttributes = await requiredCustomAttributes(api, 'roles', runName('ca'));
    return answered(() => api.put(`/api/v1/roles/${role.uuid}`, { data: { customAttributes, ...fields } }));
}

interface ResourceGrant {
    name: string;
    allowAllActions?: boolean;
    actions?: string[];
    objects?: Array<{ uuid: string; name: string; allow?: string[]; deny?: string[] }>;
}

export interface PermissionDocument {
    allowAllResources: boolean;
    resources?: ResourceGrant[];
}

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

export async function saveOwnPermissions(api: GuardedApi, role: OwnRef, doc: PermissionDocument): Promise<ApiAnswer> {
    assertGuarded(api, 'saveOwnPermissions');
    await assertOwnLive(api, 'roles', role, 'saveOwnPermissions');
    return answered(() => api.post(`/api/v1/roles/${role.uuid}/permissions`, { data: permissionBody(doc) }));
}

export async function readPermissions(api: APIRequestContext, roleUuid: string): Promise<JsonObject> {
    return apiJson(api, 'GET', `/api/v1/roles/${roleUuid}/permissions`);
}

/**
 * Delete an OWN user or role, wait until the list no longer names it, then close its ledger line; only the list decides (core#2511).
 * Returns the DELETE status.
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
