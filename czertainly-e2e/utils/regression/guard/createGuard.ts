/**
 * createGuard — wraps an APIRequestContext so nothing the run did not create can be changed.
 * Every request is judged once into a snapshot and only the snapshot is sent; a refusal is an OwnObjectViolation.
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
    const guardedRequest = async (entry: Entry, url: unknown, requestOptions?: FetchOptions): Promise<APIResponse> =>
        checkAndSend(state, readRequest(state.env, entry, url, requestOptions));
    const wrapper = (method: Method | 'HEAD') => (url: string, requestOptions?: FetchOptions): Promise<APIResponse> => guardedRequest({ kind: 'wrapper', method }, url, requestOptions);
    const guarded = {
        get: wrapper('GET'),
        // The guard sends no HEAD: calling it is refused as an unknown method.
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

/** Wrap an authenticated context; disposing the guarded one disposes the wrapped one. Only `localStack` is read from `opts`. */
export function guardApi(api: APIRequestContext, opts: GuardOptions = {}): GuardedApi {
    return createGuard(api, { localStack: opts.localStack }, {});
}

export function guardApiWithSeams(api: APIRequestContext, opts: GuardOptions & GuardTestSeams = {}): GuardedApi {
    const { localStack, ...seams } = opts;
    return createGuard(api, { localStack }, seams);
}

/** Unit tests only: the guard's verdict on one request, without sending it. */
export async function judgeWithSeams(
    api: APIRequestContext, opts: GuardOptions & GuardTestSeams, method: string, url: string, data?: unknown, options: Record<string, unknown> = {},
): Promise<void> {
    const { localStack, ...seams } = opts;
    const state = new GuardState(api, { localStack }, seams);
    await checkRequest(state, readRequest(state.env, { kind: 'fetch' }, url, { ...options, method, ...(data !== undefined ? { data } : {}) }));
}

/** `getAuthenticatedApiContext` wrapped in the guard, for specs that do not use the `api` fixture. Dispose it in finally. */
export async function getGuardedApiContext(request: APIRequestContext, env: import('../../env').TestEnv, opts: GuardOptions = {}): Promise<GuardedApi> {
    return guardApi(await getAuthenticatedApiContext(request, env), opts);
}
