/**
 * notificationInstances — own notification instances: create, probe, read, update and delete.
 *
 * WHAT: Builds the instance body, creates own instances (recorded before any assertion), probes a create that may be refused, reads, updates and deletes own instances, and finds instances by name.
 * WHY: Instances are the sender side of a notification; they are created and validated only, delivery belongs to the local-stack rows with the catchers of notificationCatchers.ts.
 * HOW: Every change first passes the live own-object check; the run-end teardown is notificationTeardown.ts.
 */

import { GuardedApi } from '../guard/types';
import { sendJson } from './workflowRequests';
import { createOwn, deleteOwn, probeCollectionCreate } from '../ownCrud';
import { OwnRef } from '../ledger/ledger';
import { runId, ownName } from '../ledger/runState';
import { assertOwnLive } from '../ledger/ownership';
import { ApiAnswer } from '../apiReads';
import type { JsonObject } from '../json';
import { NotificationConnector } from './notificationConnector';


export interface InstanceBody {
    name?: string;
    description?: string;
    connectorUuid?: string;
    kind?: string;
    attributes?: JsonObject[];
    attributeMappings?: JsonObject[];
}

export interface OwnInstance extends OwnRef {
    body: JsonObject;
    connector: NotificationConnector;
}

/** The instance request body of a connector + attributes (pure). */
export function instanceBody(connector: NotificationConnector, name: string, attributes: JsonObject[], extra: Partial<InstanceBody> = {}): JsonObject {
    return { name, description: `REG run ${runId()}`, connectorUuid: connector.uuid, kind: connector.kind, attributes, attributeMappings: [], ...extra };
}

export interface InstanceOptions {
    connector: NotificationConnector;
    attributes: JsonObject[];
    description?: string;
    attributeMappings?: JsonObject[];
}

/** Creates an own instance (ledger before assertion); throws on a refusal: a positive step. */
export async function createOwnInstance(api: GuardedApi, spec: string, suffix: string, o: InstanceOptions): Promise<OwnInstance> {
    const name = ownName(suffix);
    const { name: _name, ...body } = instanceBody(o.connector, name, o.attributes, {
        ...(o.description !== undefined ? { description: o.description } : {}),
        ...(o.attributeMappings ? { attributeMappings: o.attributeMappings } : {}),
    });
    const { answer, ...ref } = await createOwn(api, spec, { type: 'notificationInstances', path: '/api/v1/notificationInstances', name, body, note: `${o.connector.kind} notification instance (nothing delivered)` });
    return { ...ref, body: answer.json, connector: o.connector };
}

/** A negative probe: POST as is; an accepted one is recorded so the teardown removes it. */
export async function probeInstance(api: GuardedApi, spec: string, body: JsonObject): Promise<ApiAnswer> {
    return probeCollectionCreate(api, spec, { type: 'notificationInstances', path: '/api/v1/notificationInstances', body, note: 'instance create probe' });
}

/** Every instance of the tier (`GET /v1/notificationInstances`, an unpaged list; read-only). */
export async function listInstances(api: GuardedApi): Promise<JsonObject[]> {
    const sent = await sendJson(api, 'GET', '/api/v1/notificationInstances');
    if (sent.status !== 200 || !Array.isArray(sent.json)) throw new Error(`GET /v1/notificationInstances answered ${sent.status}`);
    return sent.json as JsonObject[];
}

export async function getInstance(api: GuardedApi, uuid: string): Promise<ApiAnswer> {
    return sendJson(api, 'GET', `/api/v1/notificationInstances/${uuid}`);
}

/** `PUT` of an own instance: description, attributes and mappings only. */
export async function putOwnInstance(api: GuardedApi, ref: OwnRef, body: JsonObject): Promise<ApiAnswer> {
    await assertOwnLive(api, 'notificationInstances', ref, 'putOwnInstance');
    return sendJson(api, 'PUT', `/api/v1/notificationInstances/${ref.uuid}`, body);
}

/** `DELETE` of an own instance through `ownCrud.deleteOwn`; a 204 is recorded, a refusal (422, naming what uses it) is returned. */
export async function deleteOwnInstance(api: GuardedApi, ref: OwnRef, spec: string): Promise<ApiAnswer> {
    return deleteOwn(api, 'notificationInstances', ref, spec);
}

/** An error body mentions `text` (in the array element or the `message`). */
export const mentions = (s: ApiAnswer, text: string | RegExp): boolean =>
    (Array.isArray(s.json) ? s.json.map(String) : s.json?.message ? [String(s.json.message)] : [s.text]).some((t) => (typeof text === 'string' ? t.includes(text) : text.test(t)));
