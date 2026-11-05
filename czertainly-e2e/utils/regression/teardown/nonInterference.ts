/**
 * nonInterference — API-GEN-33: the proof that a run changes only what it created on a shared tier. It is a proof, not
 * a lock: a violation is a finding for a person, who rules out other activity on the tier.
 *
 * `snapshotTier` stores, per resource, the total and the objects without a run prefix (name, description and a marker
 * of their state); `compareSnapshots` then asserts:
 *   1. every stored foreign object is still there with the same name, description and marker;
 *   2. the platform event associations and the system jobs are identical;
 *   3. each total changes only as the run's ledger explains (REG_NET_TOLERANCE, default 0); keys count key items;
 *   4. a REQUIRED resource that could not be read before the run is a violation, not a note;
 *   5. both snapshots come from the same tier.
 *
 * Other QA tools' ledger lines (other run ids) explain a change only inside the run window: the deletion of a stored
 * foreign object that is gone, or the creation of an object proven new during the run. Fail-closed: a line without a
 * readable time, outside the window, of this run, naming one of this run's uuids, of another tier, or that does not
 * parse explains nothing; a tier-less line counts only in the other tools' older shape, and the note says so.
 *
 * Markers are the state a forbidden change would flip (enabled, a certificate's state and archived flag, key item
 * states, ignoreTrigger, a discovery's final status); volatile fields and the transient discovery states are left out.
 * Large collections (certificates, keys, discoveries) keep the total, the oldest 200 and the newest 100; a stored uuid
 * that left both windows is re-read by its detail (`recheck`), so a deletion is never taken for drift. Keys are
 * identified by their wrapper uuid (`keyWrapperUuid`); a key cut by a window edge is always re-read by its detail
 * (`keysChangedDuringRun`), an incident fix. What is not snapshotted is listed with a reason in `SNAPSHOT_GAPS`.
 *
 * Messages carry type and uuid only, never a foreign name; the snapshot files stay local and `purgeOldSnapshots` clears
 * them after 14 days. The code: snapshotModel.ts (shapes, marks), snapshot.ts (reads, files), foreignLedger.ts (other
 * tools' lines), compare.ts (the judgement); this module re-exports them.
 */
export * from './snapshotModel';
export * from './snapshot';
export * from './foreignLedger';
export * from './compare';
export { SNAPSHOT_GAPS, SNAPSHOT_RESOURCES } from '../resourceTypes';
