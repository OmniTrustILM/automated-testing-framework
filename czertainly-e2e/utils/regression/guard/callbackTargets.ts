/**
 * callbackTargets — lets a preflight register the pre-existing authority instances / connectors an attribute callback may name.
 * Only the preflight may register (lint rule `callback-target`); per context, in memory.
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
