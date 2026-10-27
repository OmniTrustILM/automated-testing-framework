/**
 * text — small string helpers and the one unique suffix.
 *
 * WHAT: small string helpers every module used to carry its own copy of: regex escaping, whitespace collapsing,
 *       base64url, and the one unique suffix (`uniqueSuffix`) that makes an object name unique per run.
 *       Pure, no I/O.
 * WHY: Every module used to carry its own copy of these helpers, and four generators of a unique name part.
 * HOW: Pure functions; `uniqueSuffix` is nine base-36 characters from a counter, random digits and the clock.
 */
import { randomBytes } from 'crypto';

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
    const random = randomBytes(4).readUInt32BE(0) % 1679616;
    const clock = (Date.now() % 1296).toString(36).padStart(2, '0');
    return `${counter}${random.toString(36).padStart(4, '0')}${clock}`;
};
