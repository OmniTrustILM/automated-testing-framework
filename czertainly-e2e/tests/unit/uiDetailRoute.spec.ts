/**
 * uiDetailRoute — the route readers of pages/ui/detailRoute.ts.
 *
 * `uuidFromHash` reads the uuid of `#/<route>/detail/<uuid>` (with or without a trailing tab segment or query), the second
 * uuid of a two-id route (`segments: 2`) and requires the version of a versioned route (`version: true`). It refuses
 * another route and anything that is not a canonical uuid, so a create's uuid is never taken from a truncated id, a run
 * of dashes or a route that lost its version. Pure, no browser: a stand-in with a `url()`.
 */
import { expect, test } from '@playwright/test';
import { detailUuidIfOn, uuidFromHash } from '../../pages/ui/detailRoute';

const U = '0b1e8a52-4c3f-4d6e-9a7b-1c2d3e4f5a6b';
const at = (url: string) => ({ url: () => url });

test('uuidFromHash reads the detail uuid of its route and refuses any other route', () => {
    expect(uuidFromHash(at(`http://127.0.0.1/administrator/#/discoveries/detail/${U}`), 'discoveries')).toBe(U);
    expect(uuidFromHash(at(`http://127.0.0.1/administrator/#/notificationprofiles/detail/${U}/1`), 'notificationprofiles')).toBe(U);
    expect(uuidFromHash(at(`http://127.0.0.1/administrator/#/discoveries/detail/${U}?tab=history`), 'discoveries')).toBe(U);
    expect(() => uuidFromHash(at(`http://127.0.0.1/administrator/#/discoveries/detail/${U}`), 'certificates')).toThrow(/not on a certificates detail route/);
    expect(() => uuidFromHash(at('http://127.0.0.1/administrator/#/discoveries'), 'discoveries')).toThrow(/detail route/);
});

test('a versioned route (notification profile) is read only with its version; a canonical uuid is required', () => {
    const url = `http://127.0.0.1/administrator/#/notificationprofiles/detail/${U}/2`;
    expect(uuidFromHash(at(url), 'notificationprofiles', { version: true })).toBe(U);
    expect(detailUuidIfOn(at(`http://127.0.0.1/administrator/#/notificationprofiles/detail/${U}`), 'notificationprofiles', { version: true }), 'the version segment is missing').toBeUndefined();
    expect(detailUuidIfOn(at(`http://127.0.0.1/administrator/#/notificationprofiles/detail/${U}/x`), 'notificationprofiles', { version: true })).toBeUndefined();
    expect(detailUuidIfOn(at(`http://127.0.0.1/administrator/#/keys/detail/${'-'.repeat(36)}`), 'keys'), '36 dashes are no uuid').toBeUndefined();
    expect(detailUuidIfOn(at(`http://127.0.0.1/administrator/#/keys/detail/${U}0`), 'keys'), 'a uuid with a stray digit is no uuid').toBeUndefined();
});

test('a two-uuid route (RA profile) yields its second uuid with `segments: 2`; a one-uuid route is no two-uuid route', () => {
    const V = '1c1e8a52-4c3f-4d6e-9a7b-1c2d3e4f5a6b';
    const url = `http://127.0.0.1/administrator/#/raprofiles/detail/${U}/${V}`;
    expect(uuidFromHash(at(url), 'raprofiles', { segments: 2 })).toBe(V);
    expect(uuidFromHash(at(url), 'raprofiles')).toBe(U);
    expect(detailUuidIfOn(at(`http://127.0.0.1/administrator/#/raprofiles/detail/${U}`), 'raprofiles', { segments: 2 })).toBeUndefined();
    expect(detailUuidIfOn(at(`http://127.0.0.1/administrator/#/certificates/detail/${U[0]}-`), 'certificates'), 'a truncated id is no uuid').toBeUndefined();
});
