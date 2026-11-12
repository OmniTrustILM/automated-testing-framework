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
    /** Default false: a user the suite creates cannot sign in (it has no identity-provider account anyway). */
    enabled?: boolean;
    description?: string;
}

/** The request body of a user create without its username (every required custom attribute of users filled). */
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
    /** A planned username (the seed owner, the dedicated second identity); default `ownName(suffix)`. */
    name?: string;
}

/** A NEW run user, `<run>-<suffix>-<unique>`, recorded in the ledger right after the create call. */
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

/** Replaces the roles of an OWN user with OWN roles (`PATCH /v1/users/{user}/roles`); every object is checked live. */
export async function setOwnUserRoles(api: GuardedApi, user: OwnRef, roles: OwnRef[]): Promise<void> {
    await assertOwnLive(api, 'users', user, 'setOwnUserRoles (user)');
    for (const r of roles) await assertOwnLive(api, 'roles', r, 'setOwnUserRoles (role)');
    await apiJson(api, 'PATCH', `/api/v1/users/${user.uuid}/roles`, roles.map((r) => r.uuid));
}
