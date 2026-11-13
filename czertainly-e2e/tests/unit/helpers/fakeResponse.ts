/**
 * fakeResponse — a Playwright response built from an `ApiAnswer`, for the fake request contexts of the unit tests.
 * `fakeResponse({ status, body })` returns the members the helpers read (`status`, `ok`, `headers`, `json`, `text`) from
 * a complete `ApiAnswer` made by `fakeAnswer`.
 */
import type { APIResponse } from '@playwright/test';
import { fakeAnswer } from './fakeAnswer';
import { partialOf } from './guardRig';

export interface FakeReply {
    status: number;
    body?: unknown;
}

export function fakeResponse(r: FakeReply): APIResponse {
    const answer = fakeAnswer(r.status, JSON.stringify(r.body ?? ''), { json: r.body });
    return partialOf<APIResponse>({
        status: () => answer.status,
        ok: () => answer.status >= 200 && answer.status < 300,
        headers: () => answer.headers,
        json: async () => answer.json,
        text: async () => answer.text,
    });
}
