/**
 * Unit tests of utils/regression/inventory/groupProbes.ts: the history text of a group change and the group
 * changes of a certificate history. No environment, no network.
 */
import { expect, test } from '@playwright/test';
import { changeKey, groupChanges, groupEventCount, parseGroupChange } from '../../utils/regression/inventory/groupProbes';

// ------------------------------------------------------------------ the group history

test('parseGroupChange: "<old> -> <new>", each side group names joined with ", " in no defined order, "undefined" = no group; a message without the arrow is not a change', () => {
    expect(parseGroupChange('undefined -> a')).toEqual({ from: [], to: ['a'] });
    expect(parseGroupChange('b, a -> c')).toEqual({ from: ['a', 'b'], to: ['c'] });
    expect(parseGroupChange('c -> undefined')).toEqual({ from: ['c'], to: [] });
    expect(parseGroupChange('undefined -> undefined')).toEqual({ from: [], to: [] });
    expect(parseGroupChange('Certificate has been archived.')).toBeUndefined();
});

test('groupChanges / changeKey / groupEventCount: successful Update Group events only; the key is order-free and reads like the history text', () => {
    const events = [
        { event: 'Upload Certificate', status: 'SUCCESS', message: 'x -> y' },
        { event: 'Update Group', status: 'SUCCESS', message: 'undefined -> g2, g1' },
        { event: 'Update Group', status: 'SUCCESS', message: 'g1, g2 -> g3' },
        { event: 'Update Group', status: 'FAILED', message: 'g3 -> undefined' },
        { event: 'Update Group', status: 'SUCCESS', message: 'g3 -> undefined' },
        { event: 'Update Group', status: 'SUCCESS' },
    ];
    expect(groupChanges(events).map(changeKey)).toEqual(['undefined -> g1, g2', 'g1, g2 -> g3', 'g3 -> undefined']);
    expect(groupEventCount(events), 'every Update Group event counts for the no-op check').toBe(5);
    expect(groupEventCount([])).toBe(0);
});
