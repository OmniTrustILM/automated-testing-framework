import { settings } from './settings';
/**
 * flags — the one parser for the boolean switches of the runs: truthy 1 / true / yes / on, falsy 0 / false / no / off / '',
 * unset = the default, anything else throws (a typo stops the run). The dry run is checked at the top of every delete path.
 */

const TRUTHY = new Set(['1', 'true', 'yes', 'on']);
const FALSY = new Set(['0', 'false', 'no', 'off', '']);

export function parseFlag(value: string | undefined, name: string, fallback: boolean): boolean {
    if (value === undefined) return fallback;
    const v = value.trim().toLowerCase();
    if (TRUTHY.has(v)) return true;
    if (FALSY.has(v)) return false;
    throw new Error(`${name}="${value}" is not a switch: use 1 / true / yes / on or 0 / false / no / off`);
}

export function isDryRun(env: NodeJS.ProcessEnv = process.env): boolean {
    return parseFlag(settings(env).teardownDryRun, 'API_TEARDOWN_DRY_RUN', false);
}

export class DryRunRefusal extends Error {
    constructor(readonly where: string) {
        super(`${where}: API_TEARDOWN_DRY_RUN is on, nothing may be deleted or changed by the teardown`);
        this.name = 'DryRunRefusal';
    }
}

export function assertNotDryRun(where: string, env: NodeJS.ProcessEnv = process.env): void {
    if (isDryRun(env)) throw new DryRunRefusal(where);
}
