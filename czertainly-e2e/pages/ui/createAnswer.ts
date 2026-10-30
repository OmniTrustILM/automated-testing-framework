/**
 * createAnswer — what a create form's request answered, read from the response before the page does anything else.
 *
 * Provides `createAnswerFrom` (runs the click and returns status, uuid, body and more) and `createAnswerOf` (the same
 * from a response in hand).
 *
 * A create that succeeded must reach the run ledger even when the redirect never comes, because the teardown removes
 * only what the ledger names. A page object returns this from `submit…` and never writes a ledger line itself.
 */
import type { Page, Request, Response } from '@playwright/test';
import type { ApiAnswer } from '../../utils/regression/apiReads';
import { actAndWaitForApi, answerFrom, ApiCall } from './waitForResponse';

/** The answer of a create request a form sent. */
export interface CreateAnswer {
    /** The HTTP status of the answer. */
    status: number;
    /** The new object's uuid from the answer body; undefined when the answer carries none (a refusal, or an empty body). */
    uuid?: string;
    /** The answer body as text (for a failure message). */
    text: string;
    /** The create request the form sent (method POST, JSON body), for the request ↔ stored object ↔ detail oracle. */
    request: Request;
    /** The JSON body of the create request ({} when it had none). */
    body: Record<string, unknown>;
    /** The same answer in the one shape every helper reads (status, text, parsed JSON, headers, timing). */
    answer: ApiAnswer;
}

const UUID_SHAPE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/** Reads the answer of a create request: status, the answer's own `uuid` (a canonical uuid only), its text and the request. */
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

/** Runs `act` (the click on Create) and returns the answer of the create request `call` describes; the wait is registered first. */
export async function createAnswerFrom(page: Page, call: ApiCall, act: () => Promise<unknown>): Promise<CreateAnswer> {
    const startedAt = Date.now();
    return createAnswerOf(await actAndWaitForApi(page, call, act), startedAt);
}
