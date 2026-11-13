/**
 * rawAnswers — one guarded request whose answer is read without throwing (`sendRaw` returns an `ApiAnswer`), and readers for error bodies:
 * a 422 string array, a 400 / 404 `{message}`, and the words an error body must never carry.
 */
import { errorShape, internalLeaks } from '../errorContract';
import { GuardedApi, assertGuarded } from '../guard/types';
import { ApiAnswer, answerOf, createdAfterOf } from '../apiReads';


export interface RawOptions {
    headers?: Record<string, string>;
    identityOverride?: boolean;
}

/** One guarded request read without throwing; a Buffer body is sent as written, an object as JSON. */
export async function sendRaw(api: GuardedApi, method: 'GET' | 'POST' | 'PATCH' | 'PUT' | 'DELETE', url: string, data?: unknown, opts: RawOptions = {}): Promise<ApiAnswer> {
    const started = Date.now();
    const options: Record<string, unknown> = { method };
    if (data !== undefined) options.data = data;
    if (opts.headers) options.headers = opts.headers;
    if (opts.identityOverride) options.identityOverride = true;
    const res = await assertGuarded(api, `lifecycle.sendRaw ${method}`).fetch(url, options);
    return answerOf(res, started);
}

export const createdAfterOfAnswer = (a: ApiAnswer): string | undefined => (a.serverAt ? createdAfterOf(a) : undefined);

export function messagesOf(a: ApiAnswer): string[] {
    const s = errorShape(a.text);
    if (s.kind !== 'messages') throw new Error(`a 422 body must be a JSON array of non-empty strings; got ${s.kind === 'other' ? s.why : s.kind}: ${a.text.slice(0, 300)}`);
    return s.messages;
}

export function messageOf(a: ApiAnswer): string {
    const s = errorShape(a.text);
    if (s.kind !== 'message') throw new Error(`an error body must be {"message": "<text>"} and nothing else; got ${s.kind === 'other' ? s.why : s.kind}: ${a.text.slice(0, 300)}`);
    return s.message;
}

export const leaksIn = (text: string): string[] => internalLeaks(text);
