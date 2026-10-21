/**
 * pages/ui/detailRoute.ts: `uuidFromHash` reads the uuid of `#/<route>/detail/<uuid>` (with or without a trailing tab
 * segment or query) and refuses another route. Pure, no browser.
 */
import { expect, test } from '@playwright/test';
import { uuidFromHash } from '../../pages/ui/detailRoute';

const U = '0b1e8a52-4c3f-4d6e-9a7b-1c2d3e4f5a6b';
const at = (url: string) => ({ url: () => url });

test('uuidFromHash reads the detail uuid of its route and refuses any other route', () => {
    expect(uuidFromHash(at(`http://127.0.0.1/administrator/#/discoveries/detail/${U}`), 'discoveries')).toBe(U);
    expect(uuidFromHash(at(`http://127.0.0.1/administrator/#/notificationprofiles/detail/${U}/1`), 'notificationprofiles')).toBe(U);
    expect(uuidFromHash(at(`http://127.0.0.1/administrator/#/discoveries/detail/${U}?tab=history`), 'discoveries')).toBe(U);
    expect(() => uuidFromHash(at(`http://127.0.0.1/administrator/#/discoveries/detail/${U}`), 'certificates')).toThrow(/not on a certificates detail route/);
    expect(() => uuidFromHash(at('http://127.0.0.1/administrator/#/discoveries'), 'discoveries')).toThrow(/detail route/);
});
