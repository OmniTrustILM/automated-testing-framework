/**
 * groupProbes — group helpers of the group-crud and group-assignment API specs: own groups and create probes (ledger before any assertion),
 * group assignment on own certificates, and readers that turn `Update Group` history events into comparable changes.
 */
import type { APIRequestContext } from '@playwright/test';
import { assertGuarded } from '../guard/types';
import type { GuardedApi } from '../guard/types';
import { readJsonOk, send, readAnswer } from './searchApi';
import { probeCollectionCreate } from '../ownCrud';
import { ApiAnswer } from '../apiReads';
import { JsonObject } from '../json';


export async function probeGroup(api: GuardedApi, spec: string, body: JsonObject, note = 'group create probe'): Promise<ApiAnswer> {
    return probeCollectionCreate(api, spec, { type: 'groups', path: '/api/v1/groups', body, note });
}

export async function putGroup(api: GuardedApi, uuid: string, body: JsonObject): Promise<ApiAnswer> {
    return send(assertGuarded(api, 'putGroup'), 'PUT', `/api/v1/groups/${uuid}`, { data: body });
}

export const readGroup = (api: APIRequestContext, uuid: string): Promise<ApiAnswer> => readAnswer(api, `/api/v1/groups/${uuid}`);


export async function certificateDetail(api: APIRequestContext, uuid: string): Promise<JsonObject> {
    return readJsonOk<JsonObject>(await readAnswer(api, `/api/v1/certificates/${uuid}`), `GET certificate ${uuid}`);
}

export async function patchCertificate(api: GuardedApi, uuid: string, body: JsonObject): Promise<ApiAnswer> {
    return send(assertGuarded(api, 'patchCertificate'), 'PATCH', `/api/v1/certificates/${uuid}`, { data: body });
}

export async function archiveOwnCertificate(api: GuardedApi, uuid: string): Promise<void> {
    const p = await send(assertGuarded(api, 'archiveOwnCertificate'), 'PATCH', `/api/v1/certificates/${uuid}/archive`);
    if (p.status !== 204) throw new Error(`archiving the own certificate answered ${p.status} ${p.text.slice(0, 300)}`);
}

export async function certificateHistory(api: APIRequestContext, uuid: string): Promise<JsonObject[]> {
    const events = readJsonOk<JsonObject[]>(await readAnswer(api, `/api/v1/certificates/${uuid}/history`), `GET certificate history ${uuid}`);
    if (!Array.isArray(events)) throw new Error('the certificate history is not a list');
    return events;
}

const GROUP_EVENT = 'Update Group';

export interface GroupChange {
    from: string[];
    to: string[];
}

/**
 * The history text for a group change: `<old> -> <new>`, names joined with ", " in no defined order (compared as sorted sets), or
 * `undefined` for none; a message without " -> " is not a group change.
 */
export function parseGroupChange(message: string): GroupChange | undefined {
    const i = message.indexOf(' -> ');
    if (i < 0) return undefined;
    const side = (s: string): string[] => (s === 'undefined' ? [] : s.split(', ').filter(Boolean).sort());
    return { from: side(message.slice(0, i)), to: side(message.slice(i + 4)) };
}

export function groupChanges(events: JsonObject[]): GroupChange[] {
    return events
        .filter((e) => e?.event === GROUP_EVENT && e?.status === 'SUCCESS' && typeof e?.message === 'string')
        .map((e) => parseGroupChange(String(e.message)))
        .filter((c): c is GroupChange => !!c);
}

export const changeKey = (c: GroupChange): string => `${c.from.length ? c.from.join(', ') : 'undefined'} -> ${c.to.length ? c.to.join(', ') : 'undefined'}`;

export const groupEventCount = (events: JsonObject[]): number => events.filter((e) => e?.event === GROUP_EVENT).length;
