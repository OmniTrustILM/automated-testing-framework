/**
 * ownCrud — the one create and the one delete of an own object.
 *
 *   - `createOwn` POSTs a collection and writes the ledger line BEFORE anything is asserted.
 *   - `deleteOwn` refuses anything that is not a live object of this run, and writes the `deleted` line only when the
 *     platform accepted the delete. It hands the answer back for the test to assert.
 *
 * This keeps "recorded before asserted", "an accepted create is never left off the ledger" and "only a live own object is
 * removed" true in one place.
 */
import { ApiAnswer, answerOf } from './apiReads';
import type { GuardedApi } from './guard/types';
import { assertGuarded } from './guard/types';
import { assertOwnLive } from './ledger/ownership';
import { OwnRef, recordCreated, recordDeleted } from './ledger/ledger';
import { OwnDeletableType, ownDeletePathsOf } from './resourceTypes';
import type { LedgerLine } from './ledger/ledger';
import { send } from './inventory/searchApi';

// ------------------------------------------------------------------ create

const CANONICAL_UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/** The uuid of a 2xx create answer (`{ "uuid": "<canonical>" }`), or undefined. */
export function createdUuid(answer: ApiAnswer): string | undefined {
    const uuid = answer.status >= 200 && answer.status < 300 && answer.json && typeof answer.json === 'object' ? answer.json.uuid : undefined;
    return typeof uuid === 'string' && CANONICAL_UUID.test(uuid) ? uuid : undefined;
}

export interface CreateOwnDescriptor {
    /** The ledger type = the API resource (`groups`, `roles`, ...). */
    type: string;
    /** The collection URL the create is POSTed to. */
    path: string;
    /** The run-prefixed name of the new object (`ownName(suffix)`). */
    name: string;
    /** The member that carries the name in the request body (default `name`; users: `username`). */
    nameField?: string;
    /** The rest of the request body. */
    body: Record<string, unknown>;
    /** The ledger note. */
    note: string;
    /** The objects a later change or delete needs. */
    parents?: LedgerLine['parents'];
}

/**
 * POST a collection for a new own object. The ledger line is written from the answer BEFORE the caller asserts anything; a
 * refusal (no 2xx, or no uuid) throws with the status and the start of the body: a create the caller needs is a positive step.
 */
export async function createOwn(api: GuardedApi, spec: string, o: CreateOwnDescriptor): Promise<OwnRef & { answer: ApiAnswer }> {
    assertGuarded(api, `createOwn ${o.type}`);
    const answer = await send(api, 'POST', o.path, { data: { ...o.body, [o.nameField ?? 'name']: o.name } });
    const uuid = createdUuid(answer);
    if (!uuid) throw new Error(`POST ${o.path} → ${answer.status} ${answer.text.slice(0, 400)}`);
    const ref = recordCreated(o.type, { uuid, name: o.name }, { spec, note: o.note, ...(o.parents ? { parents: o.parents } : {}), serverAt: answer.serverAt });
    return { ...ref, answer };
}

/**
 * The record step of a create the platform may refuse (a probe, or a copy the connector may reject): a 2xx answer with a uuid is an object
 * this run made, so it goes on the ledger (a name that is not a string is recorded as a placeholder: it carries no run prefix, so the
 * teardown reports it and never deletes it). Returns the reference, or undefined when the platform refused as expected.
 */
export function recordIfAccepted(type: string, answer: ApiAnswer, name: unknown, spec: string, note: string, parents?: LedgerLine['parents']): OwnRef | undefined {
    const uuid = createdUuid(answer);
    if (!uuid) return undefined;
    return recordCreated(type, { uuid, name: typeof name === 'string' ? name : '(no name)' }, { spec, note, ...(parents ? { parents } : {}), serverAt: answer.serverAt });
}

export interface ProbeCreateDescriptor {
    type: string;
    path: string;
    /** The request body as the negative row builds it (any shape). */
    body: unknown;
    note: string;
    parents?: LedgerLine['parents'];
    /** The member that carries the name in the body (default `name`; users: `username`). */
    nameField?: string;
}

/** POST a collection with any body and hand the answer back; a 2xx is recorded first (`recordIfAccepted`). The status never throws. */
export async function probeCollectionCreate(api: GuardedApi, spec: string, o: ProbeCreateDescriptor): Promise<ApiAnswer> {
    assertGuarded(api, `probe ${o.type} create`);
    const answer = await send(api, 'POST', o.path, { data: o.body });
    const name = o.body && typeof o.body === 'object' ? (o.body as Record<string, unknown>)[o.nameField ?? 'name'] : undefined;
    recordIfAccepted(o.type, answer, name, spec, `${o.note} (accepted although a refusal was expected)`, o.parents);
    return answer;
}

// ------------------------------------------------------------------ delete

/** The collection path of each ledger type `deleteOwn` can remove (registry entries with an `ownDeletePath`). */
export const OWN_DELETE_PATHS = ownDeletePathsOf() as Record<OwnDeletableType, string>;

export type { OwnDeletableType };

export interface DeleteOwnOptions {
    /** The ledger note of the `deleted` line. */
    note?: string;
    /**
     * Proof that the object is gone, run after an accepted DELETE and BEFORE the `deleted` line is written: a throw leaves the
     * ledger as it was, so the teardown still sees the object.
     */
    readBack?: () => Promise<void>;
    /** Statuses that count as accepted besides 200 / 204 (a key delete tolerates 404: it may be gone already). */
    alsoAccept?: readonly number[];
}

/** `DELETE` of an own live object; the `deleted` ledger line follows an accepted delete (200 / 204) and its read-back only. */
export async function deleteOwn(api: GuardedApi, type: OwnDeletableType, ref: OwnRef, spec: string, o: DeleteOwnOptions = {}): Promise<ApiAnswer> {
    assertGuarded(api, `deleteOwn ${type}`);
    await assertOwnLive(api, type, ref, `deleteOwn ${type}`);
    const started = Date.now();
    const answer = await answerOf(await api.delete(`${OWN_DELETE_PATHS[type]}/${ref.uuid}`), started);
    if (answer.status === 200 || answer.status === 204 || o.alsoAccept?.includes(answer.status)) {
        await o.readBack?.();
        recordDeleted(type, ref, spec, o.note ?? 'deleted as the behaviour under test');
    }
    return answer;
}
