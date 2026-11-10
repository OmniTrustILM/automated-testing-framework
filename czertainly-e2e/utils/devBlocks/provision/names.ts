/**
 * names — shared helpers of the development blocks' setups: `newStamp`, `objectName`, `step` and `uuidOf`.
 */
import * as crypto from 'crypto';
import { Logger } from '../../Logger';
import { runName } from '../../regression/ledger/runState';
import { scrubSecrets, SetupError, TierError } from './transport';

export function newStamp(): string {
    let s = '';
    for (let i = 0; i < 4; i++) s += crypto.randomInt(36).toString(36);
    return s;
}

/** `<run id>-<suffix>-<stamp>`: the prefix the run-end teardown's live-name check accepts. */
export const objectName = (ctx: { stamp: string }, suffix: string): string => runName(`${suffix}-${ctx.stamp}`);

export async function step<T>(name: string, fn: () => Promise<T>): Promise<T> {
    try {
        return await fn();
    } catch (e) {
        if (e instanceof TierError) throw new TierError(`${name}: ${e.message}`);
        if (e instanceof SetupError) throw new SetupError(`${name}: ${e.message}`);
        throw e;
    }
}

export function uuidOf(body: unknown, what: string, loggerName: string, secrets: readonly string[] = []): string {
    const uuid = (body as { uuid?: unknown } | undefined)?.uuid;
    if (typeof uuid !== 'string' || !uuid) {
        new Logger(loggerName).warn(`no uuid returned for ${what}; answer: ${scrubSecrets(JSON.stringify(body) ?? '', secrets).slice(0, 300)}`);
        // A create that answered without a uuid is a broken answer, not a missing component, and leaves an object the ledger cannot name.
        throw new SetupError(`no uuid returned for ${what}`);
    }
    return uuid;
}
