/**
 * ownRoles — the roles this run creates: the raw create, a recorded create with a unique name, and the run's shared role.
 * Every create fills the REQUIRED custom attributes of roles a tier defines (a create without them answers 422 there).
 */
import { GuardedApi } from './guard/types';
import { createOwn } from './ownCrud';
import { requiredCustomAttributes } from './customAttributes';
import { OwnRef } from './ledger/ledger';
import { readRunState, runName, runId, updateRunState, ownName } from './ledger/runState';

export interface RoleFields {
    description?: string;
    email?: string;
}

export async function roleBody(api: GuardedApi, fields: RoleFields = {}): Promise<Record<string, unknown>> {
    return {
        description: fields.description ?? `REG run ${runId()}`,
        ...(fields.email ? { email: fields.email } : {}),
        customAttributes: await requiredCustomAttributes(api, 'roles', runName('ca')),
    };
}

export interface RoleOptions extends RoleFields {
    note?: string;
    name?: string;
}

export async function createOwnRole(api: GuardedApi, spec: string, suffix: string, o: RoleOptions = {}): Promise<OwnRef> {
    const { answer: _answer, ...ref } = await createOwn(api, spec, {
        type: 'roles',
        path: '/api/v1/roles',
        name: o.name ?? ownName(suffix),
        note: o.note ?? 'API prerequisite',
        body: await roleBody(api, o),
    });
    return ref;
}

export async function ensureRunRole(api: GuardedApi, spec: string): Promise<OwnRef> {
    const state = readRunState();
    if (state.role) return state.role;
    const ref = await createOwnRole(api, spec, 'role', { name: runName('role') });
    updateRunState({ role: ref });
    return ref;
}
