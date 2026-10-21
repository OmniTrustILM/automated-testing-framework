/**
 * workflowRequests — how the events and discovery helpers talk to the API: one guarded request that hands back the answer
 * whatever its status (`sendJson` → `Sent`), the readers of an error body, and the run-prefixed names of the objects they
 * create (`ownName`). A negative case asserts the answer itself; only the guard's own refusals throw.
 */
import { APIResponse } from '@playwright/test';
import { GuardedApi, assertGuarded } from '../guard/types';
import { runName } from '../ledger/runState';

// ------------------------------------------------------------------ names

let counter = 0;

/** A run-prefixed, repeat-safe name: `<run id>-<suffix>-<ms base36><counter>` ([a-z0-9-] only). */
export function ownName(suffix: string): string {
    counter += 1;
    return runName(`${suffix}-${Date.now().toString(36)}${counter.toString(36)}`);
}

// ------------------------------------------------------------------ sending (status + text, never throwing on 4xx)

export type Method = 'GET' | 'POST' | 'PUT' | 'PATCH' | 'DELETE';

/** The answer of one request as the API sent it (an API shape, not a UI outcome). */
export interface Sent {
    status: number;
    text: string;
    /** The parsed body, or undefined when it is empty or not JSON. */
    json: any;
    headers: Record<string, string>;
}

async function sentOf(res: APIResponse): Promise<Sent> {
    const text = await res.text();
    let json: unknown;
    try {
        json = text ? JSON.parse(text) : undefined;
    } catch {
        json = undefined;
    }
    return { status: res.status(), text, json, headers: res.headers() };
}

/**
 * One request through the guarded context; the answer is returned whatever its status (a negative case asserts it).
 * Only the guard's own refusals throw (`OwnObjectViolation`).
 */
export async function sendJson(api: GuardedApi, method: Method, url: string, data?: unknown): Promise<Sent> {
    const opts = data === undefined ? {} : { data };
    if (method !== 'GET') assertGuarded(api, `sendJson ${method} ${url}`); // a raw context never mutates (deny by default)
    switch (method) {
        case 'GET':
            return sentOf(await api.get(url));
        case 'POST':
            return sentOf(await api.post(url, opts));
        case 'PUT':
            return sentOf(await api.put(url, opts));
        case 'PATCH':
            return sentOf(await api.patch(url, opts));
        case 'DELETE':
            return sentOf(await api.delete(url, opts));
    }
}

/** The status is 2xx (the create contract says 201, the controller answers the DTO with the default 200: both are accepted). */
export const isOk = (s: Sent): boolean => s.status >= 200 && s.status < 300;

/** The messages of an error body: a 422 is a JSON array of strings, 400 / 404 / 409 / 500 are `{message}`. */
export function errorTexts(s: Sent): string[] {
    if (Array.isArray(s.json)) return s.json.map(String);
    if (s.json && typeof s.json === 'object' && typeof s.json.message === 'string') return [s.json.message];
    return s.text ? [s.text] : [];
}

/** The shape of an error body: 'array' (422), 'message' (`{message}`), or 'other'. */
export function errorShapeOf(s: Sent): 'array' | 'message' | 'other' {
    if (Array.isArray(s.json) && s.json.every((x) => typeof x === 'string')) return 'array';
    if (s.json && typeof s.json === 'object' && !Array.isArray(s.json) && typeof s.json.message === 'string') return 'message';
    return 'other';
}
