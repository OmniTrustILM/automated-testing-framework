// The fixture spec of tests/unit/tokenFixtures.spec.ts: three tests take the restricted token.
import { test, expect } from '../../../../fixtures/testFixtures';

for (const n of [1, 2, 3]) {
    test(`TOK-0${n}: takes the restricted token`, async ({ restrictedToken }) => {
        expect(restrictedToken).toBeDefined();
    });
}
test('TOK-04: takes the admin token', async ({ adminToken }) => {
    expect(adminToken).toBeDefined();
});
