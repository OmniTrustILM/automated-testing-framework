/**
 * callbackTargets — how a preflight tells the guard which pre-existing objects an attribute callback of this run may name.
 *
 * `registerCallbackTarget(api, kind, uuid)` adds a canonical uuid to the authority instances or connectors the guarded
 * context accepts as the path id of `/v1/raProfiles/{id}/callback` / `/v2/connectors/{id}/callback` (allowLists.ts
 * POST_CALLBACK). Per context, in memory; a context the guard did not make, an unknown kind or a non-canonical uuid is
 * an error.
 *
 * A callback goes to a PRE-EXISTING connector, so its path id must be what the run discovered, not what a caller names.
 * Only the preflight may register: the lint rule `callback-target` (utils/regression/specLint/rules.ts) refuses every
 * reference to this module outside the guard's folder, the unit tests and `utils/timestamping/provision/preflight.ts`.
 */
import { STATES } from './guardState';
import { isCanonicalUuid } from './uuids';
import type { GuardedApi } from './types';

export function registerCallbackTarget(api: GuardedApi, kind: 'authority' | 'connector', uuid: string): void {
    const state = STATES.get(api);
    if (!state) throw new Error('registerCallbackTarget: not a guarded context');
    if (kind !== 'authority' && kind !== 'connector') throw new Error(`registerCallbackTarget: unknown kind ${String(kind)}`);
    if (!isCanonicalUuid(uuid)) throw new Error('registerCallbackTarget: a canonical uuid is required');
    state.callbackTargets[kind].add(uuid.toLowerCase());
}
