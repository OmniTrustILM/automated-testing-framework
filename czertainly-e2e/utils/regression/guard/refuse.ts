/**
 * Refusals — the one way the guard says no.
 *
 * WHAT: `refuserFor(where)` builds the function every guard step calls to refuse a request: it throws an
 * OwnObjectViolation that names the helper label (`where`), the reason and the refusal kind.
 * WHY: the label tells the reader at which stage the guard stopped (before the URL was understood, before the path was
 * known, or on the full `guardedApi <METHOD> <path>`), and the kind (`request`, `ownership`, `derived`) tells a test why.
 * Building the refuser once per stage keeps the label out of any mutable variable.
 * HOW: a step receives the refuser of its stage as an argument; the reason strings stay with the rule that raises them.
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
