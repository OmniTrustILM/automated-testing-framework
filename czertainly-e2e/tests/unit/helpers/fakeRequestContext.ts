/**
 * fakeRequestContext — a fake APIRequestContext for the fail-fast waits (waitForCertificateState,
 * waitForDiscoveryCompletion): GET answers come from a script, in order, and the history read has one entry.
 * Shared by certificateUtils.spec.ts and discoveryUtils.spec.ts. No network.
 */
import { APIRequestContext } from '@playwright/test';

export type Answer = { status: number; body?: unknown };

/** A fake request context: GET answers come from `script` in order (the last one repeats); history has one entry. */
export function fakeRequestContext(script: Answer[]): { api: APIRequestContext; calls: string[] } {
    const calls: string[] = [];
    let i = 0;
    const respond = (a: Answer) => ({
        status: () => a.status,
        ok: () => a.status >= 200 && a.status < 300,
        json: async () => a.body,
        text: async () => JSON.stringify(a.body ?? ''),
    });
    const api = {
        get: async (url: string) => {
            calls.push(url);
            if (url.endsWith('/history')) return respond({ status: 200, body: [{ created: 't1', event: 'Issue', status: 'FAILED', message: 'CA refused' }] });
            const a = script[Math.min(i, script.length - 1)];
            i++;
            return respond(a);
        },
    } as unknown as APIRequestContext;
    return { api, calls };
}
