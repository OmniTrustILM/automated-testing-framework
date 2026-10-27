/**
 * notificationProfiles — own notification profiles: create, probe, read, update and delete.
 *
 * WHAT: Builds the profile body for each recipient type, creates own profiles (recorded before any assertion), probes a create that may be
 * refused, reads versions, updates and deletes own profiles.
 * WHY: Profiles decide who receives a notification; their recipient rules are the behaviour under test and must be created create-only.
 * HOW: Every change first passes the live own-object check; the run-end teardown is notificationTeardown.ts.
 */

import { GuardedApi } from '../guard/types';
import { sendJson } from './workflowRequests';
import { createOwn, deleteOwn, probeCollectionCreate } from '../ownCrud';
import { OwnRef, recordCreated } from '../ledger/ledger';
import { runId, ownName } from '../ledger/runState';
import { assertOwnLive, checkOwnership } from '../ledger/ownership';
import { ApiAnswer } from '../apiReads';
import type { JsonObject } from '../json';
import { listInstances } from './notificationInstances';

export type RecipientCode = 'user' | 'group' | 'role' | 'owner' | 'none' | 'default' | 'object';

/** `NotificationDataCategory` code → label, as the profile detail page prints the categories (interfaces `NotificationDataCategory`). */
export const CATEGORY_LABEL: Record<string, string> = {
    customAttributes: 'Custom attributes',
    metadata: 'Metadata',
    associations: 'Associations',
    objectContent: 'Object content',
};


export interface ProfileOptions {
    recipientType: RecipientCode;
    /** USER / GROUP / ROLE need uuids (of OWN objects: the guard types them); OWNER / NONE / DEFAULT / OBJECT carry none. */
    recipients?: Array<{ uuid: string }>;
    instance?: { uuid: string };
    internal?: boolean;
    /** ISO-8601 days and hours (`P1DT12H`). */
    frequency?: string;
    repetitions?: number;
    categories?: string[];
    description?: string;
}

export function profileBody(name: string | undefined, o: ProfileOptions): JsonObject {
    return {
        ...(name !== undefined ? { name } : {}),
        description: o.description ?? `REG run ${runId()}`,
        recipientType: o.recipientType,
        ...(o.recipients ? { recipientUuids: o.recipients.map((r) => r.uuid) } : {}),
        ...(o.instance ? { notificationInstanceUuid: o.instance.uuid } : {}),
        internalNotification: o.internal ?? false,
        ...(o.frequency !== undefined ? { frequency: o.frequency } : {}),
        ...(o.repetitions !== undefined ? { repetitions: o.repetitions } : {}),
        ...(o.categories ? { eventDataCategories: o.categories } : {}),
    };
}

export interface OwnProfile extends OwnRef {
    body: JsonObject;
}

/** Creates an own profile (ledger before assertion); throws on a refusal: a positive step. */
export async function createOwnProfile(api: GuardedApi, spec: string, suffix: string, o: ProfileOptions): Promise<OwnProfile> {
    const name = ownName(suffix);
    const { name: _name, ...body } = profileBody(name, o);
    const { answer, ...ref } = await createOwn(api, spec, { type: 'notificationProfiles', path: '/api/v1/notificationProfiles', name, body, note: `notification profile (${o.recipientType}${o.internal ? ', internal' : ''})` });
    return { ...ref, body: answer.json };
}

/** An internal-only profile (no instance, no connector): the only kind a shared-tier firing may use (nothing is delivered). */
export const createOwnInternalProfile = (api: GuardedApi, spec: string, suffix: string, o: { recipientType: Exclude<RecipientCode, 'none' | 'default' | 'object'>; recipients?: Array<{ uuid: string }> }): Promise<OwnProfile> =>
    createOwnProfile(api, spec, suffix, { recipientType: o.recipientType, ...(o.recipients ? { recipients: o.recipients } : {}), internal: true });

/**
 * Ledger before assertion for a REFUSED create that may still have persisted something (a 404 raised after the save, a
 * partial create): every instance / profile of this run's prefix with exactly this name that the ledger does not know yet is
 * recorded, so the teardown removes it and the assertion that follows is about the refusal, not about a leftover.
 */
export async function recordNamed(api: GuardedApi, kind: 'instances' | 'profiles', name: string, spec: string): Promise<string[]> {
    if (!name.startsWith(`${runId()}-`)) return [];
    const rows = kind === 'instances' ? await listInstances(api) : await listProfiles(api);
    const found = rows.filter((r) => r.name === name);
    const type = kind === 'instances' ? 'notificationInstances' : 'notificationProfiles';
    for (const r of found) if (!checkOwnership({ uuid: String(r.uuid) }).own) recordCreated(type, { uuid: String(r.uuid), name }, { spec, note: 'persisted by a refused create' });
    return found.map((r) => String(r.uuid));
}

/** A negative probe: POST as is; an accepted one is recorded so the teardown removes it. */
export async function probeProfile(api: GuardedApi, spec: string, body: JsonObject): Promise<ApiAnswer> {
    return probeCollectionCreate(api, spec, { type: 'notificationProfiles', path: '/api/v1/notificationProfiles', body, note: 'profile create probe' });
}

/** Every profile of the tier, all pages of `GET /v1/notificationProfiles` (read-only). */
export async function listProfiles(api: GuardedApi): Promise<JsonObject[]> {
    const rows: JsonObject[] = [];
    for (let page = 1; ; page++) {
        const sent = await sendJson(api, 'GET', `/api/v1/notificationProfiles?itemsPerPage=100&pageNumber=${page}`);
        if (sent.status !== 200) throw new Error(`GET /v1/notificationProfiles answered ${sent.status}`);
        rows.push(...((sent.json?.notificationProfiles ?? []) as JsonObject[]));
        if (page >= Number(sent.json?.totalPages ?? 0)) break;
    }
    return rows;
}

export async function getProfile(api: GuardedApi, uuid: string, version?: number): Promise<ApiAnswer> {
    return sendJson(api, 'GET', `/api/v1/notificationProfiles/${uuid}${version !== undefined ? `?version=${version}` : ''}`);
}

export async function putOwnProfile(api: GuardedApi, ref: OwnRef, body: JsonObject): Promise<ApiAnswer> {
    await assertOwnLive(api, 'notificationProfiles', ref, 'putOwnProfile');
    return sendJson(api, 'PUT', `/api/v1/notificationProfiles/${ref.uuid}`, body);
}

/** `DELETE` of an own profile through `ownCrud.deleteOwn`; a 204 is recorded, a refusal (422, naming what uses it) is returned. */
export async function deleteOwnProfile(api: GuardedApi, ref: OwnRef, spec: string): Promise<ApiAnswer> {
    return deleteOwn(api, 'notificationProfiles', ref, spec);
}

/** The seconds of a duration the platform answered: an ISO-8601 string of days / hours (`P1DT12H`) or a number of seconds. */
export function durationSeconds(value: unknown): number | undefined {
    if (typeof value === 'number') return value;
    if (typeof value !== 'string') return undefined;
    const m = /^P(?:(\d+)D)?(?:T(?:(\d+)H)?(?:(\d+)M)?(?:(\d+(?:\.\d+)?)S)?)?$/.exec(value);
    if (!m) return undefined;
    return Number(m[1] ?? 0) * 86400 + Number(m[2] ?? 0) * 3600 + Number(m[3] ?? 0) * 60 + Number(m[4] ?? 0);
}
