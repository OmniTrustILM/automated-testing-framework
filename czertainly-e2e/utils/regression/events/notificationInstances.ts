/**
 * notificationInstances — own notification instances: create, probe, read, update and delete; instances are only created and validated here
 * (delivery belongs to the local-stack rows), and every change first passes the live own-object check.
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

export function instanceBody(connector: NotificationConnector, name: string, attributes: JsonObject[], extra: Partial<InstanceBody> = {}): JsonObject {
    return { name, description: `REG run ${runId()}`, connectorUuid: connector.uuid, kind: connector.kind, attributes, attributeMappings: [], ...extra };
}

export interface InstanceOptions {
    connector: NotificationConnector;
    attributes: JsonObject[];
    description?: string;
    attributeMappings?: JsonObject[];
}

export async function createOwnInstance(api: GuardedApi, spec: string, suffix: string, o: InstanceOptions): Promise<OwnInstance> {
    const name = ownName(suffix);
    const { name: _name, ...body } = instanceBody(o.connector, name, o.attributes, {
        ...(o.description !== undefined ? { description: o.description } : {}),
        ...(o.attributeMappings ? { attributeMappings: o.attributeMappings } : {}),
    });
    const { answer, ...ref } = await createOwn(api, spec, { type: 'notificationInstances', path: '/api/v1/notificationInstances', name, body, note: `${o.connector.kind} notification instance (nothing delivered)` });
    return { ...ref, body: answer.json, connector: o.connector };
}

export async function probeInstance(api: GuardedApi, spec: string, body: JsonObject): Promise<ApiAnswer> {
    return probeCollectionCreate(api, spec, { type: 'notificationInstances', path: '/api/v1/notificationInstances', body, note: 'instance create probe' });
}

export async function listInstances(api: GuardedApi): Promise<JsonObject[]> {
    const sent = await sendJson(api, 'GET', '/api/v1/notificationInstances');
    if (sent.status !== 200 || !Array.isArray(sent.json)) throw new Error(`GET /v1/notificationInstances answered ${sent.status}`);
    return sent.json as JsonObject[];
}

export async function getInstance(api: GuardedApi, uuid: string): Promise<ApiAnswer> {
    return sendJson(api, 'GET', `/api/v1/notificationInstances/${uuid}`);
}

export async function putOwnInstance(api: GuardedApi, ref: OwnRef, body: JsonObject): Promise<ApiAnswer> {
    await assertOwnLive(api, 'notificationInstances', ref, 'putOwnInstance');
    return sendJson(api, 'PUT', `/api/v1/notificationInstances/${ref.uuid}`, body);
}

export async function deleteOwnInstance(api: GuardedApi, ref: OwnRef, spec: string): Promise<ApiAnswer> {
    return deleteOwn(api, 'notificationInstances', ref, spec);
}

export const mentions = (s: ApiAnswer, text: string | RegExp): boolean =>
    (Array.isArray(s.json) ? s.json.map(String) : s.json?.message ? [String(s.json.message)] : [s.text]).some((t) => (typeof text === 'string' ? t.includes(text) : text.test(t)));
