/**
 * transport — the admin requests of a block's setup, through the GUARDED context, and the two failures it tells apart.
 *   - `TierError`: the tier cannot provide what a step needs; it becomes the summary's `unavailable` reason, and the setup passes.
 *   - `SetupError`: the setup itself is wrong (401 / 403, or 400 / 422 on a write); the setup fails.
 * A broken identity or a refused body must never pass green as "this tier lacks the feature".
 * A reason carries the method, the path with uuids replaced by `{id}` and the status, never the answer's body.
 */
import type { APIResponse } from '@playwright/test';
import { Logger } from '../../Logger';
import { assertGuarded, GuardedApi } from '../../regression/guard/types';
import { serverDate } from '../../regression/ledger/ledger';
import { pollUntil } from '../../regression/wait';

export class TierError extends Error {
    constructor(message: string) {
        super(message);
        this.name = 'TierError';
    }
}

export class SetupError extends Error {
    constructor(message: string) {
        super(message);
        this.name = 'SetupError';
    }
}

export type Method = 'GET' | 'POST' | 'PUT' | 'PATCH';

export interface Answer<T> {
    body: T;
    serverAt?: Date;
}

export interface AdminOptions {
    loggerName: string;
    guardLabel: string;
}

const UUID_ANYWHERE = /[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}/g;

export const pathPattern = (path: string): string => path.replace(UUID_ANYWHERE, '{id}');

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

    markProvisioningStart(): void {
        this.provisioning = true;
    }

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

    async listItems<T = Record<string, unknown>>(path: string): Promise<T[]> {
        const { body } = await this.request<{ items?: T[] }>('POST', path, { itemsPerPage: 1000, pageNumber: 1, filters: [] });
        return body?.items ?? [];
    }

    /** Reads until `done` or the attempts run out; a failed read stops at once. Returns the last value. */
    async poll<T>(read: () => Promise<T>, done: (v: T) => boolean, attempts: number, intervalMs: number, what: string): Promise<T> {
        return pollUntil(read, done, { attempts, intervalMs, timeoutMs: Math.max(1, attempts) * Math.max(intervalMs, 1) + 60_000, tolerateErrors: 0, onTimeout: 'return', what });
    }
}
