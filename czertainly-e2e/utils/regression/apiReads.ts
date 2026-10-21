/**
 * apiReads — the JSON transport of the regression helpers and the reads every area shares. `apiJson` is deny by default:
 * a raw context may GET (BASE_URL's origin only) and send a read-only / protocol POST; any other method, a create
 * included, needs the guarded context. `apiJsonWithDate` also returns the server clock (`createdAfterOf`) so derived
 * objects get a server-time bound. Certificate reads: detail, search, the fingerprint lookup.
 */
import { APIRequestContext, APIResponse } from '@playwright/test';
import { Logger } from '../Logger';
import { allowedRawPost } from './guard/rawPost';
import { apiPathOf, assertSameOrigin } from './guard/urls';
import { GuardedApi, isGuardedApi, assertGuarded } from './guard/types';
import { isRawPostRouteAllowed } from './guard/allowLists';
import { createdAfterMarker, serverDate } from './ledger/ledger';
import { pollUntil } from './wait';

const logger = new Logger('apiReads');

type Json = Record<string, any>;

type JsonMethod = 'GET' | 'POST' | 'PATCH' | 'PUT' | 'DELETE';

export async function apiJson<T = any>(api: APIRequestContext, method: JsonMethod, url: string, data?: unknown): Promise<T> {
    return (await requestJson<T>(api, method, url, data)).body;
}

/**
 * apiJson plus the server's clock: the response's Date header and the request's duration, so a create can give its
 * derived objects (`certKey_<CN>`, onboarded certificates) a `createdAfter` from the server, never the runner.
 */
export async function apiJsonWithDate<T = any>(api: APIRequestContext, method: JsonMethod, url: string, data?: unknown): Promise<TimedAnswer<T>> {
    return requestJson<T>(api, method, url, data);
}

export interface TimedAnswer<T> {
    body: T;
    /** The server's Date header (absent when the proxy strips it). */
    serverAt?: Date;
    /** The runner's clock just before the request was sent (the fallback bound). */
    startedAt: Date;
    elapsedMs: number;
}

/**
 * The `createdAfter` of what a request made: the server clock when the answer carried a Date, else the runner's
 * clock just before the request (logged; never undefined: a derived object must always get a bound).
 */
export function createdAfterOf(answer: Pick<TimedAnswer<unknown>, 'serverAt' | 'startedAt' | 'elapsedMs'>, what = 'request'): string {
    if (answer.serverAt) return createdAfterMarker(answer.serverAt, answer.elapsedMs);
    logger.warn(`${what}: no Date header on the answer; createdAfter falls back to the runner clock at the request start`);
    return createdAfterMarker(answer.startedAt, 0);
}

/** The one implementation behind apiJson / apiJsonWithDate (module-private: the runtime half of the deny-by-default lint). */
async function requestJson<T>(api: APIRequestContext, method: JsonMethod, url: string, data?: unknown): Promise<TimedAnswer<T>> {
    const started = Date.now();
    const payload = data === undefined ? {} : { data };
    let res: APIResponse;
    // Deny by default: a raw context may read and send a read-only / protocol POST; anything else (a create
    // included: the guard checks a create's body) needs the guard. A raw context carries the run's
    // credentials too: its GET goes to BASE_URL's origin only (the guarded context checks this itself).
    if (method === 'GET') res = await api.get(isGuardedApi(api) ? url : assertSameOrigin(url, 'apiJson GET'));
    else if (method === 'POST' && isRawPostRouteAllowed(apiPathOf(url) ?? '')) res = await api.post(allowedRawPost(url), payload);
    else res = await assertGuarded(api, `apiJson ${method}`).fetch(url, { method, ...payload });
    const text = await res.text();
    if (!res.ok()) throw new Error(`${method} ${url} → ${res.status()} ${text.slice(0, 600)}`);
    return { body: (text ? JSON.parse(text) : undefined) as T, serverAt: serverDate(res.headers()), startedAt: new Date(started), elapsedMs: Date.now() - started };
}

export async function getCertificate(api: APIRequestContext, uuid: string): Promise<Json> {
    return apiJson(api, 'GET', `/api/v1/certificates/${uuid}`);
}

export async function searchCertificates(api: APIRequestContext, filters: Json[], itemsPerPage = 50): Promise<Json[]> {
    const body = await apiJson<Json>(api, 'POST', '/api/v1/certificates', { itemsPerPage, pageNumber: 1, filters });
    return body.certificates ?? [];
}

/** The inventory search filter for one certificate fingerprint (lowercase hex SHA-256 of the DER). */
export const fingerprintFilter = (fingerprint: string): Json[] => [{ fieldSource: 'property', fieldIdentifier: 'FINGERPRINT', condition: 'EQUALS', value: fingerprint }];

/** The inventory row of a certificate by fingerprint, polled (issuance through the connector may land a moment later); undefined after `timeoutMs`. */
export async function findCertificateByFingerprint(api: APIRequestContext, fingerprint: string, timeoutMs = 60_000): Promise<Json | undefined> {
    const rows = await pollUntil(() => searchCertificates(api, fingerprintFilter(fingerprint)), (found) => found.length > 0, { timeoutMs, intervalMs: 3000, tolerateErrors: 0, onTimeout: 'return' });
    return rows?.[0];
}

/** A `createdAfter` from the SERVER's clock: the Date header of a read just before an action the UI performs (else the runner clock, logged). */
export async function serverCreatedAfter(api: GuardedApi): Promise<string> {
    return createdAfterOf(await apiJsonWithDate(api, 'GET', '/api/v1/auth/profile'), 'server clock read');
}
