/**
 * guardVerdict — the guard's verdict on a request, without sending it. `guardVerdict(api, opts)` returns `{ check(method, url,
 * data?, options?) }`, which resolves when the guard would send the request and throws when it would refuse it.
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
