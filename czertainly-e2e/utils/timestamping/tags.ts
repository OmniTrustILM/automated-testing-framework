/**
 * tags — the tags of the timestamping block, spelled once.
 *
 * Every test of tests/timestamping carries:
 * - `@dev-tests`: written by the developers (automated-testing-framework#41), ported by QA (#113). `--grep @dev-tests`
 *   selects the block, `--grep-invert @dev-tests` leaves it out of a regression run;
 * - `@timestamping`: the feature;
 * - `@issue:automated-testing-framework#41`.
 * A row that can run on a shared tier (everything but the local-only rows below) also carries:
 * - `@needs:timestamping`: the tier has the connectors and instances the block builds on and OpenSSL 3 is on the runner (utils/timestamping/
 *   need.ts, resolved from reads before the row creates anything: a tier without them skips with a named reason).
 * A row that stops a container or inspects one, or reads the broker's queues (docker, `TSA_ALLOW_DISRUPTION`), carries instead
 * of nothing extra:
 * - `@local`: projectFilters.ts drops `@local` unless TIER_KIND=local; `describeLocalOnly` is the second guard in its spec.
 * Plus, per test: `@slow` (minutes by design: the time-quality and outage specs) and `@disruptive` (stops a container; runs only with
 * TSA_ALLOW_DISRUPTION=true).
 * The setup and teardown projects (`devTests({ infrastructure: true })`) carry neither `@local` nor `@needs`: they decide themselves, by reads
 * and the summary, whether the tier can run the block.
 */
export const DEV_TESTS = '@dev-tests';
export const TIMESTAMPING = '@timestamping';
export const DISRUPTIVE = '@disruptive';
export const NEEDS_TIMESTAMPING = '@needs:timestamping';

const BLOCK = [DEV_TESTS, TIMESTAMPING, '@issue:automated-testing-framework#41'] as const;

/**
 * Details for a describe or a test of the block: `test.describe('…', devTests(), () => …)`.
 * `local`: a docker-bound or disruptive row (`@local`, the local proof serves it). `infrastructure`: the setup and teardown tests.
 */
export function devTests(opts: { slow?: boolean; disruptive?: boolean; local?: boolean; infrastructure?: boolean } = {}): { tag: string[] } {
    const local = opts.local || opts.disruptive;
    return {
        tag: [
            ...BLOCK,
            ...(opts.infrastructure ? [] : [NEEDS_TIMESTAMPING]),
            ...(local ? ['@local'] : []),
            ...(opts.slow ? ['@slow'] : []),
            ...(opts.disruptive ? [DISRUPTIVE] : []),
        ],
    };
}
