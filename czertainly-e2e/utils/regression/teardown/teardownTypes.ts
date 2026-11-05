/**
 * teardownTypes — the shapes every teardown handler and the teardown run share.
 *
 * `TeardownContext` (what a handler gets), `TeardownHandler` (what a handler is), `RemoveResult` and `TeardownPrepStep` (a hook
 * that runs before a delete step). Types only, no runtime code: the handler modules and runTeardown refer to each other, so a
 * handler module imports no runtime code from runTeardown, and runTeardown can import every handler module statically. runTeardown
 * re-exports them under their old names.
 */
import type { APIRequestContext } from '@playwright/test';
import type { LedgerLine } from '../ledger/ledger';
import type { WorkaroundNote } from '../ledger/ownership';
import type { JsonObject } from '../json';


export interface TeardownContext {
    api: APIRequestContext;
    runId: string;
    /** The ledger as of the start of the current step. */
    ledger: LedgerLine[];
    /** Uuids read with 200 during this object's step: only those may count a 404 as "gone". */
    seen: Set<string>;
    /** Tier identity the ledger lines must carry; null = not checked (no BASE_URL, unit tests). */
    tier: string | null;
    /** The live object read by `wrapHandlerWithGuard` right before `remove` (absent for an id-named type). */
    live?: JsonObject;
    /** Report a kept object or another non-fatal finding (printed at the end of the teardown). */
    warn: (message: string) => void;
    /** Poll interval of the absence check (tests shorten it). */
    pollMs?: number;
    /** A known product bug was worked around (core#2511: absence confirmed through the full list); logged and reported. */
    knownBug?: (note: WorkaroundNote) => void;
}

export type RemoveResult = void | 'kept';

export interface TeardownHandler {
    /** One line for the dry-run plan: what remove() does. */
    action: string;
    remove(ctx: TeardownContext, line: LedgerLine): Promise<RemoveResult>;
    /**
     * An object that goes WITH its parent (a key item with its key). When the live read finds it gone and
     * this answers true (the parent's `deleted` ledger line of this run exists), the removal is done — the parent's
     * handler proved the absence. Any other missing object stays "route or object missing".
     */
    goneWith?(ctx: TeardownContext, line: LedgerLine): boolean;
}

/**
 * A step hook: runs BEFORE the deletes of its step, once, with a fresh context, independent of
 * ledger lines. A failure is recorded as a cleanup failure (the run ends red) and the step still runs.
 */
export interface TeardownPrepStep {
    /** The delete step the hook precedes. */
    before: number;
    name: string;
    /** Whether the hook has anything to do for this ledger (no context is opened otherwise). */
    when(lines: LedgerLine[], runId: string): boolean;
    run(ctx: TeardownContext): Promise<void>;
}
