/**
 * workflowRequests — how the events and discovery helpers talk to the API: one guarded request that hands back the answer
 * whatever its status (`sendJson` → `ApiAnswer`) and the readers of an error body. A negative case asserts the answer
 * itself; only the guard's own refusals throw.
 */
import { ApiAnswer, answerOf } from '../apiReads';
import { GuardedApi, assertGuarded } from '../guard/types';

// ------------------------------------------------------------------ sending (status + text, never throwing on 4xx)

export type Method = 'GET' | 'POST' | 'PUT' | 'PATCH' | 'DELETE';

/**
 * One request through the guarded context; the answer is returned whatever its status (a negative case asserts it).
 * Only the guard's own refusals throw (`OwnObjectViolation`).
 */
export async function sendJson(api: GuardedApi, method: Method, url: string, data?: unknown): Promise<ApiAnswer> {
    const started = Date.now();
    const opts = data === undefined ? {} : { data };
    if (method !== 'GET') assertGuarded(api, `sendJson ${method} ${url}`); // a raw context never mutates (deny by default)
    switch (method) {
        case 'GET':
            return answerOf(await api.get(url), started);
        case 'POST':
            return answerOf(await api.post(url, opts), started);
        case 'PUT':
            return answerOf(await api.put(url, opts), started);
        case 'PATCH':
            return answerOf(await api.patch(url, opts), started);
        case 'DELETE':
            return answerOf(await api.delete(url, opts), started);
    }
}

/** The status is 2xx (the create contract says 201, the controller answers the DTO with the default 200: both are accepted). */
export const isOk = (s: ApiAnswer): boolean => s.status >= 200 && s.status < 300;

/** The messages of an error body: a 422 is a JSON array of strings, 400 / 404 / 409 / 500 are `{message}`. */
export function errorTexts(s: ApiAnswer): string[] {
    if (Array.isArray(s.json)) return s.json.map(String);
    if (s.json && typeof s.json === 'object' && typeof s.json.message === 'string') return [s.json.message];
    return s.text ? [s.text] : [];
}

/** The shape of an error body: 'array' (422), 'message' (`{message}`), or 'other'. */
export function errorShapeOf(s: ApiAnswer): 'array' | 'message' | 'other' {
    if (Array.isArray(s.json) && s.json.every((x) => typeof x === 'string')) return 'array';
    if (s.json && typeof s.json === 'object' && !Array.isArray(s.json) && typeof s.json.message === 'string') return 'message';
    return 'other';
}
