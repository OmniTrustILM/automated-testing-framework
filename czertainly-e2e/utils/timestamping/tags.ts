/**
 * tags — the tags of the timestamping block, spelled once.
 *
 * Every test of tests/timestamping carries:
 * - `@dev-tests`: written by the developers (automated-testing-framework#41), ported by QA (#113). `--grep @dev-tests`
 *   selects the block, `--grep-invert @dev-tests` leaves it out of a regression run;
 * - `@timestamping`: the feature;
 * - `@local`: the block runs on a proven local stack only (projectFilters.ts drops `@local` unless TIER_KIND=local;
 *   `describeLocalOnly` is the second guard in each spec), because no shared tier has the timestamping connectors yet
 *   and the guard has no create-only rules for its objects yet;
 * - `@issue:automated-testing-framework#41`.
 * Plus, per test: `@slow` (minutes by design: the time-quality and outage specs) and `@disruptive` (stops a container;
 * runs only with TSA_ALLOW_DISRUPTION=true).
 */
export const DEV_TESTS = '@dev-tests';
export const TIMESTAMPING = '@timestamping';
export const DISRUPTIVE = '@disruptive';

const BLOCK = [DEV_TESTS, TIMESTAMPING, '@local', '@issue:automated-testing-framework#41'] as const;

/** Details for a describe or a test of the block: `test.describe('…', devTests(), () => …)`. */
export function devTests(opts: { slow?: boolean; disruptive?: boolean } = {}): { tag: string[] } {
    return { tag: [...BLOCK, ...(opts.slow ? ['@slow'] : []), ...(opts.disruptive ? [DISRUPTIVE] : [])] };
}
