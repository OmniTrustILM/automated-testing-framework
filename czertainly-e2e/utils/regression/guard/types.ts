import { LiveOptions, OwnObjectViolation } from '../ledger/ownership';
import type { APIRequestContext } from '@playwright/test';

export interface GuardOptions {
    localStack?: boolean;
}

/** Test-only seams: ledger lines, run id, tier and environment the guard judges against. Specs never pass them. */
export interface GuardTestSeams extends LiveOptions {}

export interface GuardedApi extends APIRequestContext {
    probeUuid(): string;
}

export const GUARDED = new WeakSet<object>();

export const NOT_GUARDED_REASON = 'a mutating request needs the guarded API context (the `api` fixture or getGuardedApiContext), not a raw APIRequestContext';

export function isGuardedApi(api: unknown): api is GuardedApi {
    return typeof api === 'object' && api !== null && GUARDED.has(api);
}

export function assertGuarded(api: APIRequestContext, where: string): GuardedApi {
    if (!isGuardedApi(api)) throw new OwnObjectViolation(where, {}, NOT_GUARDED_REASON, undefined, 'not-guarded');
    return api;
}

