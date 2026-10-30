/**
 * text — small string helpers and the one unique suffix.
 *
 * Provides regex escaping, whitespace collapsing, base64url, and `uniqueSuffix`, which makes an object name unique per run (nine
 * base-36 characters from a counter, random digits and the clock). Pure, no I/O.
 */
import { randomInt } from 'crypto';

/** The text with every regular-expression metacharacter escaped, for `new RegExp(...)` around a literal. */
export const escapeRegExp = (text: string): string => text.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

/** The text with non-breaking spaces as spaces, every whitespace run as one space, trimmed (how a reader sees a cell). */
export const collapse = (text: string): string => text.replace(/\u00a0/g, ' ').replace(/\s+/g, ' ').trim();

/** base64url without padding (RFC 7515 §2) of a string or bytes. */
export const base64Url = (input: Buffer | string): string => Buffer.from(input).toString('base64url');

let uniqueCounter = 0;

/** The length of every `uniqueSuffix()`: short enough that a run-prefixed certificate name stays a legal common name. */
export const UNIQUE_SUFFIX_LENGTH = 9;

/**
 * A short unique suffix for names (`--repeat-each` safe), nine base-36 characters: three for a per-process counter (two
 * calls in one millisecond differ), four random (two processes differ) and two from the clock (a counter that wrapped
 * meets a different value).
 */
export const uniqueSuffix = (): string => {
    const counter = (uniqueCounter++ % 46656).toString(36).padStart(3, '0');
    const random = randomInt(1679616); // 36^4, without the bias of a modulo
    const clock = (Date.now() % 1296).toString(36).padStart(2, '0');
    return `${counter}${random.toString(36).padStart(4, '0')}${clock}`;
};
