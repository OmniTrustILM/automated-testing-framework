/**
 * callbackTargets — the one way a preflight tells the guard which pre-existing objects an attribute callback of this run may name.
 *
 * WHAT: `registerCallbackTarget(api, kind, uuid)` adds a canonical uuid to the authority instances or connectors the guarded context `api` accepts
 * as the path id of `/v1/raProfiles/{id}/callback` / `/v2/connectors/{id}/callback` (allowLists.ts POST_CALLBACK). Per context, in memory.
 * WHY: a callback is sent to a PRE-EXISTING connector, so its path id must be what the run discovered, not what a caller names. The registration
 * must therefore be reachable from the preflight only: it is not a method of the guarded context (a spec holds that), and the lint rule
 * `callback-target` (utils/regression/specLint/rules.ts) refuses every reference to this function or module outside the guard's folder, the unit
 * tests and `utils/timestamping/provision/preflight.ts` (tests/unit/specGuards.spec.ts runs it over the timestamping and key-onboarding blocks too).
 * HOW: createGuard keeps the state of every context it makes (`STATES`); this module looks it up. A context the guard did not make, an unknown
 * kind or a non-canonical uuid is an error.
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
