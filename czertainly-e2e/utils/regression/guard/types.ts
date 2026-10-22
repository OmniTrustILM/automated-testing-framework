import { LiveOptions, OwnObjectViolation } from '../ledger/ownership';
import type { APIRequestContext } from '@playwright/test';

export interface GuardOptions {
    /** `@local` specs: platform endpoints and any object on a proven local stack (TIER_KIND=local + this run's proof). */
    localStack?: boolean;
}

/**
 * Test-only seams (tests/unit): the ledger lines, run id, tier identity and environment the guard judges against.
 * Specs never pass them (specGuards refuses `guardApiWithSeams` outside tests/unit): ownership and the tier come from
 * the process.
 */
export interface GuardTestSeams extends LiveOptions {}

export interface GuardedApi extends APIRequestContext {
    /** A fresh random uuid the guard accepts as a mutation target (negative cases answering 404). */
    probeUuid(): string;
}

/** Contexts made by the guard (the runtime brand `assertGuarded` checks). */
export const GUARDED = new WeakSet<object>();

/** The reason `assertGuarded` gives (the live proof tells it apart from an ownership refusal). */
export const NOT_GUARDED_REASON = 'a mutating request needs the guarded API context (the `api` fixture or getGuardedApiContext), not a raw APIRequestContext';

export function isGuardedApi(api: unknown): api is GuardedApi {
    return typeof api === 'object' && api !== null && GUARDED.has(api);
}

/** The context, when the guard made it; else OwnObjectViolation (a mutating helper handed a raw context). */
export function assertGuarded(api: APIRequestContext, where: string): GuardedApi {
    if (!isGuardedApi(api)) throw new OwnObjectViolation(where, {}, NOT_GUARDED_REASON, undefined, 'not-guarded');
    return api;
}

