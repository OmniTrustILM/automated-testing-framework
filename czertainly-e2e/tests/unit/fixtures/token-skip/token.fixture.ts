// The fixture spec of tests/unit/tokenFixtures.spec.ts: three tests take the
// restricted token; with a 401 identity provider the grant is sent once and all three skip. Not a suite spec.
import { test, expect } from '../../../../fixtures/testFixtures';

for (const n of [1, 2, 3]) {
    test(`TOK-0${n}: takes the restricted token`, async ({ restrictedToken }) => {
        expect(restrictedToken).toBeDefined();
    });
}
test('TOK-04: takes the admin token', async ({ adminToken }) => {
    expect(adminToken).toBeDefined();
});
