/**
 * createAnswer — what a create form's request answered, read from the RESPONSE before the page does anything else.
 *
 * WHAT: `createAnswerFrom` registers the wait for a create request's answer, runs the click and returns `{ status, uuid,
 *       text, request, body, answer }`; `createAnswerOf` reads the same from a response already in hand. The scope-based
 *       `submitCreate` and the later wait for the redirect are in `detailRoute.ts`.
 * WHY: a create that succeeded must reach the run ledger even when the redirect never comes (a slow tier, a changed route):
 *       the object is on a shared tier, and the teardown can only remove what the ledger names. So the form's answer, not the
 *       URL, is the first thing a spec sees; the spec writes the ledger line from it and only then waits for the route.
 * HOW: the answer's JSON `uuid` is the new object's id (`undefined` when the platform refused or sent none); a page object
 *       returns this from its `submit…` method and never writes a ledger line itself (the README rule).
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
