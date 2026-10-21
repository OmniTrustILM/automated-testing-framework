/**
 * ownCrud — the one `deleteOwn` for a DELETE that is itself the behaviour under test: it refuses anything that is not a
 * live object of this run, sends `DELETE <collection>/<uuid>` through the guard, writes the `deleted` ledger line only when
 * the platform accepted it (200 / 204), and hands the answer back as `{ status, body, text }` so the test asserts it (a
 * refusal such as "still used by …" is a result, not an error). It does not wait for the object to leave its list.
 */
import type { GuardedApi } from './guard/types';
import { assertGuarded } from './guard/types';
import { assertOwnLive } from './ledger/ownership';
import { OwnRef, recordDeleted } from './ledger/ledger';

/** The collection path of each ledger type `deleteOwn` can remove (ledger type → API path without the uuid). */
export const OWN_DELETE_PATHS = {
    conditions: '/api/v1/workflows/conditions',
    rules: '/api/v1/workflows/rules',
    executions: '/api/v1/workflows/executions',
    actions: '/api/v1/workflows/actions',
    triggers: '/api/v1/workflows/triggers',
    notificationInstances: '/api/v1/notificationInstances',
    notificationProfiles: '/api/v1/notificationProfiles',
    credentials: '/api/v1/credentials',
    groups: '/api/v1/groups',
    users: '/api/v1/users',
    roles: '/api/v1/roles',
} as const;

export type OwnDeletableType = keyof typeof OWN_DELETE_PATHS;

export interface DeleteOutcome {
    status: number;
    /** The parsed JSON body, or undefined when it is empty or not JSON. */
    body: unknown;
    text: string;
}

/** `DELETE` of an own live object; the `deleted` ledger line follows an accepted delete (200 / 204) only. */
export async function deleteOwn(api: GuardedApi, type: OwnDeletableType, ref: OwnRef, spec: string, note = 'deleted as the behaviour under test'): Promise<DeleteOutcome> {
    assertGuarded(api, `deleteOwn ${type}`);
    await assertOwnLive(api, type, ref, `deleteOwn ${type}`);
    const res = await api.delete(`${OWN_DELETE_PATHS[type]}/${ref.uuid}`);
    const status = res.status();
    const text = await res.text();
    let body: unknown;
    try {
        body = text ? JSON.parse(text) : undefined;
    } catch {
        body = undefined;
    }
    if (status === 200 || status === 204) recordDeleted(type, ref, spec, note);
    return { status, body, text };
}
