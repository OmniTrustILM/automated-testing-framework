/**
 * notificationConnector — the notification connector of the tier and its
 * live definitions; a tier without one is a named skip, not a failure.
 */

import { GuardedApi } from '../guard/types';
import { findConnector, healthByVersion, listConnectors } from '../platform/connectorApi';
import { sendJson } from './workflowRequests';
import { ApiAnswer } from '../apiReads';
import type { JsonObject } from '../json';
import { rowsOf } from '../json';

export type NotificationKind = 'EMAIL' | 'WEBHOOK';

const NOTIFICATION_FUNCTION_GROUP = 'notificationProvider';

export interface NotificationConnector {
    uuid: string;
    name: string;
    kind: NotificationKind;
    unhealthy?: string;
}

/**
 * The connected notification connector offering `kind`, with its live health: the first healthy one, else the first unhealthy one with the
 * reason; `undefined` = none (the spec skips). Read-only.
 */
export async function findNotificationConnector(api: GuardedApi, kind: NotificationKind): Promise<NotificationConnector | undefined> {
    const rows = await api.get('/api/v1/connectors');
    if (!rows.ok()) throw new Error(`GET /v1/connectors answered ${rows.status()}`);
    const all = (await rows.json()) as JsonObject[];
    const candidates = all.filter(
        (c) =>
            c.status === 'connected' &&
            rowsOf(c.functionGroups).some((g) => g.functionGroupCode === NOTIFICATION_FUNCTION_GROUP && ((g.kinds ?? []) as string[]).includes(kind)),
    );
    let unhealthy: NotificationConnector | undefined;
    for (const c of candidates) {
        const connector = (await listConnectors(api)).find((x) => x.uuid === c.uuid) ?? (await findConnector(api, String(c.name)));
        if (!connector) continue;
        const health = await healthByVersion(api, connector);
        if (health.healthy) return { uuid: String(c.uuid), name: String(c.name), kind };
        unhealthy ??= { uuid: String(c.uuid), name: String(c.name), kind, unhealthy: health.why };
    }
    return unhealthy;
}

export async function instanceDefinitions(api: GuardedApi, connector: NotificationConnector): Promise<JsonObject[]> {
    const res = await api.get(`/api/v1/connectors/${connector.uuid}/attributes/${NOTIFICATION_FUNCTION_GROUP}/${connector.kind}`);
    if (!res.ok()) throw new Error(`GET attribute definitions of ${connector.name} (${connector.kind}) answered ${res.status()}`);
    return (await res.json()) as JsonObject[];
}

export async function getMappingAttributes(api: GuardedApi, connector: NotificationConnector): Promise<ApiAnswer> {
    return sendJson(api, 'GET', `/api/v1/notificationInstances/attributes/mapping/${connector.uuid}/${connector.kind}`);
}
