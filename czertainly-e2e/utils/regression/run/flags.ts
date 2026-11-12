import { settings } from './settings';
/**
 * flags — the one parser for the boolean switches of the REG-* / API-* runs.
 *
 * Every switch goes through `parseFlag`, so a spelling the parser does not know can never silently pick a side:
 *   truthy  1 / true / yes / on       (any case, surrounding blanks ignored)
 *   falsy   0 / false / no / off / '' (empty)
 *   unset   the documented default
 *   anything else throws, naming the variable: a typo stops the run instead of choosing for it.
 *
 * The dry run is checked at the top of every delete path (executeTeardown, removeOwnObject, every teardown handler,
 * the guarded API's DELETE), so no path deletes while it is on.
 */

const TRUTHY = new Set(['1', 'true', 'yes', 'on']);
const FALSY = new Set(['0', 'false', 'no', 'off', '']);

/** Parse a boolean switch; `fallback` applies only when the variable is unset. Unknown values throw. */
export function parseFlag(value: string | undefined, name: string, fallback: boolean): boolean {
    if (value === undefined) return fallback;
    const v = value.trim().toLowerCase();
    if (TRUTHY.has(v)) return true;
    if (FALSY.has(v)) return false;
    throw new Error(`${name}="${value}" is not a switch: use 1 / true / yes / on or 0 / false / no / off`);
}

/** API_TEARDOWN_DRY_RUN: the run-end teardown prints its plan and deletes nothing (default off). */
export function isDryRun(env: NodeJS.ProcessEnv = process.env): boolean {
    return parseFlag(settings(env).teardownDryRun, 'API_TEARDOWN_DRY_RUN', false);
}

export class DryRunRefusal extends Error {
    constructor(readonly where: string) {
        super(`${where}: API_TEARDOWN_DRY_RUN is on, nothing may be deleted or changed by the teardown`);
        this.name = 'DryRunRefusal';
    }
}

/** Throws DryRunRefusal while the dry run is on; the first statement of every delete path. */
export function assertNotDryRun(where: string, env: NodeJS.ProcessEnv = process.env): void {
    if (isDryRun(env)) throw new DryRunRefusal(where);
}
