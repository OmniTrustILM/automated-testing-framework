/**
 * REG-RUN-01 — Run setup: makes the objects the later specs build on once, before the first spec (ilm#428).
 *
 * Creates the run's MS ADCS authority, RA profile, ACME profile, role, and token with token profile and key. Runs in the
 * `run-setup` project, after `snapshot` and before `regression`; all go through the guarded API, ledger line first.
 * A tier that cannot offer an object skips the row and never fails: Playwright would not start `regression`.
 */
import { test } from '../../fixtures/testFixtures';
import { prepareRunObject, RUN_OBJECTS, RUN_SETUP_TEST_TIMEOUT_MS } from '../../utils/regression/run/runObjects';
import { testMeta, tags } from '../../utils/regression/tags';

const SPEC = 'REG-RUN-01';

test.describe.configure({ mode: 'serial' });

test.describe('run objects', { tag: tags.regression }, () => {
    for (const object of RUN_OBJECTS) {
        test(`the run ${object.label} is made once for the later specs`, testMeta({ id: SPEC, row: object.row, prio: 'P1', issue: 'ilm#428' }), async ({ api }) => {
            test.setTimeout(RUN_SETUP_TEST_TIMEOUT_MS);
            const skip = await prepareRunObject(object, api, SPEC);
            test.skip(skip !== undefined, skip ?? '');
        });
    }
});
