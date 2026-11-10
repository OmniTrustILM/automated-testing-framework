/**
 * errorContract — the shape of an ILM core error body and the one refusal check: a 422 is a JSON array of non-empty
 * strings, every other core error an object with exactly one string `message`. An API negative asserts the status AND this shape.
 */

import { expect } from '@playwright/test';

export type ErrorShape =
    | { kind: 'messages'; messages: string[] }
    | { kind: 'message'; message: string }
    | { kind: 'empty' }
    | { kind: 'other'; why: string };

export function errorShape(text: string): ErrorShape {
    if (!text || !text.trim()) return { kind: 'empty' };
    let body: unknown;
    try {
        body = JSON.parse(text);
    } catch {
        return { kind: 'other', why: 'not JSON' };
    }
    if (Array.isArray(body)) {
        if (body.length && body.every((x) => typeof x === 'string' && x.trim().length > 0)) return { kind: 'messages', messages: body as string[] };
        return { kind: 'other', why: 'an array that is empty or holds something other than non-empty strings' };
    }
    if (body && typeof body === 'object') {
        const keys = Object.keys(body as object);
        const message = (body as { message?: unknown }).message;
        if (keys.length === 1 && keys[0] === 'message' && typeof message === 'string') return { kind: 'message', message };
        return { kind: 'other', why: `an object with keys [${keys.join(', ')}]` };
    }
    return { kind: 'other', why: `a JSON ${typeof body}` };
}

export function expect422Messages(text: string): string[] {
    const s = errorShape(text);
    if (s.kind !== 'messages') throw new Error(`a 422 body must be a JSON array of non-empty strings; got ${s.kind === 'other' ? s.why : s.kind}`);
    return s.messages;
}

export function expectMessageObject(text: string): string {
    const s = errorShape(text);
    if (s.kind !== 'message') throw new Error(`an error body must be {"message": "<text>"} and nothing else; got ${s.kind === 'other' ? s.why : s.kind}`);
    return s.message;
}

export interface RefusedAnswer {
    status: number;
    text: string;
    contentType: string;
}

/**
 * Words an error body must never carry (stack frame, exception class, source file, servlet error page, database state,
 * framework package), each with its reason; more specific reasons come first. A body is raw JSON text, so escaped line
 * breaks (`\torg.hibernate`) sit against the next word: a word starts at `\b` or after such an escape.
 */
const LEAK_RULES: ReadonlyArray<{ word: RegExp; reason: string }> = [
    { word: /Whitelabel/i, reason: 'the Whitelabel error page' },
    { word: /\n\s+at\s+[\w.$<>]+\(/, reason: 'a stack trace' },
    { word: /\bat\s+[\w.$]+\([\w.]+\.java:\d+\)/, reason: 'a stack trace' },
    { word: /(?:\b|(?<=\\[nrt]))at [a-z]+\.[A-Za-z.]+\(/, reason: 'a stack trace' },
    { word: /(?:\b|(?<=\\[nrt]))at com\.\w+/, reason: 'a stack trace' },
    { word: /\b[a-z][\w]*(?:\.[a-z][\w]*)+\.[A-Z]\w*(?:Exception|Error)\b/, reason: 'a Java exception class' },
    { word: /\.java:\d+/, reason: 'a source file reference' },
    { word: /Exception\b/, reason: 'an exception name' },
    { word: /SQLState/i, reason: 'an SQL state' },
    { word: /(?:\b|(?<=\\[nrt]))org\.(spring|hibernate|postgresql)/, reason: 'a framework package' },
];

export const INTERNAL_LEAK_WORDS: readonly RegExp[] = LEAK_RULES.map((r) => r.word);

export const internalLeaks = (text: string): string[] => INTERNAL_LEAK_WORDS.filter((re) => re.test(text)).map(String);

export const leakReason = (text: string): string | undefined => LEAK_RULES.find((r) => r.word.test(text))?.reason;

export interface RefusedRule {
    status: number;
    /**
     * What the message says: a string = exactly `[text]`; a regular expression = exactly one message that matches (anchor it for a whole
     * match); left out = the shape only.
     */
    text?: string | RegExp;
    among?: boolean;
    prefix?: boolean;
    what?: string;
    /** Opt out of the `application/json` content type check, with the reason (a non-empty string). */
    contentTypeNotChecked?: string;
}

/**
 * The refusal rule of the suite: status, JSON content type, the error shape of that status, the messages `text` and the flags ask for, and
 * no leaked stack trace, class name or SQL state. Returns the messages.
 */
export function expectRefused(answer: RefusedAnswer, rule: RefusedRule): string[] {
    const label = rule.what ? `${rule.what}: ` : '';
    if (rule.contentTypeNotChecked !== undefined && rule.contentTypeNotChecked.trim() === '') throw new Error('expectRefused: contentTypeNotChecked needs the reason as text');
    if (rule.prefix && typeof rule.text !== 'string') throw new Error('expectRefused: prefix needs a string text');
    expect(answer.status, `${label}answered ${rule.status}: ${answer.text.slice(0, 300)}`).toBe(rule.status);
    if (rule.contentTypeNotChecked === undefined) expect(answer.contentType, `${label}content type`).toMatch(/application\/json/);
    const messages = rule.status === 422 ? expect422Messages(answer.text) : [expectMessageObject(answer.text)];
    if (rule.text !== undefined) {
        const wanted = rule.text;
        const says = (m: string): boolean => (typeof wanted === 'string' ? (rule.prefix ? m.startsWith(wanted) : m === wanted) : wanted.test(m));
        if (rule.among) {
            expect(messages.some(says), `${label}a message ${rule.prefix ? 'starts with' : typeof wanted === 'string' ? 'equals' : 'matches'} ${String(wanted)} among ${JSON.stringify(messages)}`).toBe(true);
        } else {
            expect(messages, `${label}exactly one message`).toHaveLength(1);
            expect(says(messages[0]), `${label}the message ${rule.prefix ? 'starts with' : typeof wanted === 'string' ? 'equals' : 'matches'} ${String(wanted)}: ${JSON.stringify(messages[0])}`).toBe(true);
        }
    }
    expect(internalLeaks(answer.text), `${label}the refusal leaks no stack trace, class name or SQL state`).toEqual([]);
    return messages;
}

export interface RefusedMethodAnswer {
    status: number;
    headers: Record<string, string>;
    bodyText: string;
}

export const INGRESS_SKIP_MESSAGE = 'refused by the ingress before core (its firewall allow list)';

const PROXY_SERVER = /\b(nginx|envoy|haproxy|traefik|istio|cloudflare|openresty|awselb|varnish|squid|caddy|kong|akamai|bigip|netscaler)\b/i;

export type RefusedMethodResult =
    | { outcome: 'skip'; why: string }
    | { outcome: 'judged'; answeredBy: string; problems: string[] };

/**
 * Judge the answer to TRACE: refused with 405 by whoever answers (an nginx-based gateway refuses TRACE itself; core answers 405 with an
 * `Allow` header since core#2502). A 2xx or a 5xx is a problem from anyone; another answer is the gateway's (a proxy `Server` header or a
 * non-JSON body: skip) or core's (a problem). Only numbers and the proxy's name go into a verdict, never the body.
 */
export function checkRefusedMethod(answer: RefusedMethodAnswer): RefusedMethodResult {
    const proxy = PROXY_SERVER.exec(answer.headers.server ?? '')?.[1].toLowerCase();
    const bytes = Buffer.byteLength(answer.bodyText.trim());
    const answeredBy = proxy ? `a proxy (${proxy})` : bytes > 0 && !isJson(answer.bodyText) ? `a gateway (non-JSON body, ${bytes} bytes)` : 'core';
    if (answer.status === 405) {
        const problems = answeredBy === 'core' && !answer.headers.allow ? ['405 without an Allow header'] : [];
        return { outcome: 'judged', answeredBy, problems };
    }
    if (answer.status < 300) return { outcome: 'judged', answeredBy, problems: [`status ${answer.status}: the method was accepted`] };
    if (answeredBy !== 'core' && answer.status < 500) return { outcome: 'skip', why: `${answeredBy} answered ${answer.status}` };
    return { outcome: 'judged', answeredBy, problems: [`status ${answer.status}, expected 405`] };
}

function isJson(text: string): boolean {
    try {
        JSON.parse(text);
        return true;
    } catch {
        return false;
    }
}
