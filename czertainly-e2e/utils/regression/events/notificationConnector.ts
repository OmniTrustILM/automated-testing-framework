/**
 * notificationConnector — the notification connector of the tier and its live definitions.
 *
 * WHAT: Finds the connected e-mail or webhook notification connector, reads its instance attribute definitions and its mapping attributes.
 * WHY: Every notification create starts from the connector's live definitions, and a tier without a connector is a named skip, not a
 * failure.
 * HOW: Read-only calls through the guarded client; the connector is chosen by kind and health.
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
    /** Why it cannot be used ("live health 503"), or undefined when it answers its live health. */
    unhealthy?: string;
}

/**
 * The registered, connected notification connector that offers `kind` (a v1 connector with the `notificationProvider`
 * function group), with its LIVE health. Read-only. `undefined` = the tier has none: the spec skips with the named
 * reason (`@needs:email-provider` / `@needs:webhook-provider`).
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
    for (const c of candidates) {
        const connector = (await listConnectors(api)).find((x) => x.uuid === c.uuid) ?? (await findConnector(api, String(c.name)));
        if (!connector) continue;
        const health = await healthByVersion(api, connector);
        return { uuid: String(c.uuid), name: String(c.name), kind, ...(health.healthy ? {} : { unhealthy: health.why }) };
    }
    return undefined;
}

/** The attribute definitions of one kind (`GET /v1/connectors/{uuid}/attributes/notificationProvider/{kind}`), read-only. */
export async function instanceDefinitions(api: GuardedApi, connector: NotificationConnector): Promise<JsonObject[]> {
    const res = await api.get(`/api/v1/connectors/${connector.uuid}/attributes/${NOTIFICATION_FUNCTION_GROUP}/${connector.kind}`);
    if (!res.ok()) throw new Error(`GET attribute definitions of ${connector.name} (${connector.kind}) answered ${res.status()}`);
    return (await res.json()) as JsonObject[];
}

/** The mapping attributes of a kind (`GET /v1/notificationInstances/attributes/mapping/{connector}/{kind}`). */
export async function getMappingAttributes(api: GuardedApi, connector: NotificationConnector): Promise<ApiAnswer> {
    return sendJson(api, 'GET', `/api/v1/notificationInstances/attributes/mapping/${connector.uuid}/${connector.kind}`);
}
