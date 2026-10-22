/**
 * The guard — wraps an APIRequestContext so that nothing the run did not create can be changed.
 *
 * WHAT: `guardApi` (and `getGuardedApiContext`, which wraps the authenticated context) returns a GuardedApi whose
 * `get`, `post`, `put`, `patch`, `delete` and `fetch` judge every request before sending it. A refusal is an
 * OwnObjectViolation whose `kind` says why: `ownership` (not this run's object), `derived` (an object the platform
 * made for a run object, e.g. a key or an onboarded certificate), `request` (the URL, options, headers, body format, a
 * non-canonical uuid, a platform endpoint, a name-keyed path, a path-less mutation off the allow-lists) or
 * `not-guarded` (a raw context in a mutating helper).
 * WHY: shared tiers are create-only. Deny by default: a request is sent only when a rule lets it through, and a rule
 * that is missing refuses. The guard judges what is SENT, and sends what it judged: it reads every request input once
 * into a snapshot (the URL string, the method, each allowed option, each header, each `params` entry, the body
 * serialised once), judges the snapshot and hands Playwright only the snapshot. Getters, `toJSON`, Proxies, stateful
 * `toString`s and Request objects are never read twice (a Request object is refused), and an option the guard does not
 * know never reaches Playwright. A string body is sent as Playwright sends it under `application/json` (as written when
 * it parses as JSON, else re-quoted) and judged as exactly that; a Buffer is sent byte for byte; a string or Buffer
 * under `text/plain` is sent as written and judged as raw text.
 * HOW: this module only wires the steps, one module each. The rules are listed once, where they are applied:
 * readRequest.ts (rules a–d and the snapshot) and checkRequest.ts (the GET and probe rules, rules 1–7, the approval
 * rules and `localStack`); claims.ts holds the ownership claims, sendRequest.ts the only function that sends (it checks
 * first), guardState.ts what the context keeps. `probeUuid()` returns a fresh random uuid the guard accepts as a
 * mutation target, for negative cases that must answer 404; it cannot name an existing object. The ledger, run id, tier
 * identity and environment the guard judges against are the process's own; unit tests inject them through
 * `guardApiWithSeams` and `judgeWithSeams` only (the spec lint refuses those names outside tests/unit).
 */
import { getAuthenticatedApiContext } from '../../auth/apiContext';
import { GuardState } from './guardState';
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
