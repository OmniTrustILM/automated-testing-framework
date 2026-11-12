/**
 * fakeRequestContext — a fake APIRequestContext for the fail-fast waits (waitForCertificateState, waitForDiscoveryCompletion).
 *
 * WHAT: `fakeRequestContext(script)` answers GET from a script, in order (the last answer repeats), answers the history read
 * with one failed entry and records every URL it was asked.
 * WHY: the waits poll an object until it reaches a state or fails; their unit tests need a controlled sequence of answers.
 * HOW: no network; the responses are built by `fakeResponse` from the scripted answers.
 */
import { APIRequestContext } from '@playwright/test';
import { fakeResponse } from './fakeResponse';
import { partialOf } from './guardRig';

export type Answer = { status: number; body?: unknown };

/** A fake request context: GET answers come from `script` in order (the last one repeats); history has one entry. */
export function fakeRequestContext(script: Answer[]): { api: APIRequestContext; calls: string[] } {
    const calls: string[] = [];
    let i = 0;
    const respond = (a: Answer) => fakeResponse(a);
    const api = partialOf<APIRequestContext>({
        get: async (url: string) => {
            calls.push(url);
            if (url.endsWith('/history')) return respond({ status: 200, body: [{ created: 't1', event: 'Issue', status: 'FAILED', message: 'CA refused' }] });
            const a = script[Math.min(i, script.length - 1)];
            i++;
            return respond(a);
        },
    });
    return { api, calls };
}
