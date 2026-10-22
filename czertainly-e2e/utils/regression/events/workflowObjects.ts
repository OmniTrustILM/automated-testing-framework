/**
 * workflowObjects — the five workflow kinds and the creators of own workflow objects.
 *
 * WHAT: the request items of conditions, rules, executions, actions and triggers, the creators of own objects and own
 *       chains, the negative-probe create (`probeWorkflowObject`) and the reads.
 * WHY: a workflow chain is the setup of every event test, and a probe the platform accepted is an object the run must own
 *      and remove like any other.
 * HOW: every create is run-prefixed and recorded in the ledger right after the call, before any assertion; the run-end
 *      teardown removes the objects in dependency order through events/workflowTeardown.ts.
 */
import { expect } from '@playwright/test';
import { GuardedApi } from '../guard/types';
import { createOwn, deleteOwn, probeCollectionCreate } from '../ownCrud';
import { OwnRef } from '../ledger/ledger';
import { runId, ownName } from '../ledger/runState';
import { assertOwnLive } from '../ledger/ownership';
import { EVENT, EventCode } from './eventVocabulary';
import { sendJson } from './workflowRequests';
import { ApiAnswer } from '../apiReads';
import type { JsonObject } from '../json';

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

/** Set field Groups (REPLACES the set; `[]` removes all). */
export const setGroupsAction = (groupUuids: string[]): ExecutionItem => ({ fieldSource: 'property', fieldIdentifier: CERT_FIELD.group, data: groupUuids });
export const setOwnerAction = (userUuid: string | null): ExecutionItem => ({ fieldSource: 'property', fieldIdentifier: CERT_FIELD.owner, data: userUuid });
export const setRaProfileAction = (raProfileUuid: string): ExecutionItem => ({ fieldSource: 'property', fieldIdentifier: CERT_FIELD.raProfile, data: raProfileUuid });
/**
 * Set field of a custom attribute (core `ActionServiceImpl.createSetFieldExecutionItem`): the identifier is
 * `<attribute name>|<CONTENT_TYPE>` with the content type as the enum NAME (`STRING`, `INTEGER`, …), the data the value as a
 * string (or a list of strings); core stores it as the attribute's content items.
 */
export const setCustomAttributeAction = (name: string, contentType: string, value: unknown): ExecutionItem => ({
    fieldSource: 'custom',
    fieldIdentifier: `${name}|${contentType.toUpperCase()}`,
    data: String(value),
});
export const sendNotificationItem = (notificationProfileUuid: string): ExecutionItem => ({ notificationProfileUuid });

export interface Created extends OwnRef {
    body: JsonObject;
}

async function createKind(api: GuardedApi, kind: WorkflowKind, spec: string, suffix: string, body: JsonObject, note: string): Promise<Created> {
    // Ledger before assertion (createOwn): a created object is this run's, whatever the caller asserts next.
    const { answer, ...ref } = await createOwn(api, spec, { type: kind, path: kindPath(kind), name: ownName(suffix), body, note });
    return { ...ref, body: answer.json };
}

export interface ConditionOptions {
    resource?: string;
    items: ConditionItem[];
    description?: string;
}

export const createOwnCondition = (api: GuardedApi, spec: string, suffix: string, o: ConditionOptions): Promise<Created> =>
    createKind(api, 'conditions', spec, suffix, { description: o.description ?? `REG run ${runId()}`, type: 'checkField', resource: o.resource ?? 'certificates', items: o.items }, 'workflow condition');

export interface RuleOptions {
    resource?: string;
    conditions: Array<{ uuid: string }>;
    description?: string;
}

export const createOwnRule = (api: GuardedApi, spec: string, suffix: string, o: RuleOptions): Promise<Created> =>
    createKind(api, 'rules', spec, suffix, { description: o.description ?? `REG run ${runId()}`, resource: o.resource ?? 'certificates', conditionsUuids: o.conditions.map((c) => c.uuid) }, 'workflow rule');

export interface ExecutionOptions {
    resource?: string;
    type?: 'setField' | 'sendNotification';
    items: ExecutionItem[];
    description?: string;
}

export const createOwnExecution = (api: GuardedApi, spec: string, suffix: string, o: ExecutionOptions): Promise<Created> =>
    createKind(
        api, 'executions', spec, suffix,
        { description: o.description ?? `REG run ${runId()}`, type: o.type ?? 'setField', resource: o.resource ?? 'certificates', items: o.items },
        'workflow execution',
    );

export interface ActionOptions {
    resource?: string;
    executions: Array<{ uuid: string }>;
    description?: string;
}

export const createOwnAction = (api: GuardedApi, spec: string, suffix: string, o: ActionOptions): Promise<Created> =>
    createKind(api, 'actions', spec, suffix, { description: o.description ?? `REG run ${runId()}`, resource: o.resource ?? 'certificates', executionsUuids: o.executions.map((e) => e.uuid) }, 'workflow action');

export interface TriggerOptions {
    resource?: string;
    /** The event the trigger is bound to (type `event`); omit for a trigger without an event (type `manual`). */
    event?: EventCode;
    ignore?: boolean;
    rules?: Array<{ uuid: string }>;
    actions?: Array<{ uuid: string }>;
    description?: string;
}

/** The request body of a trigger (pure): type `event` iff an event is given. */
export function triggerBody(o: TriggerOptions): JsonObject {
    return {
        description: o.description ?? `REG run ${runId()}`,
        type: o.event ? 'event' : 'manual',
        resource: o.resource ?? 'certificates',
        ignoreTrigger: o.ignore ?? false,
        ...(o.event ? { event: o.event } : {}),
        rulesUuids: (o.rules ?? []).map((r) => r.uuid),
        actionsUuids: (o.actions ?? []).map((a) => a.uuid),
    };
}

export const createOwnTrigger = (api: GuardedApi, spec: string, suffix: string, o: TriggerOptions): Promise<Created> =>
    createKind(api, 'triggers', spec, suffix, triggerBody(o), 'workflow trigger');

export interface OwnChain {
    condition?: Created;
    rule?: Created;
    execution?: Created;
    action?: Created;
    trigger: Created;
}

export interface ChainOptions {
    /** The event the trigger is bound to (default `certificate_action_performed`). */
    event?: EventCode;
    /** Condition items of the rule (omit for a trigger without rules: it matches every object of its scope). */
    items?: ConditionItem[];
    /** Execution items of the action (omit for an IGNORE trigger: it has no action). */
    executionItems?: ExecutionItem[];
    ignore?: boolean;
    resource?: string;
}

/**
 * The whole chain of one trigger — condition → rule, execution → action, then the trigger — all own, nothing associated.
 * An ignore trigger has no action; a trigger without `items` has no rule.
 */
export async function createOwnChain(api: GuardedApi, spec: string, suffix: string, o: ChainOptions = {}): Promise<OwnChain> {
    const resource = o.resource ?? 'certificates';
    const chain: Partial<OwnChain> = {};
    if (o.items?.length) {
        chain.condition = await createOwnCondition(api, spec, `${suffix}-c`, { resource, items: o.items });
        chain.rule = await createOwnRule(api, spec, `${suffix}-r`, { resource, conditions: [chain.condition] });
    }
    if (!o.ignore) {
        chain.execution = await createOwnExecution(api, spec, `${suffix}-e`, { resource, items: o.executionItems ?? [] });
        chain.action = await createOwnAction(api, spec, `${suffix}-a`, { resource, executions: [chain.execution] });
    }
    chain.trigger = await createOwnTrigger(api, spec, `${suffix}-t`, {
        resource,
        event: o.event ?? EVENT.actionPerformed,
        ignore: o.ignore ?? false,
        ...(chain.rule ? { rules: [chain.rule] } : {}),
        ...(chain.action ? { actions: [chain.action] } : {}),
    });
    return chain as OwnChain;
}

/** A negative probe: POST a body as is. A 2xx means the platform accepted what the caller expects it to refuse: it is recorded. */
export async function probeWorkflowObject(api: GuardedApi, spec: string, kind: WorkflowKind, body: JsonObject, note: string): Promise<ApiAnswer> {
    return probeCollectionCreate(api, spec, { type: kind, path: kindPath(kind), body, note });
}

/** `PUT` of an own object (a rename, a changed resource): the guard checks the target is this run's. */
async function putOwn(api: GuardedApi, kind: WorkflowKind, ref: OwnRef, body: JsonObject): Promise<ApiAnswer> {
    await assertOwnLive(api, kind, ref, `putOwn ${kind}`);
    return sendJson(api, 'PUT', `${kindPath(kind)}/${ref.uuid}`, body);
}

/**
 * `DELETE` of an own object through the one own-delete (`ownCrud.deleteOwn`): a 200 / 204 writes the `deleted` ledger line,
 * a refusal (422, naming the parent) is returned in the `ApiAnswer` shape the error readers take.
 */
export async function deleteOwnWorkflowObject(api: GuardedApi, kind: WorkflowKind, ref: OwnRef, spec: string): Promise<ApiAnswer> {
    return deleteOwn(api, kind, ref, spec);
}

export async function getKind(api: GuardedApi, kind: WorkflowKind, uuid: string): Promise<ApiAnswer> {
    return sendJson(api, 'GET', `${kindPath(kind)}/${uuid}`);
}

export async function listKind(api: GuardedApi, kind: WorkflowKind, resource?: string): Promise<JsonObject[]> {
    const sent = await sendJson(api, 'GET', `${kindPath(kind)}${resource ? `?resource=${encodeURIComponent(resource)}` : ''}`);
    expect(sent.status, `GET ${kindPath(kind)}`).toBe(200);
    return Array.isArray(sent.json) ? sent.json : [];
}
