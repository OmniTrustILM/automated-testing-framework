/**
 * nonInterference — API-GEN-33: the automated proof of the own-objects rule on a shared tier (a run changes only what it created).
 *
 * `snapshotTier(api)` records, per resource, the total and the objects whose name does NOT carry a run prefix
 * (`qa-reg-` / `qa-api-`), each with its name, its description (when the list carries one) and a marker of its
 * mutable state; the platform-level event associations and the system jobs are stored as canonical JSON.
 * `compareSnapshots(before, after)` then asserts:
 *   1. every stored foreign object is still there with an unchanged name, description and marker (roles,
 *      groups, authorities, credentials, connectors and other markerless resources were blind to a rename or an edit);
 *   2. platform event associations and system jobs are identical;
 *   3. net accounting per resource: `after.total - before.total` equals what the run's ledger explains
 *      (own and derived objects created since the before snapshot minus own objects deleted since then), within
 *      NET_TOLERANCE (REG_NET_TOLERANCE, default 0: any unexplained change is a violation). Keys count key items, so
 *      their expected change is a range (an own key brings one or two items, an own certificate up to one
 *      `certKey_<CN>` item);
 *   4. a REQUIRED resource (certificates, RA profiles, authorities, ACME profiles, roles, users, groups, keys, tokens)
 *      that could not be read before the run leaves the proof incomplete: that is a violation, not a note;
 *   5. both snapshots were taken on the same tier (tier identity).
 * A violation is a finding for a human, who rules out concurrent activity on the shared tier: this is a proof, not a lock.
 *
 * Other QA tools on the same tier (after an incident in which a manual-test session's own cleanup deleted
 * its own certificate and key while the API run was in flight). The comparison reads the SHARED ledger: lines of every
 * other run id (qa-man, qa-cand, another qa-reg run, …), each with its `at` INSIDE the run window
 * [before.takenAt, after.takenAt] (`foreignWindowLines`). Such a line explains (one note, never a violation):
 *   - a stored foreign object that is gone, when the line records ITS deletion (same resource type through
 *     FOREIGN_TYPE_ALIASES, same uuid): an explicit `deleted` event, or an event-less line of an older tool whose note
 *     starts with `DELETED` (`foreignEventOf`);
 *   - the change of a total, and only by objects proven NEW: a deletion counts only for a stored foreign object that is
 *     gone; a creation only for an object that has no deletion line of its own inside the window and is proven to have
 *     been created during the run. In a collection read whole: not stored before, stored after. In a large collection
 *     whose detail carries a creation time (keys): a detail read (`confirmForeignCreates`) with a creation time at or
 *     after before.takenAt. In a large collection without one (certificates, discoveries): in the AFTER newest sample
 *     and absent from the BEFORE newest sample (`newestUuids`). Existing alone proves nothing (an object from the middle
 *     of a large collection is not new). Each uuid counts once, so the lines never explain more change than these objects.
 * Fail-closed: a line without a parseable `at`, outside the window, of this run, naming one of this run's own uuids (its
 * ledger lines or the objects the teardown deleted; compared case-insensitively), without a run id, of a type without a
 * snapshot resource, with an event-less note that mentions a deletion anywhere but its start, or that the parser
 * dropped (unreadable, wrong shape) explains nothing. On a tier with a known identity, a line carrying another tier
 * explains nothing, and a line without a tier explains only in the older event-less shape of the other QA tools; when
 * such a tier-less line is used, the note says so. A tier-less line is attributed by its uuid and resource type only
 * (the manual-test tool writes no tier): a uuid is unique across tiers, but nothing else ties the line to this tier.
 * Anything not explained stays a violation.
 *
 * Markers: the list DTOs carry no `updated` field (interfaces origin/main 71d7f73b), only notification profiles a
 * `version`. Everywhere else the marker is the state a forbidden mutation would change: `enabled` (disable), a
 * certificate's `state` / `archived` (revoke, archive), a key's item states (destroy, disable), `ignoreTrigger`, a
 * discovery's terminal status. Volatile fields (connector or token status, fire times) are left out on purpose, and so
 * are the transient discovery statuses `inProgress` / `processing`: a foreign discovery that finishes during the run
 * is not a change the run made.
 *
 * Large collections (certificates, keys, discoveries) are not walked: the snapshot stores the total, the
 * OLDEST window (200, the tail of the newest-first list) and the NEWEST sample (100, the head: the objects most likely
 * to be touched by mistake). In the after snapshot a stored uuid that left both is re-read by its detail URL
 * (`recheck`), so a deletion is never mistaken for drift.
 *
 * Keys (an incident fix): the key search lists one row per key ITEM whose `name` is the item's name, while
 * `GET /v1/keys/{uuid}` names the WRAPPER (core CryptographicKeyItem.mapToSummaryDto vs KeyDetailDto). A key is therefore
 * identified by its wrapper uuid (`keyWrapperUuid`) and marked the same way from rows and from the detail: `name` = its
 * item names, `marker` = its item states (`keyMarksFromRows` / `keyMarksFromDetail`); the wrapper's own name is stored as
 * `wrapper` only when the detail was read and compared only when both snapshots carry it. A key whose rows straddle a
 * window cut (one item on the boundary row of the newest sample or of the oldest window) would get a partial mark from
 * the rows, so such a key is always re-read by its detail (`keysChangedDuringRun`), in the before and the after snapshot alike.
 *
 * Not snapshotted (explicit gap list, `SNAPSHOT_GAPS`): see below; each has a reason.
 *
 * Messages, notes and attachments carry the resource type and the uuid only, never a foreign object's name;
 * names stay in the snapshot files in the local state directory, which `purgeOldSnapshots` clears after 14 days.
 *
 * Where the code lives (this module re-exports all of it, so importers keep one path): `snapshotModel.ts` the shapes, the
 * resource definitions, the marks; `snapshot.ts` the reads and the snapshot files; `foreignLedger.ts` what other tools' ledger
 * lines explain; `compare.ts` the judgement.
 */
export * from './snapshotModel';
export * from './snapshot';
export * from './foreignLedger';
export * from './compare';
export { SNAPSHOT_GAPS, SNAPSHOT_RESOURCES } from '../resourceTypes';
