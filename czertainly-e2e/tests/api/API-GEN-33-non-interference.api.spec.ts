/**
 * API-GEN-33 — shared-tier non-interference: the run changed nothing it did not create (decision Q1).
 *
 * The teardown project `non-interference` of both configs: it runs after every other project, also when they failed.
 * It takes a second snapshot (stored uuids that left a large collection's windows are re-read by detail) and compares it
 * with the "before" snapshot of `_run-setup.setup.ts`: every pre-existing object still there with an unchanged marker,
 * platform event associations and system jobs identical, totals changed exactly by what the run's ledger explains (net
 * accounting, REG_NET_TOLERANCE), every required resource readable, same tier. A missing before snapshot on a shared
 * tier FAILS this test (R9): no snapshot, no proof. The attached diff names resource types and uuids only (R20).
 * A violation is a finding; a human rules out concurrent activity on the shared tier before calling it a defect.
 * The run-end teardown repeats the comparison after it deleted the run's own objects. BASE_URL unset fails (Q11).
 * Reads go through the guarded `api` fixture (deny by default, review Q2): the snapshot sends GETs and search POSTs only.
 */
import { expect, test } from '../../fixtures/testFixtures';
import { compareSnapshots, loadSnapshot, snapshotTier } from '../../utils/regression/nonInterference';
import { readLedger, RUN_ID } from '../../utils/regression/regressionRun';
import { snapshotBeforeFile } from '../../utils/regression/runId';
import { meta, tags } from '../../utils/regression/tags';
import { isLocalTier } from '../../utils/regression/tier';

test.describe('API-GEN-33 shared-tier non-interference', { tag: tags.api }, () => {
    test.skip(isLocalTier(), 'local stack: the non-interference proof runs on shared tiers only');

    test('API-GEN-33: no pre-existing object changed or vanished during the run', meta({ id: 'API-GEN-33', prio: 'P1', issue: 'ilm#428' }), async ({ api }, testInfo) => {
        // The same reads as the before snapshot, plus one detail read per stored object that left its window.
        test.setTimeout(120_000);
        expect(process.env.BASE_URL, 'BASE_URL is unset: a run without a tier fails (Q11)').toBeTruthy();
        const before = loadSnapshot(snapshotBeforeFile());
        expect(before, 'no before snapshot of this run on a shared tier: the snapshot project failed or was skipped, so there is no proof').toBeTruthy();
        const after = await test.step('Snapshot the tier again', async () => snapshotTier(api, { recheck: before! }));
        const result = await test.step('Compare with the before snapshot and the run ledger', async () => {
            const r = compareSnapshots(before!, after, { ledger: readLedger(), runId: RUN_ID });
            await testInfo.attach('non-interference.json', { body: JSON.stringify(r, null, 2), contentType: 'application/json' });
            r.notes.forEach((n) => testInfo.annotations.push({ type: 'note', description: n }));
            return r;
        });
        expect(result.violations, 'objects that existed before the run must be untouched (decision Q1)').toEqual([]);
    });
});
