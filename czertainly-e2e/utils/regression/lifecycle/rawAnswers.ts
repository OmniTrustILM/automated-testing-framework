/**
 * rawAnswers — one guarded request whose answer is read without throwing.
 *
 * WHAT: one guarded request whose answer is read without throwing (`sendRaw` → `ApiAnswer`), and the readers of
 *       its error body: a 422 string array, a 400 / 404 `{message}`, the words an error body must never carry. Negatives
 *       assert status AND body shape through these.
 * WHY: A negative must assert status and body shape, so its helper may not throw on a 4xx.
 * HOW: `sendRaw` returns an `ApiAnswer`; the readers take a 422 string array, a 400 or 404 `{message}` and the words an error body must
 * never carry.
 */
import { errorShape, internalLeaks } from '../errorContract';
import { GuardedApi, assertGuarded } from '../guard/types';
import { ApiAnswer, answerOf, createdAfterOf } from '../apiReads';

// ------------------------------------------------------------------ raw answers (negatives assert status + shape)

export interface RawOptions {
    headers?: Record<string, string>;
    /** Another identity than the run's (401 negatives): an identity header needs the guard's switch. */
    identityOverride?: boolean;
}

/**
 * One guarded request whose answer is read without throwing: status, text, parsed JSON when the body parses, the server
 * Date. A Buffer body is sent as written (a malformed-JSON negative); an object is sent as JSON.
 */
export async function sendRaw(api: GuardedApi, method: 'GET' | 'POST' | 'PATCH' | 'PUT' | 'DELETE', url: string, data?: unknown, opts: RawOptions = {}): Promise<ApiAnswer> {
    const started = Date.now();
    const options: Record<string, unknown> = { method };
    if (data !== undefined) options.data = data;
    if (opts.headers) options.headers = opts.headers;
    if (opts.identityOverride) options.identityOverride = true;
    const res = await assertGuarded(api, `lifecycle.sendRaw ${method}`).fetch(url, options);
    return answerOf(res, started);
}

/** The `createdAfter` of a raw answer when it carried a server Date (undefined without one; `createdAfterOf` is the rule). */
export const createdAfterOfAnswer = (a: ApiAnswer): string | undefined => (a.serverAt ? createdAfterOf(a) : undefined);

/** The 422 body as its string list, or a problem text (the caller's assertion names it). */
export function messagesOf(a: ApiAnswer): string[] {
    const s = errorShape(a.text);
    if (s.kind !== 'messages') throw new Error(`a 422 body must be a JSON array of non-empty strings; got ${s.kind === 'other' ? s.why : s.kind}: ${a.text.slice(0, 300)}`);
    return s.messages;
}

/** The `{message}` body's text, or a problem text. */
export function messageOf(a: ApiAnswer): string {
    const s = errorShape(a.text);
    if (s.kind !== 'message') throw new Error(`an error body must be {"message": "<text>"} and nothing else; got ${s.kind === 'other' ? s.why : s.kind}: ${a.text.slice(0, 300)}`);
    return s.message;
}

/** The leak words found in an error body (empty = clean); the list lives in `errorContract` (`INTERNAL_LEAK_WORDS`). */
export const leaksIn = (text: string): string[] => internalLeaks(text);
