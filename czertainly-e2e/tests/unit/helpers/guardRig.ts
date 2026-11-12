/**
 * guardRig — the loopback rigs shared by the unit tests: the guard rig, the fake-core rig and the environment hook.
 *
 * WHAT: `registerGuardRig` starts a fake core (answers per `answer`), a second server that must never be reached and a real
 * Playwright APIRequestContext whose baseURL is the core. `registerFakeCore` does the same for a stateful fake core and
 * hands each test a guarded context on a fresh run state folder. `useEnv` sets named environment variables for each test
 * and puts every one back. `looseApi` views a guarded context with untyped url and options (the guard tests send options the typed
 * API forbids); `fakeContext`, `partialOf` and `rawAsGuarded` are the typed ways to hand a fake or a raw context to code that
 * wants a full one.
 * WHY: sixteen unit files used to copy the same save / restore blocks; one rig keeps the restore checked and the loopback-only
 * rule in one place.
 * HOW: hooks are registered on the calling file's `test`; requests go through the real Playwright client, so the tests
 * assert what actually reached the wire. Servers listen on 127.0.0.1 only.
 */
import { request, test } from '@playwright/test';
import type { APIRequestContext, APIResponse, TestInfo } from '@playwright/test';
import { guardApi } from '../../../utils/regression/guard/createGuard';
import type { GuardedApi } from '../../../utils/regression/guard/types';
import { runId } from '../../../utils/regression/ledger/runState';
import { Arrived, Answer, loopbackServer, LoopbackServer } from './loopbackServer';

export interface GuardRig {
    /** The fake core. */
    A: LoopbackServer;
    /** A second server: nothing may reach it (the guard talks to BASE_URL's origin only). */
    B: LoopbackServer;
    /** The raw, unguarded context pointing at the core (base path `/administrator/`). */
    raw: APIRequestContext;
    BASE_URL: string;
}

export interface GuardRigOptions {
    /** How the fake core answers (default: 200 `{}`). */
    answer?: (req: Arrived) => Answer | undefined;
    /** Extra headers of the raw context (default: a bearer token). */
    headers?: Record<string, string>;
    /** Runs after the rig is up (for example to fill the fake core's live objects from the raw context). */
    afterStart?: (rig: GuardRig) => Promise<void> | void;
    /** Runs before each test, after the servers were reset. */
    beforeEachTest?: () => void;
}

/**
 * Registers beforeAll / afterAll / beforeEach hooks of the calling spec file: starts the rig, hands it to `assign`
 * (the spec keeps its own `let A, B, raw, BASE_URL` variables), resets both servers before every test and disposes
 * everything after the file.
 */
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

/** Runs `fn` with the given process environment variables set, and puts every one of them back afterwards. */
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

/**
 * Registers hooks of the calling file: before each test the named variables are removed and `values` is applied (an
 * undefined value stays removed); after each test every named variable is put back to what it was.
 */
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
    /** The raw context (bearer token, base path `/administrator/`). */
    raw: APIRequestContext;
    /** The guarded context a spec receives. */
    api: GuardedApi;
}

export interface FakeCoreOptions {
    /** Extra environment variables of every test (the run state folder, BASE_URL, TIER_KIND and REG_RUN_ID are always set). */
    env?: Record<string, string>;
    /** Environment variables that are cleared before every test and restored after it, besides the ones in `env`. */
    clear?: readonly string[];
    /** The bearer token of the raw context. */
    token?: string;
    /** The raw context is wrapped by the guard unless this is false. */
    guarded?: boolean;
}

const RIG_ENV = ['REG_STATE_DIR', 'BASE_URL', 'TIER_KIND', 'REG_RUN_ID', 'API_TEARDOWN_DRY_RUN'];

/**
 * Registers hooks of the calling file: one loopback server answers through `core().answer`, and every test gets a fresh
 * context pointing at it (`assign` receives it) with a run state folder under the test output, a shared tier and the
 * run id the ledger writer uses. The core object itself is made by the file (in its own beforeEach).
 */
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

/**
 * A guarded context seen with loose option types: the guard tests send options the typed API forbids (a smuggled `url`, an
 * unknown key) to prove the guard refuses them, so the url and options are untyped here.
 */
type RequestMethodName = 'get' | 'post' | 'put' | 'patch' | 'delete' | 'head' | 'fetch';
export type LooseApi = Omit<GuardedApi, RequestMethodName> & { [M in RequestMethodName]: (url: unknown, options?: unknown) => Promise<APIResponse> };

/** The guarded context with loose option types (see LooseApi). */
export const looseApi = (api: unknown): LooseApi => api as LooseApi;

/** A fake that implements only the members a test calls, typed as the full interface (the test names those members). */
export function partialOf<T>(members: Partial<T>): T {
    return members as T;
}

/**
 * A fake APIRequestContext of the members a test calls. The members answer with plain response-like objects, so they are
 * not typed against Playwright's own signatures; this is the one place where the fake is cast to the full interface.
 */
export function fakeContext(members: Record<string, unknown>): APIRequestContext {
    return members as unknown as APIRequestContext;
}

/** A raw (unguarded) context handed to a helper that takes a guarded one, to show the helper refuses it. */
export function rawAsGuarded(raw: APIRequestContext): GuardedApi {
    return raw as unknown as GuardedApi;
}
