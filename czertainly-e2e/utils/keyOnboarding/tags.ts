/**
 * tags — the tags of the key onboarding block: `@dev-tests`, `@key-onboarding`, `@issue:ilm#409`, and `@needs:key-onboarding`
 * on every row except setup and teardown (`infrastructure`); `@local` for a row a shared tier cannot run (none today).
 */
export const DEV_TESTS = '@dev-tests';
export const KEY_ONBOARDING = '@key-onboarding';
export const NEEDS_KEY_ONBOARDING = '@needs:key-onboarding';

const BLOCK = [DEV_TESTS, KEY_ONBOARDING, '@issue:ilm#409'] as const;

export function devTests(opts: { infrastructure?: boolean; local?: boolean } = {}): { tag: string[] } {
    return { tag: [...BLOCK, ...(opts.infrastructure ? [] : [NEEDS_KEY_ONBOARDING]), ...(opts.local ? ['@local'] : [])] };
}
