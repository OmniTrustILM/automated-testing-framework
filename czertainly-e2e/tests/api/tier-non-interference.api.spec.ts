/**
 * Non-interference (API-GEN-33): the run changed nothing it did not create. Runs as the `non-interference` project after
 * every other project, failed or not, takes a second snapshot and compares it with the "before" snapshot of
 * tier-snapshot.setup.ts and the run's ledger (utils/regression/teardown/nonInterference.ts). Shared tiers only; reads only.
 */
import { expect, test } from '../../fixtures/testFixtures';
import { compareSnapshots, confirmForeignCreates, readSnapshot, snapshotTier } from '../../utils/regression/teardown/nonInterference';
import { readLedger } from '../../utils/regression/ledger/ledger';
import { runId } from '../../utils/regression/ledger/runState';
import { beforeSnapshotFile } from '../../utils/regression/run/runId';
import { testMeta, tags } from '../../utils/regression/tags';
import { isLocalTier } from '../../utils/regression/tier/kind';

test.describe('shared-tier non-interference', { tag: tags.api }, () => {
    test.skip(isLocalTier(), 'local stack: the non-interference proof runs on shared tiers only');

    test('no pre-existing object changed or vanished during the run', testMeta({ id: 'API-GEN-33', prio: 'P1', issue: 'ilm#428' }), async ({ api }, testInfo) => {
        // The same reads as the before snapshot, plus one detail read per stored object that left its window.
        test.setTimeout(120_000);
        const before = readSnapshot(beforeSnapshotFile());
        expect(before, 'no before snapshot of this run on a shared tier: the snapshot project failed or was skipped, so there is no proof').toBeTruthy();
        const after = await test.step('Snapshot the tier again', async () => snapshotTier(api, { recheck: before! }));
        const result = await test.step('Compare with the before snapshot and the run ledger', async () => {
            const ledger = readLedger();
            // Other QA tools' creates in a large collection that the after snapshot does not store: one detail read each.
            const confirmedCreated = await confirmForeignCreates(api, before!, after, { ledger, runId: runId() });
            const r = compareSnapshots(before!, after, { ledger, runId: runId(), confirmedCreated });
            await testInfo.attach('non-interference.json', { body: JSON.stringify(r, null, 2), contentType: 'application/json' });
            r.notes.forEach((n) => testInfo.annotations.push({ type: 'note', description: n }));
            return r;
        });
        expect(result.violations, 'objects that existed before the run must be untouched').toEqual([]);
    });
});
