/**
 * fakeAnswer — an `ApiAnswer` built from a status and a body text, for the unit tests of the error readers and the
 * helpers that take an answer.
 *
 * WHAT: `fakeAnswer(status, text, extra?)` is a complete answer: JSON content type, empty headers, the body parsed when it
 * parses, a fixed start instant and one millisecond elapsed; `extra` overrides any member.
 * WHY: every unit file used to write its own partial answer object; one complete one keeps them in step with the type.
 * HOW: pure; no I/O.
 */
import type { ApiAnswer } from '../../../utils/regression/apiReads';

export function fakeAnswer(status: number, text = '', extra: Partial<ApiAnswer> = {}): ApiAnswer {
    let json: unknown;
    try {
        json = text.trim() ? JSON.parse(text) : undefined;
    } catch {
        json = undefined;
    }
    return { status, contentType: 'application/json', headers: {}, text, json, startedAt: new Date(0), elapsedMs: 1, ...extra };
}
