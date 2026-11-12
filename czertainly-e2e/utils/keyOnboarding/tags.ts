/**
 * tags — the tags of the key onboarding block, spelled once.
 *
 * Every test of tests/key-onboarding carries `@dev-tests` (written by the developers, ported by QA; `--grep @dev-tests`
 * selects every developers' block, `--grep-invert @dev-tests` leaves them out of a regression run), `@key-onboarding`
 * (the feature), `@local` (a proven local stack only: projectFilters.ts drops `@local` unless TIER_KIND=local, and
 * `describeLocalOnly` is the second guard in each spec; no shared tier has the PKCS#11 connector with a token, and
 * planting key pairs needs docker on the runner) and `@issue:ilm#409`.
 */
export const DEV_TESTS = '@dev-tests';
export const KEY_ONBOARDING = '@key-onboarding';

const BLOCK = [DEV_TESTS, KEY_ONBOARDING, '@local', '@issue:ilm#409'] as const;

/** Details for a describe or a test of the block: `test.describe('…', devTests(), () => …)`. */
export function devTests(): { tag: string[] } {
    return { tag: [...BLOCK] };
}
