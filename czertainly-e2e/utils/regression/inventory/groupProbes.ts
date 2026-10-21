/**
 * Group helpers of the group-crud and group-assignment API specs: own groups and group create probes (ledger before any
 * assertion), group assignment on own certificates, and the readers of the certificate history that turn
 * `Update Group` events into comparable group changes.
 */
import type { APIRequestContext } from '@playwright/test';
import { assertGuarded } from '../guard/types';
import type { GuardedApi } from '../guard/types';
import { readJsonOk, readProbe, send } from './searchApi';
import type { Json, Probe } from './searchApi';
import { requiredCustomAttributes } from '../customAttributes';
import { recordCreated } from '../ledger/ledger';
import { runName } from '../ledger/runState';
import { uniqueStamp } from '../text';
import type { OwnRef } from '../ledger/ledger';
import { CreateAttempt, createAttempt, createdUuid } from './credentialsApi';

// ------------------------------------------------------------------ groups

export interface GroupFields {
    description?: string | null;
    email?: string | null;
    customAttributes?: Json[];
}

/** A `POST /v1/groups` body (`name` may be anything: the negative rows send blank, null and whitespace). */
export const groupBody = (name: unknown, fields: GroupFields = {}): Json => ({ name, ...fields });

/** `POST /v1/groups` with any body; the status never throws, an accepted create is in the ledger before this returns. */
export async function createGroupProbe(api: GuardedApi, body: Json, spec: string, note = 'group create probe'): Promise<CreateAttempt> {
    return createAttempt(api, '/api/v1/groups', 'groups', body, spec, note);
}

/** A NEW own group (201 required; ledger first; any required custom attribute of the tier filled). */
export async function ownGroup(api: GuardedApi, spec: string, fields: GroupFields = {}, opts: { suffix?: string; note?: string } = {}): Promise<OwnRef & { description?: string | null; email?: string | null }> {
    const name = runName(`${opts.suffix ?? 'grp'}-${uniqueStamp()}`);
    const customAttributes = [...(await requiredCustomAttributes(api, 'groups', runName('ca'))), ...(fields.customAttributes ?? [])];
    const { probe, own } = await createGroupProbe(api, groupBody(name, { ...fields, customAttributes }), spec, opts.note ?? 'own group (API prerequisite)');
    if (probe.status !== 201 || !own) throw new Error(`creating the own group answered ${probe.status} ${probe.text.slice(0, 300)}`);
    return { ...own, description: fields.description, email: fields.email };
}

/** `PUT /v1/groups/{own}` (the body is whatever the row sends: the `name` is ignored by core, omitted members are cleared). */
export async function putGroup(api: GuardedApi, uuid: string, body: Json): Promise<Probe> {
    return send(assertGuarded(api, 'putGroup'), 'PUT', `/api/v1/groups/${uuid}`, { data: body });
}

/** `GET /v1/groups/{uuid}` (status and body never throw). */
export const readGroup = (api: APIRequestContext, uuid: string): Promise<Probe> => readProbe(api, `/api/v1/groups/${uuid}`);

export interface OwnAttribute {
    ref: OwnRef;
    name: string;
    uuid: string;
}

/** An own, NOT required string custom attribute on groups (the "omitted custom attributes lose their content" rows); ledger first. */
export async function ownGroupAttribute(api: GuardedApi, spec: string): Promise<OwnAttribute> {
    const name = runName(`grp-attr-${uniqueStamp()}`);
    const probe = await send(assertGuarded(api, 'ownGroupAttribute'), 'POST', '/api/v1/attributes/custom', {
        data: {
            name, label: `Group attribute ${uniqueStamp()}`, description: 'own, not required (API-GEN-19)', contentType: 'string', required: false,
            visible: true, readOnly: false, list: false, multiSelect: false, resources: ['groups'],
        },
    });
    const uuid = createdUuid(probe);
    const ref = uuid ? recordCreated('customAttributes', { uuid, name }, spec, 'own custom attribute on groups, not required') : undefined;
    if (!ref || !uuid) throw new Error(`creating the own custom attribute answered ${probe.status} ${probe.text.slice(0, 300)}`);
    return { ref, name, uuid };
}

// ------------------------------------------------------------------ own certificates, groups on certificates, history

/** `GET /v1/certificates/{uuid}` as JSON (a non-200 throws). */
export async function certificateDetail(api: APIRequestContext, uuid: string): Promise<Json> {
    return readJsonOk<Json>(await readProbe(api, `/api/v1/certificates/${uuid}`), `GET certificate ${uuid}`);
}

/** `PATCH /v1/certificates/{own}` with any body (`groupUuids`, `ownerUuid`, or `{}`); status and body never throw. */
export async function patchCertificate(api: GuardedApi, uuid: string, body: Json): Promise<Probe> {
    return send(assertGuarded(api, 'patchCertificate'), 'PATCH', `/api/v1/certificates/${uuid}`, { data: body });
}

/** `PATCH /v1/certificates/{own}/archive`; requires 204 (the archived certificate is the precondition of its row). */
export async function archiveOwnCertificate(api: GuardedApi, uuid: string): Promise<void> {
    const p = await send(assertGuarded(api, 'archiveOwnCertificate'), 'PATCH', `/api/v1/certificates/${uuid}/archive`);
    if (p.status !== 204) throw new Error(`archiving the own certificate answered ${p.status} ${p.text.slice(0, 300)}`);
}

/** `GET /v1/certificates/{uuid}/history` (a non-200 throws). */
export async function certificateHistory(api: APIRequestContext, uuid: string): Promise<Json[]> {
    const events = readJsonOk<Json[]>(await readProbe(api, `/api/v1/certificates/${uuid}/history`), `GET certificate history ${uuid}`);
    if (!Array.isArray(events)) throw new Error('the certificate history is not a list');
    return events;
}

/** The event code of a group change in the history (CertificateEvent.UPDATE_GROUP code). */
export const GROUP_EVENT = 'Update Group';

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
export function groupChanges(events: Json[]): GroupChange[] {
    return events
        .filter((e) => e?.event === GROUP_EVENT && e?.status === 'SUCCESS' && typeof e?.message === 'string')
        .map((e) => parseGroupChange(String(e.message)))
        .filter((c): c is GroupChange => !!c);
}

/** A group change as one comparable string (`a, b -> c`, `undefined` for none), names sorted. */
export const changeKey = (c: GroupChange): string => `${c.from.length ? c.from.join(', ') : 'undefined'} -> ${c.to.length ? c.to.join(', ') : 'undefined'}`;

/** How many `Update Group` events a certificate's history holds. */
export const groupEventCount = (events: Json[]): number => events.filter((e) => e?.event === GROUP_EVENT).length;
