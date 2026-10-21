/**
 * text — small string helpers every module used to carry its own copy of: regex escaping, whitespace collapsing,
 * base64url, and the unique stamps that make object names unique per run (`timestampSuffix`, `uniqueStamp`).
 * Pure, no I/O.
 */
import { randomBytes } from 'crypto';

/** The text with every regular-expression metacharacter escaped, for `new RegExp(...)` around a literal. */
export const escapeRegExp = (text: string): string => text.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

/** The text with non-breaking spaces as spaces, every whitespace run as one space, trimmed (how a reader sees a cell). */
export const collapse = (text: string): string => text.replace(/\u00a0/g, ' ').replace(/\s+/g, ' ').trim();

/** base64url without padding (RFC 7515 §2) of a string or bytes. */
export const base64Url = (input: Buffer | string): string => Buffer.from(input).toString('base64url');

/** A short time stamp (milliseconds since the epoch in base 36) that makes a name unique across `--repeat-each` runs. */
export const timestampSuffix = (): string => Date.now().toString(36);

let uniqueCounter = 0;

/**
 * A short unique stamp for names (`--repeat-each` safe): time in base 36, a per-process counter (two calls in one millisecond
 * differ) and 4 random hex digits (two processes in one millisecond differ).
 */
export const uniqueStamp = (): string => `${Date.now().toString(36)}${(uniqueCounter++ % 1296).toString(36).padStart(2, '0')}${randomBytes(2).toString('hex')}`;
