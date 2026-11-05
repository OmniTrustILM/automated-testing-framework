/**
 * guardVerdict — the guard's verdict on a request, without sending it.
 *
 * `guardVerdict(api, opts)` returns `{ check(method, url, data?, options?) }`. It reads the request and runs the guard's
 * rules on it exactly as a guarded request would, and resolves when the guard would send it or throws the
 * OwnObjectViolation when it would refuse it. Nothing is sent. It is a thin wrapper over `judgeWithSeams` of
 * createGuard.ts; `opts` are the guard options and the test seams of `guardApiWithSeams`.
 */
import { judgeWithSeams } from '../../../utils/regression/guard/createGuard';
import type { GuardOptions, GuardTestSeams } from '../../../utils/regression/guard/types';
import type { APIRequestContext } from '@playwright/test';

export interface GuardVerdict {
    check(method: string, url: string, data?: unknown, options?: Record<string, unknown>): Promise<void>;
}

export function guardVerdict(api: APIRequestContext, opts: GuardOptions & GuardTestSeams = {}): GuardVerdict {
    return { check: (method, url, data, options) => judgeWithSeams(api, opts, method, url, data, options) };
}
