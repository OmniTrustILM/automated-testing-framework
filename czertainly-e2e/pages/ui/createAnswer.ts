/**
 * createAnswer — `createAnswerFrom` and `createAnswerOf`: what a create form's request answered.
 * A page object returns this from `submit…` and never writes a ledger line itself; the spec does, because the teardown removes only what
 * the ledger names.
 */
import type { Page, Request, Response } from '@playwright/test';
import type { ApiAnswer } from '../../utils/regression/apiReads';
import { actAndWaitForApi, answerFrom, ApiCall } from './waitForResponse';

export interface CreateAnswer {
    status: number;
    /** Undefined when the answer carries none (a refusal, or an empty body). */
    uuid?: string;
    text: string;
    /** The create request the form sent, for the request-to-stored-object oracle. */
    request: Request;
    body: Record<string, unknown>;
    answer: ApiAnswer;
}

const UUID_SHAPE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export async function createAnswerOf(response: Response, startedAt: number): Promise<CreateAnswer> {
    const request = response.request();
    let text = '';
    try {
        text = await response.text();
    } catch {
        text = '';
    }
    let uuid: string | undefined;
    try {
        const parsed = JSON.parse(text) as { uuid?: unknown };
        if (typeof parsed?.uuid === 'string' && UUID_SHAPE.test(parsed.uuid)) uuid = parsed.uuid;
    } catch {
        uuid = undefined;
    }
    let body: Record<string, unknown> = {};
    try {
        body = (request.postDataJSON() as Record<string, unknown> | null) ?? {};
    } catch {
        body = {};
    }
    return { status: response.status(), uuid, text, request, body, answer: await answerFrom(response, startedAt) };
}

export async function createAnswerFrom(page: Page, call: ApiCall, act: () => Promise<unknown>): Promise<CreateAnswer> {
    const startedAt = Date.now();
    return createAnswerOf(await actAndWaitForApi(page, call, act), startedAt);
}
