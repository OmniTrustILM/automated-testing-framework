/** ownUsers — the users this run creates and the role assignments of its own users. */
import { GuardedApi } from './guard/types';
import { assertOwnLive } from './ledger/ownership';
import { apiJson } from './apiReads';
import { requiredCustomAttributes } from './customAttributes';
import { OwnRef, recordCreated, Ref } from './ledger/ledger';
import { runName, runId } from './ledger/runState';
import { timestampSuffix } from './text';

type Json = Record<string, any>;

export interface UserFields {
    firstName?: string;
    lastName?: string;
    email?: string;
    /** Default false: a user the suite creates cannot sign in (it has no identity-provider account anyway). */
    enabled?: boolean;
}

/** `POST /v1/users` for a run-prefixed username (any required custom attribute filled); returns the Ref (not recorded). */
export async function createUser(api: GuardedApi, username: string, fields: UserFields = {}): Promise<Ref> {
    const created = await apiJson<Json>(api, 'POST', '/api/v1/users', {
        username,
        firstName: fields.firstName ?? 'QA',
        lastName: fields.lastName ?? 'Regression',
        email: fields.email ?? `${username}@example.test`,
        enabled: fields.enabled ?? false,
        description: `REG run ${runId()}`,
        groupUuids: [],
        customAttributes: await requiredCustomAttributes(api, 'users', runName('ca')),
    });
    return { uuid: created.uuid, name: username };
}

/** A NEW run user, `<run>-<suffix>-<time>`, recorded in the ledger right after the create call. */
export async function createOwnUser(api: GuardedApi, spec: string, suffix: string, fields: UserFields = {}, note = 'API prerequisite'): Promise<OwnRef> {
    const ref = await createUser(api, runName(`${suffix}-${timestampSuffix()}`), fields);
    return recordCreated('users', ref, spec, note);
}

/** Replaces the roles of an OWN user with OWN roles (`PATCH /v1/users/{user}/roles`); every object is checked live. */
export async function setOwnUserRoles(api: GuardedApi, user: OwnRef, roles: OwnRef[]): Promise<void> {
    await assertOwnLive(api, 'users', user, 'setOwnUserRoles (user)');
    for (const r of roles) await assertOwnLive(api, 'roles', r, 'setOwnUserRoles (role)');
    await apiJson(api, 'PATCH', `/api/v1/users/${user.uuid}/roles`, roles.map((r) => r.uuid));
}
