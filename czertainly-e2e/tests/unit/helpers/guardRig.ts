/**
 * The loopback rig shared by the guard unit tests: a fake core (answers per `answer`), a second server that must never
 * be reached, and a real Playwright APIRequestContext whose baseURL is the core. Requests go through the real
 * Playwright client, so the tests assert what actually reached the wire.
 */
import { request, test } from '@playwright/test';
import type { APIRequestContext } from '@playwright/test';
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
