/**
 * names — the block-independent helpers of the development blocks' setups: the name stamp, run-prefixed names, the
 * step wrapper and the uuid of a create answer.
 *
 * WHAT: `newStamp` (four random base36 characters), `objectName` (`<run id>-<suffix>-<stamp>`), `step` (a TierError or
 * SetupError names its step) and `uuidOf` (the uuid of a create answer, or a TierError).
 * WHY: the run-end teardown's live-name check accepts only `<run id>-…` names; a Playwright retry of a setup project
 * must never reuse a name of its first attempt (a stamp per attempt). Both blocks need the same helpers.
 * HOW: plain helpers, no requests; `uuidOf` takes the logger name of the block that calls it.
 */
import * as crypto from 'crypto';
import { Logger } from '../../Logger';
import { runName } from '../../regression/ledger/runState';
import { SetupError, TierError } from './transport';

/** Four random base36 characters. */
export function newStamp(): string {
    let s = '';
    for (let i = 0; i < 4; i++) s += crypto.randomInt(36).toString(36);
    return s;
}

/** `<run id>-<suffix>-<stamp>`: the run prefix the teardown checks, and a fresh name for every setup attempt. */
export const objectName = (ctx: { stamp: string }, suffix: string): string => runName(`${suffix}-${ctx.stamp}`);

/** Runs one step; a TierError or SetupError comes out prefixed with the step's name, anything else unchanged. */
export async function step<T>(name: string, fn: () => Promise<T>): Promise<T> {
    try {
        return await fn();
    } catch (e) {
        if (e instanceof TierError) throw new TierError(`${name}: ${e.message}`);
        if (e instanceof SetupError) throw new SetupError(`${name}: ${e.message}`);
        throw e;
    }
}

/** The uuid of a create answer, or a TierError; the warning is logged under `loggerName`. */
export function uuidOf(body: unknown, what: string, loggerName: string): string {
    const uuid = (body as { uuid?: unknown } | undefined)?.uuid;
    if (typeof uuid !== 'string' || !uuid) {
        new Logger(loggerName).warn(`no uuid returned for ${what}; answer: ${JSON.stringify(body)?.slice(0, 300)}`);
        throw new TierError(`no uuid returned for ${what}`);
    }
    return uuid;
}
