/**
 * refuse — the one way the guard says no.
 *
 * `refuserFor(where)` builds the function every guard step calls to refuse a request: it throws an OwnObjectViolation
 * that names the helper label (`where`), the reason and the refusal kind (`request`, `ownership`, `derived`). The label
 * says at which stage the guard stopped (before the URL was understood, before the path was known, or on the full
 * `guardedApi <METHOD> <path>`).
 */
import { OwnObjectViolation, RefusalKind } from '../ledger/ownership';

/** Refuses the request: throws an OwnObjectViolation (kind `request` unless given), never returns. */
export type Refuse = (reason: string, kind?: RefusalKind, ref?: { uuid?: string }) => never;

/** The refuser of one stage: every refusal carries `where` as its helper label. */
export const refuserFor =
    (where: string): Refuse =>
    (reason, kind = 'request', ref = {}): never => {
        throw new OwnObjectViolation(where, ref, reason, undefined, kind);
    };
