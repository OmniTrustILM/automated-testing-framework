/**
 * createGuard — wraps an APIRequestContext so that nothing the run did not create can be changed.
 *
 * Every request (`get`, `post`, `put`, `patch`, `delete`, `fetch`) is judged before it is sent. Shared tiers are create-only
 * and the guard denies by default: a request goes out only when a rule lets it through. A refusal is an OwnObjectViolation
 * (kind `ownership`, `derived`, `request` or `not-guarded`).
 *
 * The guard sends exactly what it judged: the input is read once into a snapshot and Playwright gets only the snapshot.
 * `probeUuid()` gives a random uuid the guard accepts as a target, for negative cases that must answer 404.
 */
import { getAuthenticatedApiContext } from '../../auth/apiContext';
import { GuardState, STATES } from './guardState';
import { Entry, readRequest } from './readRequest';
import { checkRequest } from './checkRequest';
import { checkAndSend } from './sendRequest';
import { GUARDED, GuardedApi, GuardOptions, GuardTestSeams } from './types';
import type { Method } from './headers';
import * as crypto from 'crypto';
import type { APIRequestContext, APIResponse } from '@playwright/test';

type FetchOptions = { method?: string; data?: unknown } & Record<string, unknown>;

function createGuard(api: APIRequestContext, options: GuardOptions, seams: GuardTestSeams): GuardedApi {
    const state = new GuardState(api, options, seams);
    // async: a refusal while reading is a rejected promise, like every other refusal.
    const guardedRequest = async (entry: Entry, url: unknown, requestOptions?: FetchOptions): Promise<APIResponse> =>
        checkAndSend(state, readRequest(state.env, entry, url, requestOptions));
    const wrapper = (method: Method | 'HEAD') => (url: string, requestOptions?: FetchOptions): Promise<APIResponse> => guardedRequest({ kind: 'wrapper', method }, url, requestOptions);
    const guarded = {
        get: wrapper('GET'),
        // A refuser: GuardedApi extends APIRequestContext, which has `head`, but the guard sends no HEAD, so calling it
        // is refused as an unknown method (the same refusal as `fetch(url, { method: 'HEAD' })`).
        head: wrapper('HEAD'),
        post: wrapper('POST'),
        put: wrapper('PUT'),
        patch: wrapper('PATCH'),
        delete: wrapper('DELETE'),
        fetch: (url: string, requestOptions?: FetchOptions): Promise<APIResponse> => guardedRequest({ kind: 'fetch' }, url, requestOptions),
        dispose: async (disposeOptions?: { reason?: string }) => api.dispose(disposeOptions),
        storageState: (storageOptions?: Parameters<APIRequestContext['storageState']>[0]) => api.storageState(storageOptions),
        probeUuid: () => {
            const u = crypto.randomUUID();
            state.probes.add(u);
            return u;
        },
    };
    GUARDED.add(guarded);
    STATES.set(guarded, state);
    return guarded as unknown as GuardedApi;
}

/**
 * Wrap an authenticated context; dispose the guarded one (it disposes the wrapped context). Only `localStack` is read
 * from `opts`: the ledger, run id, tier and environment are always the process's own.
 */
export function guardApi(api: APIRequestContext, opts: GuardOptions = {}): GuardedApi {
    return createGuard(api, { localStack: opts.localStack }, {});
}

/** Unit tests only: the guard judging against injected ledger lines, run id, tier and environment. */
export function guardApiWithSeams(api: APIRequestContext, opts: GuardOptions & GuardTestSeams = {}): GuardedApi {
    const { localStack, ...seams } = opts;
    return createGuard(api, { localStack }, seams);
}

/**
 * Unit tests only: the guard's verdict on one request, without sending it. It reads and checks the request exactly as a guarded `fetch(url,
 * { method, data, ...options })` does and resolves when the guard would send it, or throws the refusal.
 */
export async function judgeWithSeams(
    api: APIRequestContext, opts: GuardOptions & GuardTestSeams, method: string, url: string, data?: unknown, options: Record<string, unknown> = {},
): Promise<void> {
    const { localStack, ...seams } = opts;
    const state = new GuardState(api, { localStack }, seams);
    await checkRequest(state, readRequest(state.env, { kind: 'fetch' }, url, { ...options, method, ...(data !== undefined ? { data } : {}) }));
}

/**
 * `getAuthenticatedApiContext` wrapped in the guard: the API context of REG-* / API-* specs that do not use the `api`
 * fixture. Signature stable: `getGuardedApiContext(request, env, opts?)`. Dispose it in finally.
 */
export async function getGuardedApiContext(request: APIRequestContext, env: import('../../env').TestEnv, opts: GuardOptions = {}): Promise<GuardedApi> {
    return guardApi(await getAuthenticatedApiContext(request, env), opts);
}
