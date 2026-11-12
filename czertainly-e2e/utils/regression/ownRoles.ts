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
    /** A contact e-mail (`@example.test` only): what an e-mail notification to a ROLE reaches. */
    email?: string;
}

/** The request body of a role create without its name (every required custom attribute of roles filled). */
export async function roleBody(api: GuardedApi, fields: RoleFields = {}): Promise<Record<string, unknown>> {
    return {
        description: fields.description ?? `REG run ${runId()}`,
        ...(fields.email ? { email: fields.email } : {}),
        customAttributes: await requiredCustomAttributes(api, 'roles', runName('ca')),
    };
}

export interface RoleOptions extends RoleFields {
    note?: string;
    /** A planned name (the run's shared role, a fixture role); default `ownName(suffix)`. */
    name?: string;
}

/** A NEW run role: `<run>-<suffix>-<unique>`, recorded in the ledger right after the create. */
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

/** The run's shared role: the run state's, else a new one created and recorded. */
export async function ensureRunRole(api: GuardedApi, spec: string): Promise<OwnRef> {
    const state = readRunState();
    if (state.role) return state.role;
    const ref = await createOwnRole(api, spec, 'role', { name: runName('role') });
    updateRunState({ role: ref });
    return ref;
}
