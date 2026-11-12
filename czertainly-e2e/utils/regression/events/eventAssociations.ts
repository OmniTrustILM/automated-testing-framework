/**
 * eventAssociations — which own triggers an event runs on an own RA profile, group or discovery. An association REPLACES
 * the (event, resource, object) list, so a helper never appends; the ledger line of type `eventAssociations` (id-named, a
 * synthetic uuid) is written BEFORE the request, because a leftover association blocks the deletion of its trigger.
 * Nothing is associated at platform level except by the `@local` specs (`platformAssociate`, behind `localStack`).
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

/** Which ledger type each scope's object has. */
const SCOPE_LEDGER: Record<AssociationScope, string> = { raProfiles: 'raProfiles', groups: 'groups', discoveries: 'discoveries' };

export interface AssociationScopeRef {
    /** RA profile, group or discovery the association hangs on. */
    resource: AssociationScope;
    object: OwnRef;
}

export const associationKey = (event: EventCode, resource: string, objectUuid: string): string => `${event}|${resource}|${objectUuid}`;

/** The ledger line of an association is `<run id>-assoc-<n>`, its (event, resource) in `note`, the object in `parents.object`. */
function associationLine(event: EventCode, resource: AssociationScope, object: OwnRef): OwnRef | undefined {
    const key = associationKey(event, resource, object.uuid);
    const line = readLedger().find((l) => l.runId === runId() && l.type === 'eventAssociations' && l.event === 'created' && l.note?.startsWith(`${key} `) && checkOwnership(l).own);
    return line ? { uuid: line.uuid, name: line.name, kind: 'own' } : undefined;
}

/** Records the association BEFORE it is sent (a leftover association blocks the deletion of its trigger): idempotent per scope. */
export function recordAssociation(event: EventCode, resource: AssociationScope, object: OwnRef, spec: string): OwnRef {
    const known = associationLine(event, resource, object);
    if (known) return known;
    return recordCreated('eventAssociations', { uuid: crypto.randomUUID(), name: ownName('assoc') }, { spec, note: `${associationKey(event, resource, object.uuid)} object-level association of own triggers on an own ${SCOPE_LEDGER[resource]}`, parents: { object: object.uuid } });
}

export interface AssociateOptions extends AssociationScopeRef {
    event: EventCode;
    /** OWN triggers, in the order they must run (an ignore trigger is ordered first by the platform). */
    triggers: OwnRef[];
}

/**
 * `POST /v1/workflows/events` on an own scope: the list of (event, resource, object) is REPLACED by `triggers`. Returns the
 * answer (a 4xx for a refused association is asserted by the caller). The scope object and every trigger are checked live.
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

/** Removes every trigger of the scope for the event (`triggerUuids: []`, the replace with nothing). */
export const clearAssociation = (api: GuardedApi, spec: string, o: AssociationScopeRef & { event: EventCode }): Promise<ApiAnswer> =>
    associateTriggers(api, spec, { ...o, triggers: [] });

/**
 * A refused association (negative case): same request, nothing recorded unless the platform accepted it (then the scope
 * is recorded so the teardown clears it). Trigger uuids may be probes (`api.probeUuid()`); they are not checked live.
 */
export async function probeAssociation(api: GuardedApi, spec: string, o: AssociationScopeRef & { event: EventCode; triggerUuids: string[] }): Promise<ApiAnswer> {
    await assertOwnLive(api, SCOPE_LEDGER[o.resource], o.object, 'probeAssociation (scope)');
    const sent = await sendJson(api, 'POST', '/api/v1/workflows/events', { event: o.event, resource: o.resource, objectUuid: o.object.uuid, triggerUuids: o.triggerUuids });
    if (isOk(sent)) recordAssociation(o.event, o.resource, o.object, spec);
    return sent;
}

/** The stored association of a scope: event code → trigger uuids in execution order (`GET /v1/workflows/events/{resource}/{uuid}`). */
export async function getAssociations(api: GuardedApi, resource: AssociationScope, objectUuid: string): Promise<Record<string, string[]>> {
    const sent = await sendJson(api, 'GET', `/api/v1/workflows/events/${resource}/${objectUuid}`);
    expect(sent.status, `GET associations of ${resource}`).toBe(200);
    return (sent.json ?? {}) as Record<string, string[]>;
}

/**
 * `@local` only: the platform-level association of an event (no object): REPLACES the platform list. The guard refuses it unless
 * `localStack` on a proven local stack (`describeLocalOnly` + a context from `getGuardedApiContext(request, env, { localStack: true })`: a
 * spec may not `test.use` the guard options). The caller READS the platform list first (`getPlatformAssociations`) and restores it
 * afterwards.
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

/**
 * The platform-level trigger list of an event, read only: `GET /v1/settings/events` (`EventsSettingsDto.eventsMapping`:
 * event code → trigger uuids). A GET never changes the platform setting; a `@local` row records it before it replaces it.
 */
export async function getPlatformAssociations(api: GuardedApi, event: EventCode): Promise<string[]> {
    const sent = await sendJson(api, 'GET', '/api/v1/settings/events');
    expect(sent.status, 'GET /v1/settings/events').toBe(200);
    const mapping = (sent.json?.eventsMapping ?? {}) as Record<string, string[]>;
    return mapping[event] ?? [];
}
