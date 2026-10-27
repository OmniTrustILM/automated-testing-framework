/**
 * sendRequest — checks a snapshot and sends it, and nothing else.
 *
 * WHAT: `checkAndSend` is the only export: it runs the guard's rules on the snapshot (checkRequest.ts) and, only when
 * they all pass, sends it. `buildSentOptions` turns the snapshot into the plain Playwright options, `sendJudged` sends it, and
 * `followRedirects` follows the same-origin redirects of a GET through the URL and side-effect rules again.
 * WHY: the guard judges what is sent and sends what it judged, so the wire sees only the snapshot's data: never the
 * caller's objects, and always `maxRedirects: 0` because the guard follows redirects itself.
 * HOW: a GET goes through `get`, every other method through `fetch` with the method set; each redirect hop is judged by
 * the URL rules, the structural path rule, the side-effect GET list and the `_method` rule, and is not followed (the
 * 3xx is returned) when any of them says no.
 */
import { hasMethodParam, pathCharProblem, rawPathOf, readApiPath, readPathProblem, resolveSentUrl } from './urls';
import { REDIRECTS } from './headers';
import { checkRequest } from './checkRequest';
import { sideEffectGet } from './routes';
import type { GuardState } from './guardState';
import type { Snapshot } from './readRequest';
import type { APIRequestContext, APIResponse } from '@playwright/test';

/** The Playwright options of a snapshot: plain data only, `maxRedirects: 0` (the guard follows redirects itself). */
const buildSentOptions = (s: Snapshot): Record<string, unknown> => ({
    ...(s.params !== undefined ? { params: s.params } : {}),
    ...(s.headers !== undefined ? { headers: s.headers } : {}),
    ...(s.body.send !== undefined ? { data: s.body.send } : {}),
    ...s.pass,
    maxRedirects: 0,
});

/**
 * Check the snapshot, then send it. This is the only way out of the guard: the raw send below is private to this
 * module, so no code can send a snapshot that was not checked (and the spec lint refuses imports of the guard's inner
 * modules outside the guard).
 */
export async function checkAndSend(state: GuardState, s: Snapshot): Promise<APIResponse> {
    await checkRequest(state, s);
    return sendJudged(state, s);
}

/** Send a judged snapshot; a GET follows same-origin redirects through the URL and side-effect rules. */
async function sendJudged(state: GuardState, s: Snapshot): Promise<APIResponse> {
    if (s.method !== 'GET') return state.api.fetch(s.url, { ...buildSentOptions(s), method: s.method } as Parameters<APIRequestContext['fetch']>[1]);
    const res = await state.api.get(s.url, buildSentOptions(s) as Parameters<APIRequestContext['get']>[1]);
    return followRedirects(state, s, res);
}

/** The hops of a GET: same-origin only, each hop judged by the rules a first request is judged by. */
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
        if ('problem' in r) break; // another origin, user info, not http(s): not followed, the 3xx is returned
        // The hop's path as the Location writes it and as it will be sent, by the shared structural rule.
        if (pathCharProblem(rawPathOf(location)) || readPathProblem(r.sent)) break;
        const nextPath = readApiPath(r.sent.effective);
        if (nextPath && sideEffectGet(nextPath)) break;
        if (hasMethodParam(r.sent.effective.searchParams)) break;
        current = next;
        res = await state.api.get(next.toString(), { ...(s.headers !== undefined ? { headers: s.headers } : {}), ...s.pass, maxRedirects: 0 } as Parameters<APIRequestContext['get']>[1]);
    }
    return res;
}
