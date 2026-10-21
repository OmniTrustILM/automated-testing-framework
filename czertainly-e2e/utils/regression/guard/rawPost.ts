import { apiPathOfPathname, hasMethodParam, resolveSentUrl, structuralPathProblem } from './urls';
import { isRawPostRouteAllowed } from './allowLists';
import { OwnObjectViolation } from '../ledger/ownership';

export interface AllowedRawPostOptions {
    env?: NodeJS.ProcessEnv;
    /**
     * The request carries no credentials (the ACME client's global `fetch`: its URLs come from the tier's ACME
     * directory): the origin rule is skipped; every other URL rule holds.
     */
    unauthenticated?: boolean;
}

/**
 * The URL itself when a RAW POST to it is allowed: judged like the guard judges a URL (written form, printable ASCII,
 * the path as written equal to the effective one, unreserved segments, BASE_URL's origin unless `unauthenticated`, no
 * `_method` query parameter), then a read-only or protocol path of the segment-strict allow-list; else
 * OwnObjectViolation (kind `request`).
 */
export function allowedRawPost(url: string, opts: AllowedRawPostOptions = {}): string {
    const r = resolveSentUrl(url, { env: opts.env, anyOrigin: opts.unauthenticated === true });
    const apiPath = 'sent' in r ? apiPathOfPathname(r.sent.effective.pathname) : undefined;
    const problem = 'problem' in r ? r.problem : (structuralPathProblem(r.sent) ??
        (hasMethodParam(r.sent.effective.searchParams) ? 'a _method query parameter (a method override)' : undefined) ??
        (apiPath && isRawPostRouteAllowed(apiPath) ? undefined : 'not a read-only or protocol POST (a create goes through the guarded context, which checks its body)'));
    if (problem) throw new OwnObjectViolation(`allowedRawPost ${apiPath ?? '(outside /api)'}`, {}, problem, undefined, 'request');
    return url;
}

/**
 * The lint's literal-URL check (specLint/rawMutations.ts): a raw POST to `url` would be allowed by `allowedRawPost` (no BASE_URL, so
 * relative URLs only).
 */
export function isAllowedRawPostUrl(url: string): boolean {
    try {
        allowedRawPost(url, { env: {} });
        return true;
    } catch {
        return false;
    }
}
