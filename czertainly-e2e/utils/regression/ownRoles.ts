/**
 * ownRoles — the roles this run creates: the raw create, a recorded create with a unique name, and the run's shared role.
 * Every create fills the REQUIRED custom attributes of roles a tier defines (a create without them answers 422 there).
 */
import { GuardedApi } from './guard/types';
import { apiJson } from './apiReads';
import { requiredCustomAttributes } from './customAttributes';
import { OwnRef, recordCreated, Ref } from './ledger/ledger';
import { readRunState, runName, runId, updateRunState } from './ledger/runState';
import { timestampSuffix } from './text';

type Json = Record<string, any>;

export interface RoleFields {
    description?: string;
    /** A contact e-mail (`@example.test` only): what an e-mail notification to a ROLE reaches. */
    email?: string;
}

/** `POST /v1/roles` for a run-prefixed name; returns the Ref (not recorded: the caller records it). */
export async function createRole(api: GuardedApi, name: string, fields: RoleFields = {}): Promise<Ref> {
    const created = await apiJson<Json>(api, 'POST', '/api/v1/roles', {
        name,
        description: fields.description ?? `REG run ${runId()}`,
        ...(fields.email ? { email: fields.email } : {}),
        customAttributes: await requiredCustomAttributes(api, 'roles', runName('ca')),
    });
    return { uuid: created.uuid, name };
}

/** A NEW run role (not the run's shared role): `<run>-<suffix>-<time>`, recorded in the ledger right after the create. */
export async function createOwnRole(api: GuardedApi, spec: string, suffix: string, opts: RoleFields & { note?: string } = {}): Promise<OwnRef> {
    const { note, ...fields } = opts;
    return recordCreated('roles', await createRole(api, runName(`${suffix}-${timestampSuffix()}`), fields), spec, note ?? 'API prerequisite');
}

/** The run's shared role: the run state's, else a new one created and recorded. */
export async function ensureRunRole(api: GuardedApi, spec: string): Promise<OwnRef> {
    const state = readRunState();
    if (state.role) return state.role;
    const ref = recordCreated('roles', await createRole(api, runName('role')), spec, 'API prerequisite');
    updateRunState({ role: ref });
    return ref;
}
