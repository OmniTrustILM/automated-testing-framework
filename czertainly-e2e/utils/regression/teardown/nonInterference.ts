/**
 * nonInterference — the proof that a run changed only what it created on a shared tier (a finding for a person, not a lock).
 * Stored foreign objects, platform event associations and system jobs are unchanged; each total changes only as the ledger explains
 * (REG_NET_TOLERANCE); an unreadable required resource is a violation. Other tools' ledger lines count only inside the run window.
 */
export * from './snapshotModel';
export * from './snapshot';
export * from './foreignLedger';
export * from './compare';
export { SNAPSHOT_GAPS, SNAPSHOT_RESOURCES } from '../resourceTypes';
