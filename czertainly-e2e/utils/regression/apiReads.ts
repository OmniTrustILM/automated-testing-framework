/**
 * apiReads — the one answer type and the JSON reads every area shares. `apiJson` is deny by default: a raw context may GET
 * (BASE_URL's origin only) or send a read-only / protocol POST; anything else needs the guarded context.
 * A derived object is aged on the SERVER's clock; without a server time
 * `createdAfterOf` returns a far-future bound so the teardown keeps it.
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

const logger = new Logger('ApiReads');

/**
 * What one request answered, whatever its status: one shape for every transport so one error reader works for every area. `json` is untyped
 * (undefined when the body is empty or not JSON).
 */
export interface ApiAnswer {
    status: number;
    contentType: string;
    headers: Record<string, string>;
    text: string;
    json?: any;
    serverAt?: Date;
    /** The runner's clock just before the request was sent (`elapsedMs` is measured from it); never a `createdAfter`. */
    startedAt: Date;
    elapsedMs: number;
}

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
 * apiJson plus the server's clock (the response's Date header, the request's
 * duration), so derived objects get a `createdAfter` from the server.
 */
export async function apiJsonWithDate(api: APIRequestContext, method: JsonMethod, url: string, data?: unknown): Promise<ApiAnswer> {
    return requestAnswer(api, method, url, data);
}

/** The `createdAfter` of what a request made: the server clock when the answer had a Date, else `keepingBound()` (logged). */
export function createdAfterOf(answer: Pick<ApiAnswer, 'serverAt' | 'startedAt' | 'elapsedMs'>, what = 'request'): string {
    if (answer.serverAt) return createdAfterMarker(answer.serverAt, answer.elapsedMs);
    logger.warn(`${what}: no Date header on the answer; createdAfter is a bound the teardown keeps (no server time to judge the object's age by)`);
    return keepingBound();
}

async function requestAnswer(api: APIRequestContext, method: JsonMethod, url: string, data?: unknown): Promise<ApiAnswer> {
    const started = Date.now();
    const payload = data === undefined ? {} : { data };
    let res: APIResponse;
    // Deny by default: a raw GET goes to BASE_URL's origin only (it carries the run's credentials); anything but a read / protocol POST
    // needs the guard.
    if (method === 'GET') res = await api.get(isGuardedApi(api) ? url : assertSameOrigin(url, 'apiJson GET'));
    else if (method === 'POST' && isRawPostRouteAllowed(apiPathOf(url) ?? '')) res = await api.post(allowedRawPost(url), payload);
    else res = await assertGuarded(api, `apiJson ${method}`).fetch(url, { method, ...payload });
    const answer = await answerOf(res, started);
    if (!res.ok()) throw new Error(`${method} ${url} → ${answer.status} ${answer.text.slice(0, 600)}`);
    return { ...answer, json: answer.text ? JSON.parse(answer.text) : undefined };
}

/** A certificate as the inventory answers it (list row or detail): the members the suite reads are typed. */
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

export const fingerprintFilter = (fingerprint: string): JsonObject[] => [{ fieldSource: 'property', fieldIdentifier: 'FINGERPRINT', condition: 'EQUALS', value: fingerprint }];

/** The inventory row of a certificate by fingerprint, polled until `timeoutMs`; undefined after it. */
export async function pollCertificateByFingerprint(api: APIRequestContext, fingerprint: string, timeoutMs = 60_000): Promise<JsonObject | undefined> {
    const rows = await pollUntil(() => searchCertificates(api, fingerprintFilter(fingerprint)), (found) => found.length > 0, { timeoutMs, intervalMs: 3000, tolerateErrors: 0, onTimeout: 'return' });
    return rows?.[0];
}

/** A `createdAfter` from the SERVER's clock: the Date header of a read just before a UI action (else `keepingBound()`). */
export async function serverCreatedAfter(api: GuardedApi): Promise<string> {
    return createdAfterOf(await apiJsonWithDate(api, 'GET', '/api/v1/auth/profile'), 'server clock read');
}
