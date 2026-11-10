/**
 * teardownTypes — the shapes every teardown handler and the teardown run share; types only, so handler modules and runTeardown do not
 * import each other at runtime.
 */
import type { APIRequestContext } from '@playwright/test';
import type { LedgerLine } from '../ledger/ledger';
import type { WorkaroundNote } from '../ledger/ownership';
import type { JsonObject } from '../json';


export interface TeardownContext {
    api: APIRequestContext;
    runId: string;
    ledger: LedgerLine[];
    seen: Set<string>;
    tier: string | null;
    live?: JsonObject;
    warn: (message: string) => void;
    pollMs?: number;
    knownBug?: (note: WorkaroundNote) => void;
}

export type RemoveResult = void | 'kept';

export interface TeardownHandler {
    /** One line for the dry-run plan: what remove() does. */
    action: string;
    remove(ctx: TeardownContext, line: LedgerLine): Promise<RemoveResult>;
    /**
     * For an object that goes with its parent (a key item): when it is gone and this answers true (the parent's `deleted` line exists), the
     * removal is done.
     */
    goneWith?(ctx: TeardownContext, line: LedgerLine): boolean;
}

/**
 * A step hook: runs once before the deletes of its step, independent of
 * ledger lines; a failure is a cleanup failure and the step still runs.
 */
export interface TeardownPrepStep {
    before: number;
    name: string;
    when(lines: LedgerLine[], runId: string): boolean;
    run(ctx: TeardownContext): Promise<void>;
}
