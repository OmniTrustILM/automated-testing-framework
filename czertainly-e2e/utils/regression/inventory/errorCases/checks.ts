/**
 * checks — the oracle of the error contract for refused requests.
 *
 * Returns one list of problems per request: the expected status, the 422 messages or the single `message`, the body
 * shape, the leak scan (stack frames, exception classes, packages, SQL, file paths) and the echo of a token or a marker.
 * A refusal can be correct in status and still leak one of these.
 */

// ------------------------------------------------------------------ the oracle vocabulary

export type Oracle = string | RegExp;
const oracleMatches = (o: Oracle, s: string): boolean => (typeof o === 'string' ? s === o : o.test(s));
const describeOracle = (o: Oracle): string => (typeof o === 'string' ? JSON.stringify(o) : String(o));

/** What a refused request must answer (the error contract of the inventory API and the matrix row). */
export interface Expectation {
    /** One status, the accepted family (a shape-only row, a pinned row), or any `'4xx'` (never a server error). */
    status: number | readonly number[] | '4xx';
    /** A 422 body: the messages, in order (a string is exact, a RegExp is matched). Omitted: shape only. */
    messages?: readonly Oracle[];
    /** Any other error body: the single `message`. Omitted: shape only. */
    message?: Oracle;
    /** The body must be empty (a refused method answers 400 with no body; a 401). */
    empty?: boolean;
    /** Extra checks on the parsed answer (the set of conditions a 422 lists, a search page, …); returns problems. */
    extra?: (p: { status: number; text: string; json: unknown }) => string[];
}

export interface Answer {
    status: number;
    contentType: string;
    text: string;
    headers?: Record<string, string>;
    json?: unknown;
}

export const JSON_TYPE = /application\/json/i;

/** Whether `got` is what the expectation accepts. */
export function statusOk(want: Expectation['status'], got: number): boolean {
    if (want === '4xx') return got >= 400 && got < 500;
    return typeof want === 'number' ? want === got : want.includes(got);
}
const describeStatus = (want: Expectation['status']): string => (want === '4xx' ? 'a 4xx' : typeof want === 'number' ? String(want) : want.join(' or '));
export const preview = (text: string): string => JSON.stringify(text.length > 160 ? `${text.slice(0, 160)}…` : text);

/** Parsed body, or undefined when empty or not JSON. */
export function parsed(text: string): unknown {
    try {
        return text ? JSON.parse(text) : undefined;
    } catch {
        return undefined;
    }
}

/** The shape of an error body (the error contract): a 422 is an array of non-empty strings, any other 4xx / 5xx `{message}`. */
export function shapeProblems(status: number, contentType: string, text: string): string[] {
    const out: string[] = [];
    const body = parsed(text);
    if (status === 422) {
        const ok = Array.isArray(body) && body.length > 0 && body.every((x) => typeof x === 'string' && x.trim().length > 0);
        if (!ok) out.push(`a 422 body must be a JSON array of non-empty strings; got ${preview(text)}`);
    } else {
        const keys = body && typeof body === 'object' && !Array.isArray(body) ? Object.keys(body as object) : [];
        const ok = keys.length === 1 && keys[0] === 'message' && typeof (body as { message?: unknown }).message === 'string';
        if (!ok) out.push(`a ${status} body must be {"message": "<text>"} and nothing else; got ${preview(text)}`);
    }
    if (!JSON_TYPE.test(contentType)) out.push(`a ${status} body must be application/json; got content-type ${JSON.stringify(contentType)}`);
    return out;
}

/**
 * Judges one answer against its expectation: status, body shape, the messages / message, an empty body, the leak scan
 * of the body (and of the WWW-Authenticate header), and the echo of any secret or marker the request carried.
 */
export function checkResponse(e: Expectation, a: Answer, echo: readonly string[] = []): string[] {
    const problems: string[] = [];
    if (!statusOk(e.status, a.status)) problems.push(`status ${a.status}, expected ${describeStatus(e.status)}: ${preview(a.text)}`);
    const isError = a.status >= 400;
    if (e.empty) {
        if (a.text.trim() !== '') problems.push(`the body must be empty; got ${preview(a.text)}`);
    } else if (isError && a.status !== 401 && a.status !== 403) {
        const shape = shapeProblems(a.status, a.contentType, a.text);
        problems.push(...shape);
        if (!shape.length) {
            const body = parsed(a.text);
            if (a.status === 422 && e.messages) {
                const got = body as string[];
                if (got.length !== e.messages.length) problems.push(`expected ${e.messages.length} message(s), got ${got.length}: ${preview(a.text)}`);
                else e.messages.forEach((o, i) => { if (!oracleMatches(o, got[i])) problems.push(`message ${i + 1} is ${JSON.stringify(got[i])}, expected ${describeOracle(o)}`); });
            } else if (a.status !== 422 && e.message !== undefined) {
                const got = (body as { message: string }).message;
                if (!oracleMatches(e.message, got)) problems.push(`message is ${JSON.stringify(got)}, expected ${describeOracle(e.message)}`);
            }
        }
    }
    if (e.extra) problems.push(...e.extra({ status: a.status, text: a.text, json: a.json ?? parsed(a.text) }));
    const surface = [a.text, a.headers?.['www-authenticate'] ?? ''].join('\n');
    for (const l of findLeaks(surface)) problems.push(`the answer leaks internals (${l.kind}): ${JSON.stringify(l.sample)}`);
    for (const secret of echo) if (secret && surface.includes(secret)) problems.push(`the answer echoes ${JSON.stringify(secret.length > 24 ? `${secret.slice(0, 24)}…` : secret)}`);
    return problems;
}

// ------------------------------------------------------------------ the leak scanner

type LeakKind = 'stack-trace' | 'exception-class' | 'package' | 'sql' | 'file-path';
export interface Leak {
    kind: LeakKind;
    sample: string;
}

/**
 * The JDK types Spring's type-mismatch text names (`Failed to convert value of type 'java.lang.String' to required type 'java.util.UUID'`).
 */
const JDK_TYPE = /\bjava\.(?:lang|util|time|math|net)\.[A-Z][\w$]*/g;

const PATTERNS: ReadonlyArray<{ kind: LeakKind; re: RegExp }> = [
    { kind: 'stack-trace', re: /\bat\s+[\w$.]+\([\w$]+\.(?:java|kt|groovy|scala):\d+\)/ },
    { kind: 'stack-trace', re: /\bCaused by:\s*[\w$.]+/ },
    { kind: 'stack-trace', re: /\b[\w$]+\.(?:java|kt|groovy):\d+\b/ },
    // Class names ending in Exception / Error: ConstraintViolationException, NullPointerException, PSQLException (never the bare word).
    { kind: 'exception-class', re: /\b[A-Za-z][A-Za-z0-9]+(?:Exception|Error)\b/ },
    // Application, framework and library packages (a JDK type of the documented type-mismatch sentence is stripped first).
    { kind: 'package', re: /\b(?:com|org|io|net|jakarta|javax|jdk|sun|reactor|ch|de)\.(?:otilm|czertainly|springframework|hibernate|postgresql|apache|fasterxml|swagger|bouncycastle|zaxxer|netty|sql|io|security|persistence|validation|servlet|tomcat|catalina|slf4j|logging|opentelemetry)\b[\w.$]*/ },
    { kind: 'package', re: /\bjava\.(?:sql|io|nio|security|net\.http)\b[\w.$]*/ },
    { kind: 'package', re: /(?:^|[\s'"(\[@])(?:[a-z][a-z0-9]*\.){3,}[A-Z][\w$]*/ },
    { kind: 'sql', re: /\bselect\b[^\n]{1,200}\bfrom\b/i },
    { kind: 'sql', re: /\b(?:insert\s+into|delete\s+from|update\s+\w+\s+set)\b/i },
    { kind: 'sql', re: /\b(?:violates (?:unique|foreign key|not-null|check) constraint|could not execute statement|SQLSTATE|duplicate key value)\b/i },
    { kind: 'file-path', re: /(?:^|[\s'"(=:])\/(?:home|opt|usr|var|etc|app|tmp|root|srv|Users|workspace|build)\/[\w.\-/]+/ },
    { kind: 'file-path', re: /\b[A-Za-z]:\\[\w.\-\\]+/ },
    { kind: 'file-path', re: /\b[\w-]+\.(?:java|kt|xml|properties|yml|yaml|jar|class)\b/ },
];

/** What an error body must never show: stack frames, class and package names, SQL, file paths. */
export function findLeaks(text: string): Leak[] {
    const scan = text.replace(JDK_TYPE, 'JDKTYPE');
    const found: Leak[] = [];
    for (const { kind, re } of PATTERNS) {
        const m = re.exec(scan);
        if (m) found.push({ kind, sample: m[0].trim().slice(0, 80) });
    }
    return found;
}

/** True when `secret` (a token, a password, a marker) appears in `text`. */
export const findEchoedInput = (text: string, secret: string): boolean => secret.length > 0 && text.includes(secret);
