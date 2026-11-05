/**
 * guardRig — the loopback rigs shared by the unit tests.
 * `registerGuardRig` also starts a second server that must never be reached; `registerFakeCore` is a stateful fake core.
 */
import { request, test } from '@playwright/test';
import type { APIRequestContext, APIResponse, TestInfo } from '@playwright/test';
import { guardApi } from '../../../utils/regression/guard/createGuard';
import type { GuardedApi } from '../../../utils/regression/guard/types';
import { runId } from '../../../utils/regression/ledger/runState';
import { Arrived, Answer, loopbackServer, LoopbackServer } from './loopbackServer';

export interface GuardRig {
    A: LoopbackServer;
    B: LoopbackServer;
    raw: APIRequestContext;
    BASE_URL: string;
}

export interface GuardRigOptions {
    answer?: (req: Arrived) => Answer | undefined;
    headers?: Record<string, string>;
    /** Runs after the rig is up (for example to fill the fake core's live objects from the raw context). */
    afterStart?: (rig: GuardRig) => Promise<void> | void;
    beforeEachTest?: () => void;
}

export function registerGuardRig(opts: GuardRigOptions, assign: (rig: GuardRig) => void): void {
    let rig: GuardRig | undefined;
    test.beforeAll(async () => {
        const A = await loopbackServer(opts.answer);
        const B = await loopbackServer();
        const BASE_URL = `${A.origin}/administrator/`;
        const raw = await request.newContext({ baseURL: BASE_URL, extraHTTPHeaders: opts.headers ?? { Authorization: 'Bearer SECRET-TOKEN' } });
        rig = { A, B, raw, BASE_URL };
        assign(rig);
        await opts.afterStart?.(rig);
    });
    test.afterAll(async () => {
        await rig?.raw.dispose();
        await rig?.A.close();
        await rig?.B.close();
    });
    test.beforeEach(() => {
        rig?.A.reset();
        rig?.B.reset();
        opts.beforeEachTest?.();
    });
}

export async function withProcessEnv<T>(vars: Record<string, string>, fn: () => Promise<T>): Promise<T> {
    const saved = Object.fromEntries(Object.keys(vars).map((k) => [k, process.env[k]]));
    Object.assign(process.env, vars);
    try {
        return await fn();
    } finally {
        for (const [k, v] of Object.entries(saved)) {
            if (v === undefined) delete process.env[k];
            else process.env[k] = v;
        }
    }
}

type EnvValues = Record<string, string | undefined> | ((testInfo: TestInfo) => Record<string, string | undefined>);

export function useEnv(keys: readonly string[], values: EnvValues = {}): void {
    let saved: Record<string, string | undefined> = {};
    test.beforeEach(({}, testInfo) => {
        saved = Object.fromEntries(keys.map((k) => [k, process.env[k]]));
        for (const k of keys) delete process.env[k];
        const now = typeof values === 'function' ? values(testInfo) : values;
        for (const [k, v] of Object.entries(now)) if (v !== undefined) process.env[k] = v;
    });
    test.afterEach(() => {
        for (const [k, v] of Object.entries(saved)) {
            if (v === undefined) delete process.env[k];
            else process.env[k] = v;
        }
    });
}

export interface FakeCoreRig {
    server: LoopbackServer;
    raw: APIRequestContext;
    api: GuardedApi;
}

export interface FakeCoreOptions {
    env?: Record<string, string>;
    clear?: readonly string[];
    token?: string;
    guarded?: boolean;
}

const RIG_ENV = ['REG_STATE_DIR', 'BASE_URL', 'TIER_KIND', 'REG_RUN_ID', 'API_TEARDOWN_DRY_RUN'];

export function registerFakeCore(core: () => { answer: (a: Arrived) => Answer | undefined }, assign: (rig: FakeCoreRig) => void, opts: FakeCoreOptions = {}): void {
    let server: LoopbackServer | undefined;
    let current: FakeCoreRig | undefined;
    const keys = [...RIG_ENV, ...(opts.clear ?? []), ...Object.keys(opts.env ?? {})];
    useEnv(keys, (testInfo) => ({
        REG_STATE_DIR: testInfo.outputPath('state'),
        BASE_URL: `${server?.origin}/administrator/`,
        TIER_KIND: 'shared',
        REG_RUN_ID: runId(),
        ...(opts.env ?? {}),
    }));
    test.beforeAll(async () => {
        server = await loopbackServer((a) => core().answer(a));
    });
    test.afterAll(async () => {
        await server?.close();
    });
    test.beforeEach(async () => {
        server?.reset();
        const raw = await request.newContext({ baseURL: process.env.BASE_URL, extraHTTPHeaders: { Authorization: `Bearer ${opts.token ?? 'SECRET-TOKEN'}` } });
        current = { server: server!, raw, api: opts.guarded === false ? rawAsGuarded(raw) : guardApi(raw) };
        assign(current);
    });
    test.afterEach(async () => {
        await current?.api.dispose();
    });
}

type RequestMethodName = 'get' | 'post' | 'put' | 'patch' | 'delete' | 'head' | 'fetch';
export type LooseApi = Omit<GuardedApi, RequestMethodName> & { [M in RequestMethodName]: (url: unknown, options?: unknown) => Promise<APIResponse> };

export const looseApi = (api: unknown): LooseApi => api as LooseApi;

export function partialOf<T>(members: Partial<T>): T {
    return members as T;
}

export function fakeContext(members: Record<string, unknown>): APIRequestContext {
    return members as unknown as APIRequestContext;
}

export function rawAsGuarded(raw: APIRequestContext): GuardedApi {
    return raw as unknown as GuardedApi;
}
