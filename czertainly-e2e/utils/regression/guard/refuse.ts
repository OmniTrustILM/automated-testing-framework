/** refuse — the one way the guard says no: an OwnObjectViolation naming the stage label, the reason and the kind. */
import { OwnObjectViolation, RefusalKind } from '../ledger/ownership';

export type Refuse = (reason: string, kind?: RefusalKind, ref?: { uuid?: string }) => never;

export const refuserFor =
    (where: string): Refuse =>
    (reason, kind = 'request', ref = {}): never => {
        throw new OwnObjectViolation(where, ref, reason, undefined, kind);
    };
