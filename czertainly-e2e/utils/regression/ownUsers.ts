/** ownUsers — the users this run creates and the role assignments of its own users. */
import { GuardedApi } from './guard/types';
import { assertOwnLive } from './ledger/ownership';
import { apiJson } from './apiReads';
import { createOwn } from './ownCrud';
import { requiredCustomAttributes } from './customAttributes';
import { OwnRef } from './ledger/ledger';
import { runName, runId, ownName } from './ledger/runState';

export interface UserFields {
    firstName?: string;
    lastName?: string;
    email?: string;
    enabled?: boolean;
    description?: string;
}

export async function userBody(api: GuardedApi, username: string, fields: UserFields = {}): Promise<Record<string, unknown>> {
    return {
        firstName: fields.firstName ?? 'QA',
        lastName: fields.lastName ?? 'Regression',
        email: fields.email ?? `${username}@example.test`,
        enabled: fields.enabled ?? false,
        description: fields.description ?? `REG run ${runId()}`,
        groupUuids: [],
        customAttributes: await requiredCustomAttributes(api, 'users', runName('ca')),
    };
}

export interface UserOptions extends UserFields {
    note?: string;
    name?: string;
}

export async function createOwnUser(api: GuardedApi, spec: string, suffix: string, o: UserOptions = {}): Promise<OwnRef> {
    const username = o.name ?? ownName(suffix);
    const { answer: _answer, ...ref } = await createOwn(api, spec, {
        type: 'users',
        path: '/api/v1/users',
        name: username,
        nameField: 'username',
        note: o.note ?? 'API prerequisite',
        body: await userBody(api, username, o),
    });
    return ref;
}

export async function setOwnUserRoles(api: GuardedApi, user: OwnRef, roles: OwnRef[]): Promise<void> {
    await assertOwnLive(api, 'users', user, 'setOwnUserRoles (user)');
    for (const r of roles) await assertOwnLive(api, 'roles', r, 'setOwnUserRoles (role)');
    await apiJson(api, 'PATCH', `/api/v1/users/${user.uuid}/roles`, roles.map((r) => r.uuid));
}
