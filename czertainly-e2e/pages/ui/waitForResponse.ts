/**
 * waitForResponse — runs an action and returns the API response it caused; the wait is registered before the action.
 */
import type { Page, Response } from '@playwright/test';
import { ApiAnswer, answerOf } from '../../utils/regression/apiReads';

export const UUID = '[0-9a-f-]{36}';

export interface ApiCall {
    method: string | ((method: string) => boolean);
    path: string | RegExp | ((pathname: string) => boolean);
    timeout?: number;
}

function matches(call: ApiCall, response: Response): boolean {
    const method = response.request().method();
    if (typeof call.method === 'string' ? method !== call.method : !call.method(method)) return false;
    const pathname = new URL(response.url()).pathname;
    if (typeof call.path === 'string') return pathname.endsWith(call.path);
    return call.path instanceof RegExp ? call.path.test(pathname) : call.path(pathname);
}

export function watchApiCall(page: Page, call: ApiCall): Promise<Response> {
    return page.waitForResponse((r) => matches(call, r), call.timeout === undefined ? undefined : { timeout: call.timeout });
}

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

/** A body the browser no longer holds (an empty 204, a page that moved on) reads as empty text: the status is the proof. */
export async function answerFrom(response: Response, startedAt: number): Promise<ApiAnswer> {
    let text = '';
    try {
        text = await response.text();
    } catch {
        text = '';
    }
    return answerOf({ status: () => response.status(), headers: () => response.headers(), text: async () => text }, startedAt);
}

export async function actAndReadAnswer(page: Page, call: ApiCall, act: () => Promise<unknown>): Promise<ApiAnswer> {
    const startedAt = Date.now();
    return answerFrom(await actAndWaitForApi(page, call, act), startedAt);
}

export type AnswerWithUuid = ApiAnswer & { uuid?: string };

export async function actAndReadAnswerWithUuid(page: Page, call: ApiCall, act: () => Promise<unknown>): Promise<AnswerWithUuid> {
    const answer = await actAndReadAnswer(page, call, act);
    const uuid = (answer.json as { uuid?: unknown } | undefined)?.uuid;
    return { ...answer, uuid: typeof uuid === 'string' ? uuid : undefined };
}
