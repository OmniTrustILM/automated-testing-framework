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
    secrets?: readonly string[];
}

export function secretForms(secret: string): string[] {
    const shellInner = secret.replace(/'/g, `'\\''`);
    return [secret, `'${shellInner}'`, shellInner, JSON.stringify(secret).slice(1, -1)];
}

export function scrubSecrets(text: string, secrets: readonly (string | undefined)[] = []): string {
    const forms = [...new Set(secrets.filter((x): x is string => !!x).flatMap(secretForms))].filter((f) => f.length > 0).sort((a, b) => b.length - a.length);
    return forms.reduce((t, f) => t.split(f).join('<secret>'), text);
}

function trySet(obj: object, key: string, value: unknown): boolean {
    try {
        (obj as Record<string, unknown>)[key] = value;
        return (obj as Record<string, unknown>)[key] === value;
    } catch {
        return false;
    }
}

export function scrubError<E>(e: E, secrets: readonly (string | undefined)[], seen: Set<unknown> = new Set()): E {
    try {
        if (typeof e === 'string') return scrubSecrets(e, secrets) as unknown as E;
        if (!e || typeof e !== 'object' || seen.has(e)) return e;
        seen.add(e);
        if (e instanceof Error) {
            const message = scrubSecrets(String(e.message), secrets);
            const stack = e.stack === undefined ? undefined : scrubSecrets(String(e.stack), secrets);
            const holder = e as { cause?: unknown };
            const hasCause = 'cause' in holder;
            const cause = hasCause ? scrubError(holder.cause, secrets, seen) : undefined;
            const errors = e instanceof AggregateError ? e.errors.map((inner) => scrubError(inner, secrets, seen)) : undefined;
            const updated = trySet(e, 'message', message) && (stack === undefined || trySet(e, 'stack', stack))
                && (!hasCause || trySet(e, 'cause', cause)) && (errors === undefined || trySet(e, 'errors', errors));
            if (updated) return e;
            const rebuilt = errors ? new AggregateError(errors, message, hasCause ? { cause } : undefined) : new Error(message, hasCause ? { cause } : undefined);
            rebuilt.name = scrubSecrets(String(e.name), secrets);
            if (stack !== undefined) trySet(rebuilt, 'stack', stack);
            return rebuilt as unknown as E;
        }
        if (Array.isArray(e)) {
            e.forEach((v, i) => { trySet(e, String(i), scrubError(v, secrets, seen)); });
            return e;
        }
        if (Object.getPrototypeOf(e) === Object.prototype) {
            for (const k of Object.keys(e)) trySet(e, k, scrubError((e as Record<string, unknown>)[k], secrets, seen));
        }
        return e;
    } catch {
        // Never throw out of the scrubber: a value it cannot even read is replaced by a plain, scrubbed error.
        return new Error('an error the block could not read safely (it may have carried a secret)') as unknown as E;
    }
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
    readonly secrets: readonly string[];

    constructor(api: GuardedApi, options: AdminOptions) {
        this.api = assertGuarded(api, options.guardLabel);
        this.logger = new Logger(options.loggerName);
        this.secrets = options.secrets ?? [];
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
            this.logger.warn(`${failure.message}; answer: ${scrubSecrets(text, this.secrets).slice(0, 600)}`);
            throw failure;
        }
        let body: unknown;
        try {
            body = text ? JSON.parse(text) : undefined;
        } catch {
            this.logger.warn(`${method} ${pathPattern(path)}: the answer is not JSON: ${scrubSecrets(text, this.secrets).slice(0, 300)}`);
            // A write that succeeded may have made something: a body that cannot be read fails the setup instead of passing as a tier gap.
            const Failure = method === 'GET' ? TierError : SetupError;
            throw new Failure(`${method} ${pathPattern(path)} answered a body that is not JSON`);
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
