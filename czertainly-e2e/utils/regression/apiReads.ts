/**
 * apiReads — the one answer type and the JSON reads every area shares.
 *
 * WHAT: the one answer type of the regression helpers (`ApiAnswer`, built by `answerOf`) and the JSON reads every area
 *       shares. `apiJson` is deny by default:
 *       a raw context may GET (BASE_URL's origin only) and send a read-only / protocol POST; any other method, a create
 *       included, needs the guarded context. `apiJsonWithDate` also returns the server clock (`createdAfterOf`) so derived
 *       objects get a server-time bound. Certificate reads: detail, search, the fingerprint lookup.
 * WHY: Every helper that reads an API answer needs the same status, text and parsed body, and the server clock that bounds a derived object; one reader keeps them from drifting apart.
 * HOW: `answerOf` builds the `ApiAnswer`; `apiJson` is deny by default (a raw context may only GET or send a read-only POST, anything else needs the guarded context) and `apiJsonWithDate` adds the server time through `createdAfterOf`.
 *
 *       The clock rule of a derived object (a platform-made key or certificate the teardown may delete): its age is judged
 *       on the SERVER's clock. Where the answer carries no server time, `createdAfterOf` returns `keepingBound()`, a bound
 *       so far ahead that no object made so far is created after it, so the teardown keeps the object (a visible leftover
 *       a person decides) instead of trusting the runner's clock, which may be ahead of or behind the server's.
 */
import { APIRequestContext, APIResponse } from '@playwright/test';
import { Logger } from '../Logger';
import { allowedRawPost } from './guard/rawPost';
import { apiPathOf, assertSameOrigin } from './guard/urls';
import { GuardedApi, isGuardedApi, assertGuarded } from './guard/types';
import { isRawPostRouteAllowed } from './guard/allowLists';
import { createdAfterMarker, keepingBound, serverDate } from './ledger/ledger';
import { pollUntil } from './wait';
import type { JsonObject } from './json';
import { rowsOf } from './json';

const logger = new Logger('apiReads');

/**
 * What one request answered, whatever its status: the one shape every transport of the helpers returns, so one error
 * reader (`messagesOf`, `refused422`, `mentions`) works for every area. `json` is the parsed body (undefined when the
 * body is empty or not JSON) and stays untyped: the call site knows the shape it asked for.
 */
export interface ApiAnswer {
    status: number;
    /** The `content-type` header as sent (empty when absent). */
    contentType: string;
    /** Response headers, lower-case names. */
    headers: Record<string, string>;
    text: string;
    json?: any;
    /** The server's Date header (absent when the proxy strips it). */
    serverAt?: Date;
    /** The runner's clock just before the request was sent; `elapsedMs` is measured from it. Never a `createdAfter`: that comes from the server Date. */
    startedAt: Date;
    elapsedMs: number;
}

/** The answer of a response read now; `startedAt` is `Date.now()` taken just before the request was sent. */
export async function answerOf(res: { status(): number; headers(): Record<string, string>; text(): Promise<string> }, startedAt: number): Promise<ApiAnswer> {
    const text = await res.text();
    let json: unknown;
    try {
        json = text.trim() ? JSON.parse(text) : undefined;
    } catch {
        json = undefined;
    }
    const headers = res.headers();
    return { status: res.status(), contentType: headers['content-type'] ?? '', headers, text, json, serverAt: serverDate(headers), startedAt: new Date(startedAt), elapsedMs: Date.now() - startedAt };
}

type JsonMethod = 'GET' | 'POST' | 'PATCH' | 'PUT' | 'DELETE';

export async function apiJson<T = any>(api: APIRequestContext, method: JsonMethod, url: string, data?: unknown): Promise<T> {
    return (await requestAnswer(api, method, url, data)).json as T;
}

/**
 * apiJson plus the server's clock: the response's Date header and the request's duration, so a create can give its
 * derived objects (`certKey_<CN>`, onboarded certificates) a `createdAfter` from the server, never the runner.
 */
export async function apiJsonWithDate(api: APIRequestContext, method: JsonMethod, url: string, data?: unknown): Promise<ApiAnswer> {
    return requestAnswer(api, method, url, data);
}

/**
 * The `createdAfter` of what a request made: the server clock when the answer carried a Date, else `keepingBound()`
 * (logged; never undefined: a derived object must always get a bound, and without the server's time it is kept).
 */
export function createdAfterOf(answer: Pick<ApiAnswer, 'serverAt' | 'startedAt' | 'elapsedMs'>, what = 'request'): string {
    if (answer.serverAt) return createdAfterMarker(answer.serverAt, answer.elapsedMs);
    logger.warn(`${what}: no Date header on the answer; createdAfter is a bound the teardown keeps (no server time to judge the object's age by)`);
    return keepingBound();
}

/** The one implementation behind apiJson / apiJsonWithDate (module-private: the runtime half of the deny-by-default lint). */
async function requestAnswer(api: APIRequestContext, method: JsonMethod, url: string, data?: unknown): Promise<ApiAnswer> {
    const started = Date.now();
    const payload = data === undefined ? {} : { data };
    let res: APIResponse;
    // Deny by default: a raw context may read and send a read-only / protocol POST; anything else (a create
    // included: the guard checks a create's body) needs the guard. A raw context carries the run's
    // credentials too: its GET goes to BASE_URL's origin only (the guarded context checks this itself).
    if (method === 'GET') res = await api.get(isGuardedApi(api) ? url : assertSameOrigin(url, 'apiJson GET'));
    else if (method === 'POST' && isRawPostRouteAllowed(apiPathOf(url) ?? '')) res = await api.post(allowedRawPost(url), payload);
    else res = await assertGuarded(api, `apiJson ${method}`).fetch(url, { method, ...payload });
    const answer = await answerOf(res, started);
    if (!res.ok()) throw new Error(`${method} ${url} → ${answer.status} ${answer.text.slice(0, 600)}`);
    // a 2xx body that is not JSON is an error here (the lenient parse of answerOf would hide it)
    return { ...answer, json: answer.text ? JSON.parse(answer.text) : undefined };
}

/**
 * A certificate as the inventory answers it (list row or detail): the members the suite reads are typed, anything else
 * stays JSON. `certificateContent` is a detail member (a list row has none).
 */
export interface CertificateDetail extends JsonObject {
    uuid: string;
    state?: string;
    commonName?: string;
    certificateContent: string;
    subjectDn?: string;
    subjectAlternativeNames?: JsonObject;
    raProfile?: { uuid?: string; name?: string };
    ownerUuid?: string;
    owner?: { uuid?: string };
    registration?: { state?: string; failedAttempts?: number; expiresAt?: string };
    certificateRequest?: { content?: string; subjectAlternativeNames?: JsonObject };
    protocolInfo?: { protocol?: string; protocolProfileUuid?: string };
    key?: { uuid?: string };
}

export async function getCertificate(api: APIRequestContext, uuid: string): Promise<CertificateDetail> {
    return apiJson(api, 'GET', `/api/v1/certificates/${uuid}`);
}

export async function searchCertificates(api: APIRequestContext, filters: JsonObject[], itemsPerPage = 50): Promise<CertificateDetail[]> {
    const body = await apiJson<JsonObject>(api, 'POST', '/api/v1/certificates', { itemsPerPage, pageNumber: 1, filters });
    return rowsOf(body.certificates) as CertificateDetail[];
}

/** The inventory search filter for one certificate fingerprint (lowercase hex SHA-256 of the DER). */
export const fingerprintFilter = (fingerprint: string): JsonObject[] => [{ fieldSource: 'property', fieldIdentifier: 'FINGERPRINT', condition: 'EQUALS', value: fingerprint }];

/** The inventory row of a certificate by fingerprint, polled (issuance through the connector may land a moment later); undefined after `timeoutMs`. */
export async function pollCertificateByFingerprint(api: APIRequestContext, fingerprint: string, timeoutMs = 60_000): Promise<JsonObject | undefined> {
    const rows = await pollUntil(() => searchCertificates(api, fingerprintFilter(fingerprint)), (found) => found.length > 0, { timeoutMs, intervalMs: 3000, tolerateErrors: 0, onTimeout: 'return' });
    return rows?.[0];
}

/** A `createdAfter` from the SERVER's clock: the Date header of a read just before an action the UI performs (else `keepingBound()`, logged: no server time means the object is kept). */
export async function serverCreatedAfter(api: GuardedApi): Promise<string> {
    return createdAfterOf(await apiJsonWithDate(api, 'GET', '/api/v1/auth/profile'), 'server clock read');
}
