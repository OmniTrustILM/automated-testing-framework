/**
 * workflowRequests — how the events and discovery helpers talk to the API: `sendJson` hands back the answer whatever its status, only the
 * guard's own refusals throw; plus readers of an error body.
 */
import { ApiAnswer, answerOf } from '../apiReads';
import { GuardedApi, assertGuarded } from '../guard/types';


export type Method = 'GET' | 'POST' | 'PUT' | 'PATCH' | 'DELETE';

/** One request through the guarded context; returns the answer whatever its status. */
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

export const isOk = (s: ApiAnswer): boolean => s.status >= 200 && s.status < 300;

export function errorTexts(s: ApiAnswer): string[] {
    if (Array.isArray(s.json)) return s.json.map(String);
    if (s.json && typeof s.json === 'object' && typeof s.json.message === 'string') return [s.json.message];
    return s.text ? [s.text] : [];
}

export function errorShapeOf(s: ApiAnswer): 'array' | 'message' | 'other' {
    if (Array.isArray(s.json) && s.json.every((x) => typeof x === 'string')) return 'array';
    if (s.json && typeof s.json === 'object' && !Array.isArray(s.json) && typeof s.json.message === 'string') return 'message';
    return 'other';
}
