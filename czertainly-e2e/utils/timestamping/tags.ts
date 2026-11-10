/**
 * tags — the tags of the timestamping block: `@dev-tests`, `@timestamping`, `@issue:automated-testing-framework#41`, and per row
 * `@needs:timestamping`, `@local` (docker or broker), `@slow` and `@disruptive` (needs TSA_ALLOW_DISRUPTION=true).
 */
export const DEV_TESTS = '@dev-tests';
export const TIMESTAMPING = '@timestamping';
export const DISRUPTIVE = '@disruptive';
export const NEEDS_TIMESTAMPING = '@needs:timestamping';

const BLOCK = [DEV_TESTS, TIMESTAMPING, '@issue:automated-testing-framework#41'] as const;

/** `local`: a docker-bound or disruptive row. `infrastructure`: the setup and teardown tests. */
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
