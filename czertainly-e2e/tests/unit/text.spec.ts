/**
 * Unit tests of utils/regression/text.ts: unique stamps for run-prefixed names.
 */
import { expect, test } from '@playwright/test';
import { uniqueStamp } from '../../utils/regression/text';

test('uniqueStamp: unique across calls made in the same millisecond', () => {
    expect(new Set(Array.from({ length: 500 }, () => uniqueStamp())).size).toBe(500);
});
