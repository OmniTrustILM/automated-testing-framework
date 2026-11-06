import { apiPathOfPathname, hasMethodParam, resolveSentUrl, structuralPathProblem } from './urls';
import { isRawPostRouteAllowed } from './allowLists';
import { OwnObjectViolation } from '../ledger/ownership';

export interface AllowedRawPostOptions {
    env?: NodeJS.ProcessEnv;
    /** The request carries no credentials (the ACME client's `fetch`): the origin rule is skipped. */
    unauthenticated?: boolean;
}

/** The URL when a raw POST to it is allowed (judged like a guarded URL, then a read-only or protocol path); else an OwnObjectViolation. */
export function allowedRawPost(url: string, opts: AllowedRawPostOptions = {}): string {
    const r = resolveSentUrl(url, { env: opts.env, anyOrigin: opts.unauthenticated === true });
    const apiPath = 'sent' in r ? apiPathOfPathname(r.sent.effective.pathname) : undefined;
    const problem = 'problem' in r ? r.problem : (structuralPathProblem(r.sent) ??
        (hasMethodParam(r.sent.effective.searchParams) ? 'a _method query parameter (a method override)' : undefined) ??
        (apiPath && isRawPostRouteAllowed(apiPath) ? undefined : 'not a read-only or protocol POST (a create goes through the guarded context, which checks its body)'));
    if (problem) throw new OwnObjectViolation(`allowedRawPost ${apiPath ?? '(outside /api)'}`, {}, problem, undefined, 'request');
    return url;
}

/** The lint's literal-URL check: would `allowedRawPost` allow a raw POST to this relative `url`. */
export function isAllowedRawPostUrl(url: string): boolean {
    try {
        allowedRawPost(url, { env: {} });
        return true;
    } catch {
        return false;
    }
}
