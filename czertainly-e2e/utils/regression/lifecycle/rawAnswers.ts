/**
 * rawAnswers — one guarded request whose answer is read without throwing (`sendRaw`: status, text, parsed JSON, the
 * server Date), and the readers of its error body: a 422 string array, a 400 / 404 `{message}`, the words an error
 * body must never carry. Negatives assert status AND body shape through these.
 */
import { errorShape } from '../errorContract';
import { GuardedApi, assertGuarded } from '../guard/types';
import { createdAfterMarker, serverDate } from '../ledger/ledger';

// ------------------------------------------------------------------ raw answers (negatives assert status + shape)

export interface RawAnswer {
    status: number;
    text: string;
    /** Parsed JSON body, when the body parses. */
    json?: unknown;
    /** The server's clock (Date header) and the request's duration: a `createdAfter` for derived objects. */
    serverAt?: Date;
    /** The runner clock when the request started (the fallback bound when the answer carries no Date header). */
    startedAt: Date;
    elapsedMs: number;
}

export interface RawOptions {
    headers?: Record<string, string>;
    /** Another identity than the run's (401 negatives): an identity header needs the guard's switch. */
    identityOverride?: boolean;
}

/**
 * One guarded request whose answer is read without throwing: status, text, parsed JSON when the body parses, the server
 * Date. A Buffer body is sent as written (a malformed-JSON negative); an object is sent as JSON.
 */
export async function sendRaw(api: GuardedApi, method: 'GET' | 'POST' | 'PATCH' | 'PUT' | 'DELETE', url: string, data?: unknown, opts: RawOptions = {}): Promise<RawAnswer> {
    const started = Date.now();
    const options: Record<string, unknown> = { method };
    if (data !== undefined) options.data = data;
    if (opts.headers) options.headers = opts.headers;
    if (opts.identityOverride) options.identityOverride = true;
    const res = await assertGuarded(api, `lifecycle.sendRaw ${method}`).fetch(url, options);
    const text = await res.text();
    let json: unknown;
    try {
        json = text ? JSON.parse(text) : undefined;
    } catch {
        json = undefined;
    }
    return { status: res.status(), text, json, serverAt: serverDate(res.headers()), startedAt: new Date(started), elapsedMs: Date.now() - started };
}

/** A `createdAfter` from a raw answer's server Date (undefined without one). */
export const createdAfterOfAnswer = (a: RawAnswer): string | undefined => (a.serverAt ? createdAfterMarker(a.serverAt, a.elapsedMs) : undefined);

/** The 422 body as its string list, or a problem text (the caller's assertion names it). */
export function messagesOf(a: RawAnswer): string[] {
    const s = errorShape(a.text);
    if (s.kind !== 'messages') throw new Error(`a 422 body must be a JSON array of non-empty strings; got ${s.kind === 'other' ? s.why : s.kind}: ${a.text.slice(0, 300)}`);
    return s.messages;
}

/** The `{message}` body's text, or a problem text. */
export function messageOf(a: RawAnswer): string {
    const s = errorShape(a.text);
    if (s.kind !== 'message') throw new Error(`an error body must be {"message": "<text>"} and nothing else; got ${s.kind === 'other' ? s.why : s.kind}: ${a.text.slice(0, 300)}`);
    return s.message;
}

/** Words an error body must never carry (no stack trace, class name or SQL state leaks). */
export const LEAK_WORDS: readonly RegExp[] = [/\bat com\.\w+/, /Exception\b/, /SQLState/i, /\borg\.(spring|hibernate|postgresql)/];

/** The leak words found in an error body (empty = clean). */
export const leaksIn = (text: string): string[] => LEAK_WORDS.filter((re) => re.test(text)).map(String);
