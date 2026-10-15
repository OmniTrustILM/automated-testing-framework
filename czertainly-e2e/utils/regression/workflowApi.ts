/**
 * workflowApi — the workflow objects of the REG-WFL / API-WFL / REG-DISC rows (events-discovery area, B2 / B3): conditions,
 * rules, executions, actions and triggers, their event associations on the run's OWN objects, and the Event History reads.
 *
 * Rules this module keeps (decision Q1, D1; the guard in guardedApi.ts judges every request too):
 * - every object is created with a run-prefixed name and recorded in the ledger right after the create call, before any
 *   assertion; the run-end teardown (utils/workflowUtils.ts `teardownHandlers`) removes them in dependency order;
 * - NOTHING is associated at platform level: `associateTriggers` takes an own RA profile, group or discovery as the object
 *   and a list of OWN triggers; `POST /v1/workflows/events` without an own `objectUuid` is a platform-level association
 *   (PLATFORM_DENY) and only the `@local` specs may send it (`platformAssociate`, behind `localStack`);
 * - an association is a REPLACE of the (event, resource, object) list (T14 W4): a helper never appends; the ledger line
 *   of type `eventAssociations` (id-named, a synthetic uuid) records what the teardown must clear first;
 * - negative probes never assume "nothing was created": a probe that the platform accepted is recorded (`recordIfCreated`)
 *   before the caller asserts that it should have been refused.
 *
 * Business rules the helpers rest on (assets/rules/events-discovery-signing.md, T14): W1 (events and their overriding
 * objects), W4 (replace), W5 (order, ignore first), W7 (delete refused while referenced), W8 (validation texts), W9
 * (resource coherence), W18 (Set field Groups replaces the set), W29–W31 (history).
 */
import { APIResponse, expect } from '@playwright/test';
import * as crypto from 'crypto';
import { Logger } from '../Logger';
import { GuardedApi, requireGuarded } from './guardedApi';
import { OwnRef, readLedger, recordCreated, recordDeleted, regName, RUN_ID } from './regressionRun';
import { assertOwnLive, ownership } from './ownObjects';

const logger = new Logger('WorkflowApi');

type Json = Record<string, any>;

// ------------------------------------------------------------------ vocabulary (interfaces: ResourceEvent, Resource)

/** Event codes (`ResourceEvent.Codes`). */
export const EVENT = {
    statusChanged: 'certificate_status_changed',
    actionPerformed: 'certificate_action_performed',
    discovered: 'certificate_discovered',
    expiring: 'certificate_expiring',
    notCompliant: 'certificate_not_compliant',
    uploaded: 'certificate_uploaded',
    registered: 'certificate_registered',
    discoveryFinished: 'discovery_finished',
    approvalRequested: 'approval_requested',
    approvalClosed: 'approval_closed',
    commentCreated: 'comment_created',
    commentResolved: 'comment_resolved',
    scheduledJobFinished: 'scheduled_job_finished',
} as const;
export type EventCode = (typeof EVENT)[keyof typeof EVENT];

/** Event labels as the platform prints them in its messages (`ResourceEvent` label). */
export const EVENT_LABEL: Record<EventCode, string> = {
    certificate_status_changed: 'Certificate validation status changed',
    certificate_action_performed: 'Certificate action performed',
    certificate_discovered: 'Certificate discovered',
    certificate_expiring: 'Certificate expiring',
    certificate_not_compliant: 'Certificate not compliant',
    certificate_uploaded: 'Certificate uploaded',
    certificate_registered: 'Certificate registered',
    discovery_finished: 'Discovery Finished',
    approval_requested: 'Approval requested',
    approval_closed: 'Approval closed',
    comment_created: 'Comment created',
    comment_resolved: 'Comment resolved',
    scheduled_job_finished: 'Scheduled job finished',
};

/** The resource a firing belongs to: the event's own resource (`ResourceEvent.resource`). */
export const EVENT_RESOURCE: Record<EventCode, ResourceCode> = {
    certificate_status_changed: 'certificates',
    certificate_action_performed: 'certificates',
    certificate_discovered: 'certificates',
    certificate_expiring: 'certificates',
    certificate_not_compliant: 'certificates',
    certificate_uploaded: 'certificates',
    certificate_registered: 'certificates',
    discovery_finished: 'discoveries',
    approval_requested: 'approvals',
    approval_closed: 'approvals',
    comment_created: 'comments',
    comment_resolved: 'comments',
    scheduled_job_finished: 'jobs',
};

/** Resource codes (`Resource.Codes`) and their labels in platform messages. */
export const RESOURCE_LABEL = {
    certificates: 'Certificate',
    raProfiles: 'RA Profile',
    groups: 'Group',
    discoveries: 'Discovery',
    approvals: 'Approval',
    comments: 'Comment',
    jobs: 'Scheduled job',
    any: 'Any',
    none: 'None',
    ANY: 'Any',
    NONE: 'None',
} as const;
export type ResourceCode = 'certificates' | 'raProfiles' | 'groups' | 'discoveries' | 'approvals' | 'comments' | 'jobs';

/** The objects that can carry an object-level association (`ResourceEvent.overridingResources`). */
export type AssociationScope = 'raProfiles' | 'groups' | 'discoveries';

/** Which ledger type each scope's object has. */
const SCOPE_LEDGER: Record<AssociationScope, string> = { raProfiles: 'raProfiles', groups: 'groups', discoveries: 'discoveries' };

// ------------------------------------------------------------------ names

let counter = 0;

/** A run-prefixed, repeat-safe name: `<run id>-<suffix>-<ms base36><counter>` ([a-z0-9-] only). */
export function wfName(suffix: string): string {
    counter += 1;
    return regName(`${suffix}-${Date.now().toString(36)}${counter.toString(36)}`);
}

// ------------------------------------------------------------------ sending (status + text, never throwing on 4xx)

export type Method = 'GET' | 'POST' | 'PUT' | 'PATCH' | 'DELETE';

export interface Sent {
    status: number;
    text: string;
    /** The parsed body, or undefined when it is empty or not JSON. */
    json: any;
    headers: Record<string, string>;
}

async function sentOf(res: APIResponse): Promise<Sent> {
    const text = await res.text();
    let json: any;
    try {
        json = text ? JSON.parse(text) : undefined;
    } catch {
        json = undefined;
    }
    return { status: res.status(), text, json, headers: res.headers() };
}

/**
 * One request through the guarded context; the answer is returned whatever its status (a negative case asserts it).
 * Only the guard's own refusals throw (`OwnObjectViolation`).
 */
export async function sendJson(api: GuardedApi, method: Method, url: string, data?: unknown): Promise<Sent> {
    const opts = data === undefined ? {} : { data };
    if (method !== 'GET') requireGuarded(api, `sendJson ${method} ${url}`); // a raw context never mutates (deny by default)
    switch (method) {
        case 'GET':
            return sentOf(await api.get(url));
        case 'POST':
            return sentOf(await api.post(url, opts));
        case 'PUT':
            return sentOf(await api.put(url, opts));
        case 'PATCH':
            return sentOf(await api.patch(url, opts));
        case 'DELETE':
            return sentOf(await api.delete(url, opts));
    }
}

/** The status is 2xx (the create contract says 201, the controller answers the DTO with the default 200: both are accepted). */
export const isOk = (s: Sent): boolean => s.status >= 200 && s.status < 300;

/** The messages of an error body: a 422 is a JSON array of strings, 400 / 404 / 409 / 500 are `{message}` (Phase 1 §9.3). */
export function errorTexts(s: Sent): string[] {
    if (Array.isArray(s.json)) return s.json.map(String);
    if (s.json && typeof s.json === 'object' && typeof s.json.message === 'string') return [s.json.message];
    return s.text ? [s.text] : [];
}

/** The shape of an error body: 'array' (422), 'message' (`{message}`), or 'other'. */
export function errorShapeOf(s: Sent): 'array' | 'message' | 'other' {
    if (Array.isArray(s.json) && s.json.every((x) => typeof x === 'string')) return 'array';
    if (s.json && typeof s.json === 'object' && !Array.isArray(s.json) && typeof s.json.message === 'string') return 'message';
    return 'other';
}

// ------------------------------------------------------------------ the five kinds

export type WorkflowKind = 'conditions' | 'rules' | 'executions' | 'actions' | 'triggers';

/** Ledger type == API path segment for all five kinds. */
export const WORKFLOW_KINDS: readonly WorkflowKind[] = ['conditions', 'rules', 'executions', 'actions', 'triggers'];

export const kindPath = (kind: WorkflowKind): string => `/api/v1/workflows/${kind}`;
export const kindLabel = (kind: WorkflowKind): string => ({ conditions: 'Condition', rules: 'Rule', executions: 'Execution', actions: 'Action', triggers: 'Trigger' })[kind];

export interface ConditionItem {
    fieldSource: 'property' | 'custom' | 'meta' | 'data';
    fieldIdentifier: string;
    operator: string;
    value?: unknown;
}

export const conditionItem = (fieldSource: ConditionItem['fieldSource'], fieldIdentifier: string, operator: string, value?: unknown): ConditionItem =>
    value === undefined ? { fieldSource, fieldIdentifier, operator } : { fieldSource, fieldIdentifier, operator, value };

/** Certificate property identifiers of `FilterField` the workflow rows use. */
export const CERT_FIELD = {
    commonName: 'COMMON_NAME',
    raProfile: 'RA_PROFILE_NAME',
    group: 'GROUP_NAME',
    owner: 'OWNER',
    notAfter: 'NOT_AFTER',
    keySize: 'KEY_SIZE',
} as const;

export interface ExecutionItem {
    fieldSource?: 'property' | 'custom';
    fieldIdentifier?: string;
    data?: unknown;
    notificationProfileUuid?: string;
    sourceFieldSource?: 'meta' | 'data' | 'custom';
    sourceFieldIdentifier?: string;
}

/** Set field Groups (REPLACES the set; `[]` removes all: T14 W18). */
export const setGroups = (groupUuids: string[]): ExecutionItem => ({ fieldSource: 'property', fieldIdentifier: CERT_FIELD.group, data: groupUuids });
export const setOwner = (userUuid: string | null): ExecutionItem => ({ fieldSource: 'property', fieldIdentifier: CERT_FIELD.owner, data: userUuid });
export const setRaProfile = (raProfileUuid: string): ExecutionItem => ({ fieldSource: 'property', fieldIdentifier: CERT_FIELD.raProfile, data: raProfileUuid });
/**
 * Set field of a custom attribute (core `ActionServiceImpl.createSetFieldExecutionItem`): the identifier is
 * `<attribute name>|<CONTENT_TYPE>` with the content type as the enum NAME (`STRING`, `INTEGER`, …), the data the value as a
 * string (or a list of strings); core stores it as the attribute's content items.
 */
export const setCustomAttribute = (name: string, contentType: string, value: unknown): ExecutionItem => ({
    fieldSource: 'custom',
    fieldIdentifier: `${name}|${contentType.toUpperCase()}`,
    data: String(value),
});
export const sendNotificationItem = (notificationProfileUuid: string): ExecutionItem => ({ notificationProfileUuid });

export interface Created extends OwnRef {
    body: Json;
}

async function createKind(api: GuardedApi, kind: WorkflowKind, name: string, body: Json, spec: string, note: string): Promise<Created> {
    const sent = await sendJson(api, 'POST', kindPath(kind), { name, ...body });
    // Ledger before assertion: a created object is this run's, whatever the caller asserts next.
    if (isOk(sent) && typeof sent.json?.uuid === 'string') {
        const ref = recordCreated(kind, { uuid: sent.json.uuid, name }, spec, note);
        return { ...ref, body: sent.json };
    }
    throw new Error(`POST ${kindPath(kind)} → ${sent.status} ${sent.text.slice(0, 400)}`);
}

export interface ConditionOptions {
    suffix: string;
    resource?: string;
    items: ConditionItem[];
    description?: string;
}

export const createOwnCondition = (api: GuardedApi, spec: string, o: ConditionOptions): Promise<Created> =>
    createKind(api, 'conditions', wfName(o.suffix), { description: o.description ?? `REG run ${RUN_ID}`, type: 'checkField', resource: o.resource ?? 'certificates', items: o.items }, spec, 'workflow condition');

export interface RuleOptions {
    suffix: string;
    resource?: string;
    conditions: Array<{ uuid: string }>;
    description?: string;
}

export const createOwnRule = (api: GuardedApi, spec: string, o: RuleOptions): Promise<Created> =>
    createKind(api, 'rules', wfName(o.suffix), { description: o.description ?? `REG run ${RUN_ID}`, resource: o.resource ?? 'certificates', conditionsUuids: o.conditions.map((c) => c.uuid) }, spec, 'workflow rule');

export interface ExecutionOptions {
    suffix: string;
    resource?: string;
    type?: 'setField' | 'sendNotification';
    items: ExecutionItem[];
    description?: string;
}

export const createOwnExecution = (api: GuardedApi, spec: string, o: ExecutionOptions): Promise<Created> =>
    createKind(
        api, 'executions', wfName(o.suffix),
        { description: o.description ?? `REG run ${RUN_ID}`, type: o.type ?? 'setField', resource: o.resource ?? 'certificates', items: o.items },
        spec, 'workflow execution',
    );

export interface ActionOptions {
    suffix: string;
    resource?: string;
    executions: Array<{ uuid: string }>;
    description?: string;
}

export const createOwnAction = (api: GuardedApi, spec: string, o: ActionOptions): Promise<Created> =>
    createKind(api, 'actions', wfName(o.suffix), { description: o.description ?? `REG run ${RUN_ID}`, resource: o.resource ?? 'certificates', executionsUuids: o.executions.map((e) => e.uuid) }, spec, 'workflow action');

export interface TriggerOptions {
    suffix: string;
    resource?: string;
    /** The event the trigger is bound to (type `event`); omit for a trigger without an event (type `manual`). */
    event?: EventCode;
    ignore?: boolean;
    rules?: Array<{ uuid: string }>;
    actions?: Array<{ uuid: string }>;
    description?: string;
}

/** The request body of a trigger (pure): type `event` iff an event is given. */
export function triggerBody(o: Omit<TriggerOptions, 'suffix'>): Json {
    return {
        description: o.description ?? `REG run ${RUN_ID}`,
        type: o.event ? 'event' : 'manual',
        resource: o.resource ?? 'certificates',
        ignoreTrigger: o.ignore ?? false,
        ...(o.event ? { event: o.event } : {}),
        rulesUuids: (o.rules ?? []).map((r) => r.uuid),
        actionsUuids: (o.actions ?? []).map((a) => a.uuid),
    };
}

export const createOwnTrigger = (api: GuardedApi, spec: string, o: TriggerOptions): Promise<Created> =>
    createKind(api, 'triggers', wfName(o.suffix), triggerBody(o), spec, 'workflow trigger');

export interface OwnChain {
    condition?: Created;
    rule?: Created;
    execution?: Created;
    action?: Created;
    trigger: Created;
}

export interface ChainOptions {
    suffix: string;
    /** The event the trigger is bound to (default `certificate_action_performed`). */
    event?: EventCode;
    /** Condition items of the rule (omit for a trigger without rules: it matches every object of its scope, W11). */
    items?: ConditionItem[];
    /** Execution items of the action (omit for an IGNORE trigger: it has no action). */
    executionItems?: ExecutionItem[];
    ignore?: boolean;
    resource?: string;
}

/**
 * The whole chain of one trigger — condition → rule, execution → action, then the trigger — all own, nothing associated.
 * An ignore trigger has no action (T14 W8); a trigger without `items` has no rule.
 */
export async function createOwnChain(api: GuardedApi, spec: string, o: ChainOptions): Promise<OwnChain> {
    const resource = o.resource ?? 'certificates';
    const chain: Partial<OwnChain> = {};
    if (o.items?.length) {
        chain.condition = await createOwnCondition(api, spec, { suffix: `${o.suffix}-c`, resource, items: o.items });
        chain.rule = await createOwnRule(api, spec, { suffix: `${o.suffix}-r`, resource, conditions: [chain.condition] });
    }
    if (!o.ignore) {
        chain.execution = await createOwnExecution(api, spec, { suffix: `${o.suffix}-e`, resource, items: o.executionItems ?? [] });
        chain.action = await createOwnAction(api, spec, { suffix: `${o.suffix}-a`, resource, executions: [chain.execution] });
    }
    chain.trigger = await createOwnTrigger(api, spec, {
        suffix: `${o.suffix}-t`,
        resource,
        event: o.event ?? EVENT.actionPerformed,
        ignore: o.ignore ?? false,
        ...(chain.rule ? { rules: [chain.rule] } : {}),
        ...(chain.action ? { actions: [chain.action] } : {}),
    });
    return chain as OwnChain;
}

/** A negative probe: POST a body as is. A 2xx means the platform accepted what the caller expects it to refuse: it is recorded. */
export async function probeCreate(api: GuardedApi, kind: WorkflowKind, body: Json, spec: string, note: string): Promise<Sent> {
    const sent = await sendJson(api, 'POST', kindPath(kind), body);
    recordIfCreated(kind, sent, typeof body.name === 'string' ? body.name : '', spec, note);
    return sent;
}

/** Ledger before assertion for a create the caller expected to fail: records the uuid of an accepted one. */
export function recordIfCreated(type: string, sent: Sent, name: string, spec: string, note: string): OwnRef | undefined {
    if (isOk(sent) && typeof sent.json?.uuid === 'string' && name.startsWith(`${RUN_ID}-`)) {
        return recordCreated(type, { uuid: sent.json.uuid, name }, spec, `${note} (accepted although a refusal was expected)`);
    }
    return undefined;
}

/** `PUT` of an own object (a rename, a changed resource): the guard checks the target is this run's. */
export async function putOwn(api: GuardedApi, kind: WorkflowKind, ref: OwnRef, body: Json): Promise<Sent> {
    await assertOwnLive(api, kind, ref, `putOwn ${kind}`);
    return sendJson(api, 'PUT', `${kindPath(kind)}/${ref.uuid}`, body);
}

/** `DELETE` of an own object. A 204 is recorded (`deleted` ledger line); a refusal (422, naming the parent) is returned. */
export async function deleteOwn(api: GuardedApi, kind: WorkflowKind, ref: OwnRef, spec: string): Promise<Sent> {
    await assertOwnLive(api, kind, ref, `deleteOwn ${kind}`);
    const sent = await sendJson(api, 'DELETE', `${kindPath(kind)}/${ref.uuid}`);
    if (sent.status === 204 || sent.status === 200) recordDeleted(kind, ref, spec, `deleted as the behaviour under test`);
    return sent;
}

export async function getKind(api: GuardedApi, kind: WorkflowKind, uuid: string): Promise<Sent> {
    return sendJson(api, 'GET', `${kindPath(kind)}/${uuid}`);
}

export async function listKind(api: GuardedApi, kind: WorkflowKind, resource?: string): Promise<Json[]> {
    const sent = await sendJson(api, 'GET', `${kindPath(kind)}${resource ? `?resource=${encodeURIComponent(resource)}` : ''}`);
    expect(sent.status, `GET ${kindPath(kind)}`).toBe(200);
    return Array.isArray(sent.json) ? sent.json : [];
}

// ------------------------------------------------------------------ event association (object level only)

export interface AssociationScopeRef {
    /** RA profile, group or discovery the association hangs on. */
    resource: AssociationScope;
    object: OwnRef;
}

export const associationKey = (event: EventCode, resource: string, objectUuid: string): string => `${event}|${resource}|${objectUuid}`;

/** The ledger line of an association is `<run id>-assoc-<n>`, its (event, resource) in `note`, the object in `parents.object`. */
function associationLine(event: EventCode, resource: AssociationScope, object: OwnRef): OwnRef | undefined {
    const key = associationKey(event, resource, object.uuid);
    const line = readLedger().find((l) => l.runId === RUN_ID && l.type === 'eventAssociations' && l.event === 'created' && l.note?.startsWith(`${key} `) && ownership(l).own);
    return line ? { uuid: line.uuid, name: line.name, kind: 'own' } : undefined;
}

/** Records the association BEFORE it is sent (a leftover association blocks the deletion of its trigger): idempotent per scope. */
export function recordAssociation(event: EventCode, resource: AssociationScope, object: OwnRef, spec: string): OwnRef {
    const known = associationLine(event, resource, object);
    if (known) return known;
    return recordCreated(
        'eventAssociations',
        { uuid: crypto.randomUUID(), name: wfName('assoc') },
        spec,
        `${associationKey(event, resource, object.uuid)} object-level association of own triggers on an own ${SCOPE_LEDGER[resource]}`,
        { object: object.uuid },
    );
}

export interface AssociateOptions extends AssociationScopeRef {
    event: EventCode;
    /** OWN triggers, in the order they must run (an ignore trigger is ordered first by the platform: W5). */
    triggers: OwnRef[];
}

/**
 * `POST /v1/workflows/events` on an own scope: the list of (event, resource, object) is REPLACED by `triggers`. Returns the
 * answer (a 4xx for a refused association is asserted by the caller). The scope object and every trigger are checked live.
 */
export async function associateTriggers(api: GuardedApi, spec: string, o: AssociateOptions): Promise<Sent> {
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
export const clearAssociation = (api: GuardedApi, spec: string, o: AssociationScopeRef & { event: EventCode }): Promise<Sent> =>
    associateTriggers(api, spec, { ...o, triggers: [] });

/**
 * A refused association (negative case): same request, nothing recorded unless the platform accepted it (then the scope
 * is recorded so the teardown clears it). Trigger uuids may be probes (`api.probeUuid()`); they are not checked live.
 */
export async function probeAssociation(api: GuardedApi, spec: string, o: AssociationScopeRef & { event: EventCode; triggerUuids: string[] }): Promise<Sent> {
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
 * `@local` only: the platform-level association of an event (no object): REPLACES the platform list. The guard refuses it
 * unless `localStack` on a proven local stack (`describeLocal` + a context from `getGuardedApiContext(request, env, { localStack: true })`: a spec may not `test.use` the guard options).
 * The caller READS the platform list first (`getPlatformAssociations`) and restores it afterwards.
 */
export async function platformAssociate(api: GuardedApi, spec: string, event: EventCode, triggers: OwnRef[]): Promise<Sent> {
    for (const t of triggers) await assertOwnLive(api, 'triggers', t, 'platformAssociate (trigger)');
    recordPlatformAssociation(event, spec);
    return sendJson(api, 'POST', '/api/v1/workflows/events', { event, resource: null, objectUuid: null, triggerUuids: triggers.map((t) => t.uuid) });
}

function recordPlatformAssociation(event: EventCode, spec: string): void {
    const key = associationKey(event, 'platform', '-');
    const known = readLedger().find((l) => l.runId === RUN_ID && l.type === 'eventAssociations' && l.event === 'created' && l.note?.startsWith(`${key} `));
    if (known) return;
    recordCreated('eventAssociations', { uuid: crypto.randomUUID(), name: wfName('assoc-platform') }, spec, `${key} platform-level association (@local only)`);
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

// ------------------------------------------------------------------ Event History (T14 W29–W31)

export interface FiringsOptions {
    event: EventCode;
    /** The overriding object whose firings are listed; omit for the platform scope of the event. */
    scope?: { resource: AssociationScope; objectUuid: string };
    page?: number;
    pageSize?: number;
    objectsPage?: number;
    objectsPageSize?: number;
}

export interface Firing {
    startedAt: string;
    finishedAt?: string | null;
    status: 'inProgress' | 'finished' | 'failed';
    resource: string;
    objectsEvaluated: number;
    objectsMatched: number;
    objectsIgnored: number;
    objectHistories: { items: Json[]; itemsPerPage: number; pageNumber: number; totalPages: number; totalItems: number };
}

export interface FiringPage {
    items: Firing[];
    itemsPerPage: number;
    pageNumber: number;
    totalPages: number;
    totalItems: number;
}

/**
 * `POST /v1/workflows/events/{event}[/{resource}/{uuid}]/history`: the firings of an event in one scope, newest first, with
 * `pagination` (firings) and `objectsPagination` (objects inside a firing). A read: the guard's POST allow-list.
 */
export async function getFirings(api: GuardedApi, o: FiringsOptions): Promise<Sent & { page?: FiringPage }> {
    const path = o.scope ? `/api/v1/workflows/events/${o.event}/${o.scope.resource}/${o.scope.objectUuid}/history` : `/api/v1/workflows/events/${o.event}/history`;
    const sent = await sendJson(api, 'POST', path, {
        pagination: { itemsPerPage: o.pageSize ?? 10, pageNumber: o.page ?? 1 },
        objectsPagination: { itemsPerPage: o.objectsPageSize ?? 10, pageNumber: o.objectsPage ?? 1 },
    });
    return { ...sent, ...(sent.status === 200 ? { page: sent.json as FiringPage } : {}) };
}

/** One row of an object's own history: a trigger evaluated on it (`ObjectEventHistoryDto`). */
export interface ObjectHistoryRow {
    event: string;
    trigger: { uuid: string; name: string };
    origin?: Json;
    conditionsMatched: boolean;
    actionsPerformed: boolean;
    triggeredAt: string;
    message?: string | null;
    notificationsSent?: boolean | null;
    records: Array<{ message?: string; condition?: Json; execution?: Json }>;
}

/** `GET /v1/workflows/events/{resource}/{uuid}/history`: the triggers evaluated on one object, newest first. */
export async function getObjectHistory(api: GuardedApi, resource: string, uuid: string, opts: { page?: number; pageSize?: number } = {}): Promise<Sent & { rows: ObjectHistoryRow[]; totalItems: number }> {
    const q = `itemsPerPage=${opts.pageSize ?? 100}&pageNumber=${opts.page ?? 1}`;
    const sent = await sendJson(api, 'GET', `/api/v1/workflows/events/${resource}/${uuid}/history?${q}`);
    const rows = (sent.json?.items ?? []) as ObjectHistoryRow[];
    return { ...sent, rows, totalItems: Number(sent.json?.totalItems ?? rows.length) };
}

export interface WaitOptions {
    timeoutMs?: number;
    intervalMs?: number;
    /** What the wait is for, for the failure message. */
    what?: string;
}

/**
 * Polls `read` until `done(value)`; firings are asynchronous (JMS: T14 §3), so a spec waits on API state, never on time.
 * A 5xx or a throw of `read` is retried twice in a row (a poll right after a write), then raised with the last answer.
 */
export async function pollUntil<T>(read: () => Promise<T>, done: (value: T) => boolean, opts: WaitOptions = {}): Promise<T> {
    const timeout = opts.timeoutMs ?? 90_000;
    const interval = opts.intervalMs ?? 2_000;
    const startedAt = Date.now();
    let last: T | undefined;
    let failures = 0;
    for (;;) {
        try {
            last = await read();
            failures = 0;
            if (done(last)) return last;
        } catch (e) {
            failures += 1;
            if (failures >= 3) throw e;
        }
        if (Date.now() - startedAt >= timeout) {
            throw new Error(`${opts.what ?? 'poll'}: not satisfied within ${timeout} ms; last ${JSON.stringify(last)?.slice(0, 600)}`);
        }
        await new Promise((r) => setTimeout(r, interval));
    }
}

/** Waits until the scope's event history holds `count` firings that are no longer in progress (fails on a `failed` firing). */
export async function waitForFinishedFirings(api: GuardedApi, o: FiringsOptions, count: number, opts: WaitOptions = {}): Promise<FiringPage> {
    return pollUntil(
        async () => {
            const r = await getFirings(api, { ...o, pageSize: Math.max(o.pageSize ?? 10, 10) });
            if (!r.page) throw new Error(`event history of ${o.event} answered ${r.status}`);
            return r.page;
        },
        (page) => {
            const failed = page.items.find((f) => f.status === 'failed');
            if (failed) throw new Error(`a firing of ${o.event} failed: ${JSON.stringify(failed).slice(0, 400)}`);
            return page.totalItems >= count && page.items.every((f) => f.status !== 'inProgress');
        },
        { what: `${count} finished firing(s) of ${o.event}`, ...opts },
    );
}

/** Waits until an object's own history holds rows for every trigger name given (evaluated), returning all rows. */
export async function waitForTriggerRows(api: GuardedApi, resource: string, uuid: string, triggerNames: string[], opts: WaitOptions = {}): Promise<ObjectHistoryRow[]> {
    const r = await pollUntil(
        async () => (await getObjectHistory(api, resource, uuid)).rows,
        (rows) => triggerNames.every((n) => rows.some((x) => x.trigger?.name === n)),
        { what: `trigger rows ${triggerNames.join(', ')} on ${resource}`, ...opts },
    );
    return r;
}

/** Rows ordered by evaluation time, oldest first (the object history answers newest first). */
export const inEvaluationOrder = (rows: ObjectHistoryRow[]): ObjectHistoryRow[] =>
    [...rows].sort((a, b) => Date.parse(a.triggeredAt) - Date.parse(b.triggeredAt));

/**
 * Whether a PLATFORM-level trigger already listens on any of `events` (`GET /v1/settings/events`, read only). Such a trigger acts
 * on this spec's certificates too (an ignore trigger could even refuse them), so the rows that assert "nothing happened" or an
 * exact firing / history outcome skip with a named reason, as the `@local` rows do for an occupied platform list. A read that fails
 * is a skip too: the absence of a platform trigger cannot be shown.
 */
export async function getPlatformTriggerGate(api: GuardedApi, events: EventCode[]): Promise<string | undefined> {
    const sent = await sendJson(api, 'GET', '/api/v1/settings/events');
    if (sent.status !== 200) return `guard 3: the platform event settings could not be read (answer ${sent.status}); a platform-level trigger on the events of this row cannot be ruled out`;
    const mapping = (sent.json?.eventsMapping ?? {}) as Record<string, string[]>;
    const occupied = events.filter((e) => (mapping[e] ?? []).length > 0);
    return occupied.length ? `guard 3: platform-level trigger(s) already listen on ${occupied.map((e) => EVENT_LABEL[e]).join(', ')}; the row stays out of events it does not own` : undefined;
}

/**
 * An ABSENCE over a time window ("no second run", "nothing delivered"): only the clock can show that something never happens, so the
 * window is kept, but API state is read THROUGH it every `everyMs` and `check` asserts the absence on each read. A violation fails at
 * the read that sees it, not after one long sleep, and the check runs once more at the end of the window. Returns the number of reads.
 */
export async function assertHeldFor(window: { forMs: number; everyMs: number }, check: () => Promise<void>): Promise<number> {
    const end = Date.now() + window.forMs;
    let reads = 0;
    for (;;) {
        await check();
        reads += 1;
        const left = end - Date.now();
        if (left <= 0) return reads;
        await new Promise((r) => setTimeout(r, Math.min(window.everyMs, left)));
    }
}

export { logger as workflowLogger };
