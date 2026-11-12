/**
 * transport — the admin requests of a block's setup and the two kinds of failure it tells apart.
 *
 * WHAT: `Admin` sends every admin request of a preflight and a provisioner through the GUARDED context (`/api` is
 * prefixed here, callers write `/v1/...`), remembers the server's Date header of the first response after
 * `markProvisioningStart()`, and polls with attempt counts instead of fixed sleeps.
 * - `TierError`: the TIER cannot provide what a step needs (a 404 or 5xx answer, an attribute or profile the connector
 *   does not offer, a wait that runs out). It becomes the summary's `unavailable` reason or a family's entry in
 *   `missingFamilies`, and the setup test passes.
 * - `SetupError`: the setup itself is wrong (401 / 403 on any request: the admin identity is broken; 400 / 422 on a
 *   POST, PUT or PATCH: the setup sent a body core refuses). It propagates, and the setup test fails.
 * WHY: a refused body or a broken identity must never pass green as "this tier lacks the feature"; the development
 * blocks (timestamping, key onboarding) share one transport instead of importing each other's.
 * HOW: GET goes through `api.get`, every other method through `api.fetch` of the guarded context (the guard judges and
 * sends it; on a proven local stack `localStack` lifts the ownership rule and the platform deny-list only). A reason
 * carries the method, the path with every uuid replaced by `{id}` and the status, never the answer's body (it may echo
 * fragments of the request); the body goes to the log only. The logger name and the label the guard check reports
 * are constructor options, so each block's warnings carry its own name.
 */
import type { APIResponse } from '@playwright/test';
import { Logger } from '../../Logger';
import { assertGuarded, GuardedApi } from '../../regression/guard/types';
import { serverDate } from '../../regression/ledger/ledger';
import { pollUntil } from '../../regression/wait';

/** The tier cannot provide what the step needs; the message is the reason the summary or the family carries. */
export class TierError extends Error {
    constructor(message: string) {
        super(message);
        this.name = 'TierError';
    }
}

/** The setup sent something core refuses, or its identity is refused: never a tier verdict. */
export class SetupError extends Error {
    constructor(message: string) {
        super(message);
        this.name = 'SetupError';
    }
}

export type Method = 'GET' | 'POST' | 'PUT' | 'PATCH';

export interface Answer<T> {
    body: T;
    /** The server's Date header of the answer, when it carried one. */
    serverAt?: Date;
}

/** What names a block in the transport's output. */
export interface AdminOptions {
    /** The logger name of the block's setup warnings (for example `TimestampingSetup`). */
    loggerName: string;
    /** The label the guarded-context check reports when the api is not guarded (for example `timestamping setup`). */
    guardLabel: string;
}

const UUID_ANYWHERE = /[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}/g;

/** The path with every uuid replaced by `{id}`: what a reason may name. */
export const pathPattern = (path: string): string => path.replace(UUID_ANYWHERE, '{id}');

/** Which failure a non-2xx answer is (see the file header). */
export function failureOf(method: Method, path: string, status: number): TierError | SetupError {
    const what = `${method} ${pathPattern(path)} answered HTTP ${status}`;
    if (status === 401 || status === 403) return new SetupError(`${what}: the admin identity is refused`);
    if ((status === 400 || status === 422) && method !== 'GET') return new SetupError(`${what}: core refuses the body the setup sent`);
    return new TierError(what);
}

export class Admin {
    private readonly api: GuardedApi;
    private readonly logger: Logger;
    private provisioning = false;
    private firstServerAt?: Date;

    constructor(api: GuardedApi, options: AdminOptions) {
        this.api = assertGuarded(api, options.guardLabel);
        this.logger = new Logger(options.loggerName);
    }

    /** From now on the first answer's Date header is the run's `provisionedAt` (the preflight's reads do not count). */
    markProvisioningStart(): void {
        this.provisioning = true;
    }

    /** The server's clock at the first provisioning answer, when one carried a Date header. */
    provisionedAt(): Date | undefined {
        return this.firstServerAt;
    }

    async request<T = unknown>(method: Method, path: string, data?: unknown): Promise<Answer<T>> {
        const url = `/api${path}`;
        let res: APIResponse;
        if (method === 'GET') res = await this.api.get(url);
        else res = await this.api.fetch(url, { method, ...(data === undefined ? {} : { data }) });
        const text = await res.text();
        const at = serverDate(res.headers());
        if (this.provisioning && !this.firstServerAt && at) this.firstServerAt = at;
        if (!res.ok()) {
            const failure = failureOf(method, path, res.status());
            this.logger.warn(`${failure.message}; answer: ${text.slice(0, 600)}`);
            throw failure;
        }
        let body: unknown;
        try {
            body = text ? JSON.parse(text) : undefined;
        } catch {
            this.logger.warn(`${method} ${pathPattern(path)}: the answer is not JSON: ${text.slice(0, 300)}`);
            throw new TierError(`${method} ${pathPattern(path)} answered a body that is not JSON`);
        }
        return { body: body as T, serverAt: at };
    }

    async get<T = unknown>(path: string): Promise<T> {
        return (await this.request<T>('GET', path)).body;
    }

    /** `list_paginated`: the `.items` of a POST …/list endpoint (1000 per page, no filters). */
    async listItems<T = Record<string, unknown>>(path: string): Promise<T[]> {
        const { body } = await this.request<{ items?: T[] }>('POST', path, { itemsPerPage: 1000, pageNumber: 1, filters: [] });
        return body?.items ?? [];
    }

    /**
     * Reads until `done` or the attempts run out; a failure of a read stops at once (as ilm_curl's die does). Returns
     * the last value; the caller decides what a value that never satisfied `done` means.
     */
    async poll<T>(read: () => Promise<T>, done: (v: T) => boolean, attempts: number, intervalMs: number, what: string): Promise<T> {
        return pollUntil(read, done, { attempts, intervalMs, timeoutMs: Math.max(1, attempts) * Math.max(intervalMs, 1) + 60_000, tolerateErrors: 0, onTimeout: 'return', what });
    }
}
