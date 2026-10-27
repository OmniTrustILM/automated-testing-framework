/**
 * groupProbes — group helpers of the group CRUD and assignment API specs.
 *
 * WHAT: Group helpers of the group-crud and group-assignment API specs: own groups and group create probes (ledger before any
 *       assertion), group assignment on own certificates, and the readers of the certificate history that turn
 *       `Update Group` events into comparable group changes.
 * WHY: Group creates and assignments must be recorded like any create and must read their effect from the certificate history.
 * HOW: Own groups and create probes recorded before any assertion, assignment on own certificates, and readers that turn `Update Group`
 * history events into group changes.
 */
import type { APIRequestContext } from '@playwright/test';
import { assertGuarded } from '../guard/types';
import type { GuardedApi } from '../guard/types';
import { readJsonOk, send, readAnswer } from './searchApi';
import { probeCollectionCreate } from '../ownCrud';
import { ApiAnswer } from '../apiReads';
import { JsonObject } from '../json';

// ------------------------------------------------------------------ groups

/** `POST /v1/groups` with any body; the status never throws, an accepted create is in the ledger before this returns. */
export async function probeGroup(api: GuardedApi, spec: string, body: JsonObject, note = 'group create probe'): Promise<ApiAnswer> {
    return probeCollectionCreate(api, spec, { type: 'groups', path: '/api/v1/groups', body, note });
}

/** `PUT /v1/groups/{own}` (the body is whatever the row sends: the `name` is ignored by core, omitted members are cleared). */
export async function putGroup(api: GuardedApi, uuid: string, body: JsonObject): Promise<ApiAnswer> {
    return send(assertGuarded(api, 'putGroup'), 'PUT', `/api/v1/groups/${uuid}`, { data: body });
}

/** `GET /v1/groups/{uuid}` (status and body never throw). */
export const readGroup = (api: APIRequestContext, uuid: string): Promise<ApiAnswer> => readAnswer(api, `/api/v1/groups/${uuid}`);

// ------------------------------------------------------------------ own certificates, groups on certificates, history

/** `GET /v1/certificates/{uuid}` as JSON (a non-200 throws). */
export async function certificateDetail(api: APIRequestContext, uuid: string): Promise<JsonObject> {
    return readJsonOk<JsonObject>(await readAnswer(api, `/api/v1/certificates/${uuid}`), `GET certificate ${uuid}`);
}

/** `PATCH /v1/certificates/{own}` with any body (`groupUuids`, `ownerUuid`, or `{}`); status and body never throw. */
export async function patchCertificate(api: GuardedApi, uuid: string, body: JsonObject): Promise<ApiAnswer> {
    return send(assertGuarded(api, 'patchCertificate'), 'PATCH', `/api/v1/certificates/${uuid}`, { data: body });
}

/** `PATCH /v1/certificates/{own}/archive`; requires 204 (the archived certificate is the precondition of its row). */
export async function archiveOwnCertificate(api: GuardedApi, uuid: string): Promise<void> {
    const p = await send(assertGuarded(api, 'archiveOwnCertificate'), 'PATCH', `/api/v1/certificates/${uuid}/archive`);
    if (p.status !== 204) throw new Error(`archiving the own certificate answered ${p.status} ${p.text.slice(0, 300)}`);
}

/** `GET /v1/certificates/{uuid}/history` (a non-200 throws). */
export async function certificateHistory(api: APIRequestContext, uuid: string): Promise<JsonObject[]> {
    const events = readJsonOk<JsonObject[]>(await readAnswer(api, `/api/v1/certificates/${uuid}/history`), `GET certificate history ${uuid}`);
    if (!Array.isArray(events)) throw new Error('the certificate history is not a list');
    return events;
}

/** The event code of a group change in the history (CertificateEvent.UPDATE_GROUP code). */
const GROUP_EVENT = 'Update Group';

export interface GroupChange {
    /** The group names before and after, sorted; 'undefined' (no group) is the empty list. */
    from: string[];
    to: string[];
}

/**
 * The text core writes into the history for a group change (CertificateServiceImpl.updateCertificateGroups): `<old> -> <new>`,
 * each side the group names joined with ", " in no defined order, or `undefined` when there is none. Names are compared as
 * sorted sets. A message without " -> " is not a group change.
 */
export function parseGroupChange(message: string): GroupChange | undefined {
    const i = message.indexOf(' -> ');
    if (i < 0) return undefined;
    const side = (s: string): string[] => (s === 'undefined' ? [] : s.split(', ').filter(Boolean).sort());
    return { from: side(message.slice(0, i)), to: side(message.slice(i + 4)) };
}

/** The group changes in a history, as `from -> to` pairs (successful `Update Group` events only), in the order given. */
export function groupChanges(events: JsonObject[]): GroupChange[] {
    return events
        .filter((e) => e?.event === GROUP_EVENT && e?.status === 'SUCCESS' && typeof e?.message === 'string')
        .map((e) => parseGroupChange(String(e.message)))
        .filter((c): c is GroupChange => !!c);
}

/** A group change as one comparable string (`a, b -> c`, `undefined` for none), names sorted. */
export const changeKey = (c: GroupChange): string => `${c.from.length ? c.from.join(', ') : 'undefined'} -> ${c.to.length ? c.to.join(', ') : 'undefined'}`;

/** How many `Update Group` events a certificate's history holds. */
export const groupEventCount = (events: JsonObject[]): number => events.filter((e) => e?.event === GROUP_EVENT).length;
