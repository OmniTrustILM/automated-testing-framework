/**
 * Unit tests of the one unique suffix (utils/regression/text.ts) and the one name builder built on it (ledger/runState.ts).
 */
import { expect, test } from '@playwright/test';
import { uniqueSuffix } from '../../utils/regression/text';
import { ownName, runId } from '../../utils/regression/ledger/runState';

test('uniqueSuffix: unique across calls made in the same millisecond', () => {
    expect(new Set(Array.from({ length: 500 }, () => uniqueSuffix())).size).toBe(500);
});

test('ownName: run-prefixed, carries the suffix and never repeats', () => {
    const names = Array.from({ length: 200 }, () => ownName('probe'));
    expect(new Set(names).size).toBe(200);
    for (const name of names) expect(name).toMatch(new RegExp(`^${runId()}-probe-[a-z0-9]+$`));
});
