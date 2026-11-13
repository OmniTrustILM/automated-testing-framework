/**
 * sendRequest — checks a snapshot and sends it, and nothing else; the only way out of the guard (the raw send is private).
 * Redirect hops of a GET are judged by the URL rules and not followed when one refuses.
 */
import { hasMethodParam, pathCharProblem, rawPathOf, readApiPath, readPathProblem, resolveSentUrl } from './urls';
import { REDIRECTS } from './headers';
import { checkRequest } from './checkRequest';
import { sideEffectGet } from './routes';
import type { GuardState } from './guardState';
import type { Snapshot } from './readRequest';
import type { APIRequestContext, APIResponse } from '@playwright/test';

const buildSentOptions = (s: Snapshot): Record<string, unknown> => ({
    ...(s.params !== undefined ? { params: s.params } : {}),
    ...(s.headers !== undefined ? { headers: s.headers } : {}),
    ...(s.body.send !== undefined ? { data: s.body.send } : {}),
    ...s.pass,
    maxRedirects: 0,
});

/** Check the snapshot, then send it. */
export async function checkAndSend(state: GuardState, s: Snapshot): Promise<APIResponse> {
    await checkRequest(state, s);
    return sendJudged(state, s);
}

async function sendJudged(state: GuardState, s: Snapshot): Promise<APIResponse> {
    if (s.method !== 'GET') return state.api.fetch(s.url, { ...buildSentOptions(s), method: s.method } as Parameters<APIRequestContext['fetch']>[1]);
    const res = await state.api.get(s.url, buildSentOptions(s) as Parameters<APIRequestContext['get']>[1]);
    return followRedirects(state, s, res);
}

async function followRedirects(state: GuardState, s: Snapshot, first: APIResponse): Promise<APIResponse> {
    let res = first;
    let current = new URL(s.sent.effective.toString());
    current.search = s.query.toString();
    for (let hop = 0; hop < s.maxRedirects; hop++) {
        if (!REDIRECTS.has(res.status())) break;
        const location = res.headers()['location'];
        if (!location) break;
        let next: URL;
        try {
            next = new URL(location, current);
        } catch {
            break;
        }
        const r = resolveSentUrl(next.toString(), { env: state.env });
        if ('problem' in r) break;
        if (pathCharProblem(rawPathOf(location)) || readPathProblem(r.sent)) break;
        const nextPath = readApiPath(r.sent.effective);
        if (nextPath && sideEffectGet(nextPath)) break;
        if (hasMethodParam(r.sent.effective.searchParams)) break;
        current = next;
        res = await state.api.get(next.toString(), { ...(s.headers !== undefined ? { headers: s.headers } : {}), ...s.pass, maxRedirects: 0 } as Parameters<APIRequestContext['get']>[1]);
    }
    return res;
}
