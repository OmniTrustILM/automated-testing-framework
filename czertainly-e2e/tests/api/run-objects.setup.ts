/**
 * REG-RUN-01 — Run setup: the objects the later specs build on are made once, before the first spec. ilm#428.
 *
 * WHAT: 1. The run's MS ADCS authority exists (made through the API from an existing authority's CA; only where a healthy MS ADCS
 *          connector is registered).
 *       2. The run's RA profile exists, on the first healthy CA of REG_CA_CONNECTORS, enabled.
 *       3. The run's ACME profile exists, enabled, with the run's pre-authorized identifier.
 *       4. The run's role exists.
 *       5. The run's token, enabled token profile and key exist (only where a software cryptography connector is registered).
 * WHY: the first spec that created one of these used to become the run's object, so the CA behind the lifecycle rows depended on
 *      which spec ran first and whether it passed. Now the objects are decided once, in this order, from reads of the tier, and the
 *      UI specs of the configuration area create and keep objects of their own.
 * HOW: the `run-setup` project of the regression config, after `snapshot` and before `regression`. Each row uses the same
 *      `ensure…` helper the specs use lazily (it reads the run state first, so a reused run id finds its objects), through the guarded
 *      API and with the ledger line written first. A tier that cannot offer an object skips its row with the named reason and never
 *      fails: Playwright does not start `regression` when a test of its dependency failed. A spec run alone still makes its own
 *      prerequisite through the same helper. The API config does not depend on this project: its rows must run when the gate is red.
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
