/**
 * Unit tests of utils/regression/ownGroups.ts: the group uuids of a certificate detail.
 */
import { expect, test } from '@playwright/test';
import { groupUuidsOf } from '../../utils/regression/ownGroups';

const U = (n: number) => `00000000-0000-4000-8000-${String(n).padStart(12, '0')}`;

test('groupUuidsOf: the uuids of the groups of a certificate detail, sorted; none when the member is missing', () => {
    expect(groupUuidsOf({ groups: [{ uuid: U(3) }, { uuid: U(2) }] })).toEqual([U(2), U(3)]);
    expect(groupUuidsOf({})).toEqual([]);
    expect(groupUuidsOf({ groups: [] })).toEqual([]);
});
