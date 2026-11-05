/**
 * ownCrud — the one create and the one delete of an own object: `createOwn` writes the ledger line BEFORE anything is asserted;
 * `deleteOwn` refuses anything that is not a live object of this run and writes `deleted` only when the platform accepted the delete.
 */
import { ApiAnswer, answerOf } from './apiReads';
import type { GuardedApi } from './guard/types';
import { assertGuarded } from './guard/types';
import { assertOwnLive } from './ledger/ownership';
import { OwnRef, recordCreated, recordDeleted } from './ledger/ledger';
import { OwnDeletableType, ownDeletePathsOf } from './resourceTypes';
import type { LedgerLine } from './ledger/ledger';
import { send } from './inventory/searchApi';

const CANONICAL_UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export function createdUuid(answer: ApiAnswer): string | undefined {
    const uuid = answer.status >= 200 && answer.status < 300 && answer.json && typeof answer.json === 'object' ? answer.json.uuid : undefined;
    return typeof uuid === 'string' && CANONICAL_UUID.test(uuid) ? uuid : undefined;
}

export interface CreateOwnDescriptor {
    type: string;
    path: string;
    name: string;
    nameField?: string;
    body: Record<string, unknown>;
    note: string;
    parents?: LedgerLine['parents'];
}

/**
 * POST a collection for a new own object; the ledger line is written from
 * the answer before the caller asserts; a refusal (no 2xx or no uuid) throws.
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
 * The record step of a create the platform may refuse: a 2xx answer with a uuid is an object this run made and goes on the ledger (a
 * non-string name becomes a placeholder without the run prefix, never deleted). Returns undefined when refused as expected.
 */
export function recordIfAccepted(type: string, answer: ApiAnswer, name: unknown, spec: string, note: string, parents?: LedgerLine['parents']): OwnRef | undefined {
    const uuid = createdUuid(answer);
    if (!uuid) return undefined;
    return recordCreated(type, { uuid, name: typeof name === 'string' ? name : '(no name)' }, { spec, note, ...(parents ? { parents } : {}), serverAt: answer.serverAt });
}

export interface ProbeCreateDescriptor {
    type: string;
    path: string;
    body: unknown;
    note: string;
    parents?: LedgerLine['parents'];
    nameField?: string;
}

export async function probeCollectionCreate(api: GuardedApi, spec: string, o: ProbeCreateDescriptor): Promise<ApiAnswer> {
    assertGuarded(api, `probe ${o.type} create`);
    const answer = await send(api, 'POST', o.path, { data: o.body });
    const name = o.body && typeof o.body === 'object' ? (o.body as Record<string, unknown>)[o.nameField ?? 'name'] : undefined;
    recordIfAccepted(o.type, answer, name, spec, `${o.note} (accepted although a refusal was expected)`, o.parents);
    return answer;
}

export const OWN_DELETE_PATHS = ownDeletePathsOf() as Record<OwnDeletableType, string>;

export type { OwnDeletableType };

export interface DeleteOwnOptions {
    note?: string;
    /**
     * Proof that the object is gone, run after an accepted DELETE and before
     * the `deleted` line is written: a throw leaves the ledger as it was.
     */
    readBack?: () => Promise<void>;
    alsoAccept?: readonly number[];
}

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
