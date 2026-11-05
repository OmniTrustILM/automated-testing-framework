/**
 * tags — the tags of the key onboarding block: `@dev-tests`, `@key-onboarding`, `@local` (a proven local stack only; `describeLocalOnly` is
 * the second guard) and `@issue:ilm#409`.
 */
export const DEV_TESTS = '@dev-tests';
export const KEY_ONBOARDING = '@key-onboarding';

const BLOCK = [DEV_TESTS, KEY_ONBOARDING, '@local', '@issue:ilm#409'] as const;

export function devTests(): { tag: string[] } {
    return { tag: [...BLOCK] };
}
