/** text — small string helpers and the one unique suffix (`uniqueSuffix`); pure, no I/O. */
import { randomInt } from 'crypto';

export const escapeRegExp = (text: string): string => text.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

export const collapse = (text: string): string => text.replace(/\u00a0/g, ' ').replace(/\s+/g, ' ').trim();

export const base64Url = (input: Buffer | string): string => Buffer.from(input).toString('base64url');

let uniqueCounter = 0;

export const UNIQUE_SUFFIX_LENGTH = 9;

/** A short unique suffix for names (`--repeat-each` safe): nine base-36 characters from a counter, random digits and the clock. */
export const uniqueSuffix = (): string => {
    const counter = (uniqueCounter++ % 46656).toString(36).padStart(3, '0');
    const random = randomInt(1679616); // 36^4, without the bias of a modulo
    const clock = (Date.now() % 1296).toString(36).padStart(2, '0');
    return `${counter}${random.toString(36).padStart(4, '0')}${clock}`;
};
