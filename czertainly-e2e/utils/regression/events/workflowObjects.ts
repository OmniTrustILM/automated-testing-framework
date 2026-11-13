/**
 * workflowObjects — the five workflow kinds and the creators of own workflow objects; every create is run-prefixed and recorded right after
 * the call, and an accepted probe is removed by the run-end teardown in dependency order.
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

export const setGroupsAction = (groupUuids: string[]): ExecutionItem => ({ fieldSource: 'property', fieldIdentifier: CERT_FIELD.group, data: groupUuids });
export const setOwnerAction = (userUuid: string | null): ExecutionItem => ({ fieldSource: 'property', fieldIdentifier: CERT_FIELD.owner, data: userUuid });
export const setRaProfileAction = (raProfileUuid: string): ExecutionItem => ({ fieldSource: 'property', fieldIdentifier: CERT_FIELD.raProfile, data: raProfileUuid });
/**
 * Set field of a custom attribute: the identifier is `<attribute name>|<CONTENT_TYPE>`
 * (enum NAME), the data the value as a string or list of strings.
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
    event?: EventCode;
    ignore?: boolean;
    rules?: Array<{ uuid: string }>;
    actions?: Array<{ uuid: string }>;
    description?: string;
}

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
    event?: EventCode;
    items?: ConditionItem[];
    executionItems?: ExecutionItem[];
    ignore?: boolean;
    resource?: string;
}

/**
 * The whole chain of one trigger (condition → rule, execution → action, trigger), all own, nothing associated; an ignore trigger has no
 * action, a trigger without `items` no rule.
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

/** A negative probe: POST a body as is; a 2xx is recorded. */
export async function probeWorkflowObject(api: GuardedApi, spec: string, kind: WorkflowKind, body: JsonObject, note: string): Promise<ApiAnswer> {
    return probeCollectionCreate(api, spec, { type: kind, path: kindPath(kind), body, note });
}

async function putOwn(api: GuardedApi, kind: WorkflowKind, ref: OwnRef, body: JsonObject): Promise<ApiAnswer> {
    await assertOwnLive(api, kind, ref, `putOwn ${kind}`);
    return sendJson(api, 'PUT', `${kindPath(kind)}/${ref.uuid}`, body);
}

/** `DELETE` of an own object through `ownCrud.deleteOwn`; a refusal (422, naming the parent) is returned as an `ApiAnswer`. */
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
