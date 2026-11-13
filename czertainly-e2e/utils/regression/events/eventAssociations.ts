/**
 * eventAssociations — which own triggers an event runs on an own RA profile, group or discovery. An association REPLACES the list, and its
 * ledger line is written BEFORE the request because a leftover association blocks
 * deleting its trigger. Platform-level associations only in `@local` specs.
 */
import { expect } from '@playwright/test';
import * as crypto from 'crypto';
import { GuardedApi } from '../guard/types';
import { OwnRef, readLedger, recordCreated } from '../ledger/ledger';
import { runId, ownName } from '../ledger/runState';
import { assertOwnLive, checkOwnership } from '../ledger/ownership';
import { AssociationScope, EventCode } from './eventVocabulary';
import { isOk, sendJson } from './workflowRequests';
import { ApiAnswer } from '../apiReads';

const SCOPE_LEDGER: Record<AssociationScope, string> = { raProfiles: 'raProfiles', groups: 'groups', discoveries: 'discoveries' };

export interface AssociationScopeRef {
    resource: AssociationScope;
    object: OwnRef;
}

export const associationKey = (event: EventCode, resource: string, objectUuid: string): string => `${event}|${resource}|${objectUuid}`;

function associationLine(event: EventCode, resource: AssociationScope, object: OwnRef): OwnRef | undefined {
    const key = associationKey(event, resource, object.uuid);
    const line = readLedger().find((l) => l.runId === runId() && l.type === 'eventAssociations' && l.event === 'created' && l.note?.startsWith(`${key} `) && checkOwnership(l).own);
    return line ? { uuid: line.uuid, name: line.name, kind: 'own' } : undefined;
}

export function recordAssociation(event: EventCode, resource: AssociationScope, object: OwnRef, spec: string): OwnRef {
    const known = associationLine(event, resource, object);
    if (known) return known;
    return recordCreated('eventAssociations', { uuid: crypto.randomUUID(), name: ownName('assoc') }, { spec, note: `${associationKey(event, resource, object.uuid)} object-level association of own triggers on an own ${SCOPE_LEDGER[resource]}`, parents: { object: object.uuid } });
}

export interface AssociateOptions extends AssociationScopeRef {
    event: EventCode;
    triggers: OwnRef[];
}

/**
 * `POST /v1/workflows/events` on an own scope: REPLACES the list with `triggers`; returns the answer. The scope object and every trigger
 * are checked live.
 */
export async function associateTriggers(api: GuardedApi, spec: string, o: AssociateOptions): Promise<ApiAnswer> {
    await assertOwnLive(api, SCOPE_LEDGER[o.resource], o.object, 'associateTriggers (scope)');
    for (const t of o.triggers) await assertOwnLive(api, 'triggers', t, 'associateTriggers (trigger)');
    recordAssociation(o.event, o.resource, o.object, spec);
    return sendJson(api, 'POST', '/api/v1/workflows/events', {
        event: o.event,
        resource: o.resource,
        objectUuid: o.object.uuid,
        triggerUuids: o.triggers.map((t) => t.uuid),
    });
}

export const clearAssociation = (api: GuardedApi, spec: string, o: AssociationScopeRef & { event: EventCode }): Promise<ApiAnswer> =>
    associateTriggers(api, spec, { ...o, triggers: [] });

/**
 * A refused association (negative case): nothing is recorded unless the
 * platform accepted it. Trigger uuids may be probes (not checked live).
 */
export async function probeAssociation(api: GuardedApi, spec: string, o: AssociationScopeRef & { event: EventCode; triggerUuids: string[] }): Promise<ApiAnswer> {
    await assertOwnLive(api, SCOPE_LEDGER[o.resource], o.object, 'probeAssociation (scope)');
    const sent = await sendJson(api, 'POST', '/api/v1/workflows/events', { event: o.event, resource: o.resource, objectUuid: o.object.uuid, triggerUuids: o.triggerUuids });
    if (isOk(sent)) recordAssociation(o.event, o.resource, o.object, spec);
    return sent;
}

export async function getAssociations(api: GuardedApi, resource: AssociationScope, objectUuid: string): Promise<Record<string, string[]>> {
    const sent = await sendJson(api, 'GET', `/api/v1/workflows/events/${resource}/${objectUuid}`);
    expect(sent.status, `GET associations of ${resource}`).toBe(200);
    return (sent.json ?? {}) as Record<string, string[]>;
}

/**
 * `@local` only: REPLACES the platform-level association of an event. The guard refuses it unless the context has `localStack`; the caller
 * reads the platform list first and restores it.
 */
export async function platformAssociate(api: GuardedApi, spec: string, event: EventCode, triggers: OwnRef[]): Promise<ApiAnswer> {
    for (const t of triggers) await assertOwnLive(api, 'triggers', t, 'platformAssociate (trigger)');
    recordPlatformAssociation(event, spec);
    return sendJson(api, 'POST', '/api/v1/workflows/events', { event, resource: null, objectUuid: null, triggerUuids: triggers.map((t) => t.uuid) });
}

function recordPlatformAssociation(event: EventCode, spec: string): void {
    const key = associationKey(event, 'platform', '-');
    const known = readLedger().find((l) => l.runId === runId() && l.type === 'eventAssociations' && l.event === 'created' && l.note?.startsWith(`${key} `));
    if (known) return;
    recordCreated('eventAssociations', { uuid: crypto.randomUUID(), name: ownName('assoc-platform') }, { spec, note: `${key} platform-level association (@local only)` });
}

/** The platform-level trigger list of an event (read only); a `@local` row records it before replacing it. */
export async function getPlatformAssociations(api: GuardedApi, event: EventCode): Promise<string[]> {
    const sent = await sendJson(api, 'GET', '/api/v1/settings/events');
    expect(sent.status, 'GET /v1/settings/events').toBe(200);
    const mapping = (sent.json?.eventsMapping ?? {}) as Record<string, string[]>;
    return mapping[event] ?? [];
}
