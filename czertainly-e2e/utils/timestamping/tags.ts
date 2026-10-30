/**
 * tags — the tags of the timestamping block, spelled once.
 *
 * Every test of tests/timestamping carries `@dev-tests` (written by the developers, automated-testing-framework#41, ported
 * by QA, #113), `@timestamping` and `@issue:automated-testing-framework#41`.
 *   - `@needs:timestamping` on every row (utils/timestamping/need.ts); not on the setup and teardown tests, which decide by reads
 *   - `@local` on a row that stops or inspects a container or reads the broker's queues (docker, `TSA_ALLOW_DISRUPTION`)
 *   - `@slow` (minutes by design) and `@disruptive` (stops a container; only with TSA_ALLOW_DISRUPTION=true)
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
