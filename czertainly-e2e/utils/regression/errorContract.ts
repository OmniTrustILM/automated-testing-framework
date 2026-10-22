/**
 * errorContract — the shape of an ILM core error body and the one refusal check.
 *
 * WHAT: the shape of an ILM core error body, as one pure reader (REG-USE-07.1, REG-DEP-01.c, the
 *       API-GEN-32 error sentinel; the full battery is API-GEN-01).
 *
 *       The rule (the error contract of the inventory API, ExceptionHandlingAdvice + ErrorMessageDto, unchanged by the Spring 7
 *       migration): a 422 is a JSON ARRAY of non-empty strings; every other core error (400, 404, 409, 500) is an OBJECT
 *       with exactly one string member `message`. An API negative asserts the status AND this shape (spec-authoring hard
 *       rule 8), never the status alone.
 * WHY: An API negative that asserts only the status hides a wrong body; the error contract is one rule and belongs in one reader.
 * HOW: `errorShape` classifies a raw body, `expect422Messages` / `expectMessageObject` / `expectRefused` assert it, and
 *       `checkRefusedMethod` tells core's answer to a refused method from an ingress answer. `expectRefused` is as strict as the strictest
 *       check the specs wrote by hand: JSON content type, the shape of the status, exactly one message and exactly the text. The looser
 *       readings are explicit options (`among`, `prefix`, `contentTypeNotChecked` with its reason). `INTERNAL_LEAK_WORDS` is the one list
 *       of what a body must never carry (a stack frame, an exception class, an SQL state, a framework package); `internalLeaks` reads it.
 */

import { expect } from '@playwright/test';

export type ErrorShape =
    | { kind: 'messages'; messages: string[] }
    | { kind: 'message'; message: string }
    | { kind: 'empty' }
    | { kind: 'other'; why: string };

/** Classify an error body (the raw text of the response). */
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

/** The 422 rule: the body is a JSON array of non-empty strings; returns them, else throws naming the shape. */
export function expect422Messages(text: string): string[] {
    const s = errorShape(text);
    if (s.kind !== 'messages') throw new Error(`a 422 body must be a JSON array of non-empty strings; got ${s.kind === 'other' ? s.why : s.kind}`);
    return s.messages;
}

/** The non-422 rule: the body is `{ "message": "<text>" }` and nothing else; returns the message, else throws. */
export function expectMessageObject(text: string): string {
    const s = errorShape(text);
    if (s.kind !== 'message') throw new Error(`an error body must be {"message": "<text>"} and nothing else; got ${s.kind === 'other' ? s.why : s.kind}`);
    return s.message;
}

// ------------------------------------------------------------------ one refusal, asserted in one place

/** What `expectRefused` needs of an answer: the status, the raw text and the `content-type` header (an `ApiAnswer` has all three). */
export interface RefusedAnswer {
    status: number;
    text: string;
    /** The `content-type` header as sent (empty when absent). */
    contentType: string;
}

/**
 * Words an error body must never carry: a stack frame, an exception class name, a database state or a framework
 * package. The one list of the suite; `internalLeaks` reads it for every caller.
 *
 * A body is raw JSON text, so a stack trace in it has its line breaks and tabs written as `\n`, `\r` and `\t`: the
 * letter of the escape sits right against the next word (`\torg.hibernate`, `\nat com.x`), where a plain word boundary
 * finds none. The start of a word is therefore `(?:\b|(?<=\\[nrt]))`, a word boundary or that escape, so a joined form is
 * caught while a word that merely ends in the same letters (`Georg.springer`) is not.
 */
export const INTERNAL_LEAK_WORDS: readonly RegExp[] = [
    /(?:\b|(?<=\\[nrt]))at [a-z]+\.[A-Za-z.]+\(/,
    /(?:\b|(?<=\\[nrt]))at com\.\w+/,
    /Exception\b/,
    /SQLState/i,
    /(?:\b|(?<=\\[nrt]))org\.(spring|hibernate|postgresql)/,
];

/** The leak words found in an error body, as text (empty = clean). */
export const internalLeaks = (text: string): string[] => INTERNAL_LEAK_WORDS.filter((re) => re.test(text)).map(String);

/** How `expectRefused` reads the messages of the answer. */
export interface RefusedRule {
    status: number;
    /**
     * What the message says. A string: the messages are exactly `[text]` (one message, equal). A regular expression: exactly
     * one message, and it matches as the expression is written (anchor it if the whole message is meant). Left out: the
     * shape only. `among` and `prefix` are the explicit looser readings.
     */
    text?: string | RegExp;
    /** The looser reading: SOME message equals (string) or matches (regular expression); other messages are allowed. */
    among?: boolean;
    /** A string `text` is the START of the message (the rest, such as an object id, varies); with `among`, of some message. */
    prefix?: boolean;
    /** Prefixed to every failure text. */
    what?: string;
    /**
     * Opt out of the `application/json` content type check, with the reason (a non-empty string). Left out, the content
     * type is checked: core answers its refusals as JSON.
     */
    contentTypeNotChecked?: string;
}

/**
 * The refusal rule of the suite: the answer has this `status`, its `content-type` is `application/json`, its body has the
 * error shape of that status (a 422 is a JSON array of messages, any other status is `{ "message": … }`), the messages
 * say what `text` and the flags ask (by default exactly the one message, exactly as written; see `RefusedRule`) and the
 * body leaks no stack trace, class name or SQL state. Returns the messages for a further check.
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

// ------------------------------------------------------------------ the refused-method answer (API-GEN-32[method])

/** What a refused HTTP method (TRACE) answered: the status, the lower-case response headers and the raw body text. */
export interface RefusedMethodAnswer {
    status: number;
    headers: Record<string, string>;
    bodyText: string;
}

/** The skip reason of a sentinel whose answer did not come from core (the ingress / a proxy in front of it refused first). */
export const INGRESS_SKIP_MESSAGE = 'refused by the ingress before core (its firewall allow list)';

/** `Server` header values of the proxies / ingress controllers an ILM tier may sit behind (Tomcat's own value is not among them). */
const PROXY_SERVER = /\b(nginx|envoy|haproxy|traefik|istio|cloudflare|openresty|awselb|varnish|squid|caddy|kong|akamai|bigip|netscaler)\b/i;

export type RefusedMethodResult =
    /** Not core's answer: the test skips with INGRESS_SKIP_MESSAGE; `why` is only a status, a byte count or a proxy name. */
    | { outcome: 'skip'; why: string }
    /** Core's answer: `problems` is empty for the baseline (400, empty body), else says what differs (status, byte count). */
    | { outcome: 'core'; problems: string[] };

/**
 * Judge the answer to a refused method. Whose answer is it? A 405, a `Server` header naming a proxy, or a body that is
 * neither empty nor JSON is the ingress's (core answers a refused method 400 with an empty body on main, 401 on the
 * migrated build, core#2502): skip, so neither a red gate on main nor a masked core#2502 on a migrated build. For core's
 * answer the problems are numbers only — the BODY is never put in a message (a proxy or an error forward could echo the
 * bearer token of the request).
 */
export function checkRefusedMethod(answer: RefusedMethodAnswer): RefusedMethodResult {
    if (answer.status === 405) return { outcome: 'skip', why: 'HTTP 405' };
    const proxy = PROXY_SERVER.exec(answer.headers.server ?? '');
    if (proxy) return { outcome: 'skip', why: `server header names a proxy (${proxy[1].toLowerCase()})` };
    const bytes = Buffer.byteLength(answer.bodyText.trim());
    if (bytes > 0 && !isJson(answer.bodyText)) return { outcome: 'skip', why: `non-JSON body (${bytes} bytes)` };
    const problems: string[] = [];
    if (answer.status !== 400) problems.push(`status ${answer.status}, expected 400`);
    if (bytes > 0) problems.push(`body is not empty (${bytes} bytes), expected an empty body`);
    return { outcome: 'core', problems };
}

function isJson(text: string): boolean {
    try {
        JSON.parse(text);
        return true;
    } catch {
        return false;
    }
}
