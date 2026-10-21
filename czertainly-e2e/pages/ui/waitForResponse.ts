/**
 * "Act, then wait for the API's answer": the one place that registers `page.waitForResponse` BEFORE the action (so a fast
 * answer is never missed) and returns the Response once the action has run.
 */
import type { Page, Response } from '@playwright/test';

/** The path segment of an object id in an API path (a uuid). */
export const UUID = '[0-9a-f-]{36}';

export interface ApiCall {
    /** The HTTP method, or a predicate over it (`(m) => m !== 'GET'`). */
    method: string | ((method: string) => boolean);
    /** A string matches the end of the URL path, a RegExp tests the path, a function receives the path. */
    path: string | RegExp | ((pathname: string) => boolean);
    /** Overrides the default timeout of the wait. */
    timeout?: number;
}

function matches(call: ApiCall, response: Response): boolean {
    const method = response.request().method();
    if (typeof call.method === 'string' ? method !== call.method : !call.method(method)) return false;
    const pathname = new URL(response.url()).pathname;
    if (typeof call.path === 'string') return pathname.endsWith(call.path);
    return call.path instanceof RegExp ? call.path.test(pathname) : call.path(pathname);
}

/** Starts waiting for the answer to `call` (register it before the action that causes it); await the result afterwards. */
export function watchApiCall(page: Page, call: ApiCall): Promise<Response> {
    return page.waitForResponse((r) => matches(call, r), call.timeout === undefined ? undefined : { timeout: call.timeout });
}

/** Runs `act` and returns the API answer it caused. The wait is registered before `act` starts. */
export async function actAndWaitForApi(page: Page, call: ApiCall, act: () => Promise<unknown>): Promise<Response> {
    const answer = watchApiCall(page, call);
    try {
        await act();
    } catch (error) {
        answer.catch(() => undefined); // the wait is abandoned with the failed action
        throw error;
    }
    return answer;
}
