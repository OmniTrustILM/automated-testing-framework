/**
 * API-GEN-33 — Run setup: the guard proof, then the "before" snapshot of a shared tier (ilm#428).
 *
 * [guard] proves the tier assertion, one worker, and that an own role is accepted while a run-prefixed name without a
 * ledger line and pre-existing objects are refused.
 * [before] stores the pre-existing objects of every resource for the non-interference spec.
 * An unreadable required resource fails the setup. Runs in the `snapshot` project; the only spec allowed a raw context.
 * Needs BASE_URL; [before] is skipped on a local stack.
 */
import { randomUUID } from 'crypto';
import { expect, getAuthenticatedApiContext, test } from '../../fixtures/testFixtures';
import { isDryRun } from '../../utils/regression/run/flags';
import { readOnlySpy, expectOwnershipRefusal } from '../../utils/regression/guardProofSpy';
import { guardApi } from '../../utils/regression/guard/createGuard';
import { GuardedApi } from '../../utils/regression/guard/types';
import { purgeOldSnapshots, deleteSnapshot, writeSnapshot, snapshotTier, unreadableRequired } from '../../utils/regression/teardown/nonInterference';
import { absenceOf, assertOwn, assertOwnLive, isOwnObject, OwnObjectViolation } from '../../utils/regression/ledger/ownership';
import { createOwnRole } from '../../utils/regression/ownRoles';
import { enableOwnRaProfile } from '../../utils/regression/ownRaProfiles';
import { OwnRef, readLedger } from '../../utils/regression/ledger/ledger';
import { runName, runId } from '../../utils/regression/ledger/runState';
import { regressionStateDir, beforeSnapshotFile } from '../../utils/regression/run/runId';
import { removeOwnObject } from '../../utils/regression/teardown/runTeardown';
import { testMeta, tags } from '../../utils/regression/tags';
import { assertRunTier, assertRunTierLive, proveLocalInstance } from '../../utils/regression/tier/localProof';
import { isLocalTier } from '../../utils/regression/tier/kind';

const SPEC = 'API-GEN-33';

test.describe.configure({ mode: 'serial' });

test.describe('run setup with the guard proof, then the before snapshot', { tag: tags.api }, () => {
    test('the guard accepts this run\'s role and refuses pre-existing objects', testMeta({ id: 'API-GEN-33', row: 'guard', prio: 'P1', issue: 'ilm#428' }), async ({ request, env }, testInfo) => {
        test.setTimeout(120_000);
        expect(process.env.BASE_URL, 'BASE_URL is unset: a run without a tier fails').toBeTruthy();
        const raw = await getAuthenticatedApiContext(request, env);
        try {
            await test.step('The tier assertion of the configs still holds (authenticated local-backend check under TIER_KIND=local); one worker', async () => {
                await assertRunTierLive(raw);
                expect(testInfo.config.workers, 'the REG / API suites run on one worker').toBe(1);
            });
            const own = guardApi(raw);
            if (isLocalTier()) {
                await test.step('Local stack: a run-prefixed role created through BASE_URL is read back through REG_LOCAL_CORE_URL (instance proof)', async () => {
                    await proveLocalInstance(raw, process.env, {
                        createRole: async () => createOwnRole(own, SPEC, 'instance', { note: 'local instance proof' }),
                    });
                });
            }
            const role = await test.step('Create a run-prefixed role through the guarded API; the ledger line comes first', async () =>
                createOwnRole(own, SPEC, 'guard', { note: 'guard proof' }));

            await test.step('The guard accepts it (ledger + live name); a run-prefixed name without a ledger line is refused', async () => {
                expect(isOwnObject(role), 'own: created line of this run and the run prefix').toBe(true);
                await assertOwnLive(raw, 'roles', role, 'guard-proof');
                expect(() => assertOwn({ uuid: randomUUID(), name: runName('not-in-the-ledger') }, 'guard-proof')).toThrow(OwnObjectViolation);
            });

            await test.step('The guard refuses a role that existed before the run (ledger and live)', async () => {
                const roles = (await snapshotTier(raw, { only: ['roles'] })).resources.roles;
                expect(roles.error, 'roles are readable').toBeUndefined();
                const uuid = Object.keys(roles.foreign)[0];
                expect(uuid, 'the tier has at least one pre-existing role').toBeTruthy();
                expect(isOwnObject({ uuid })).toBe(false);
                expect(() => assertOwn({ uuid }, 'guard-proof')).toThrow(OwnObjectViolation);
                await expect(assertOwnLive(raw, 'roles', { uuid }, 'guard-proof')).rejects.toThrow(OwnObjectViolation);
            });

            await test.step('A real guarded helper and the guarded API refuse a pre-existing RA profile; the blocking spy sends nothing', async () => {
                const ras = (await snapshotTier(raw, { only: ['raProfiles'] })).resources.raProfiles;
                expect(ras.error, 'RA profiles are readable').toBeUndefined();
                const raUuid = Object.keys(ras.foreign)[0];
                expect(raUuid, 'the tier has at least one pre-existing RA profile').toBeTruthy();
                const detail = await raw.get(`/api/v1/raProfiles/${raUuid}`);
                expect(detail.ok(), 'the pre-existing RA profile is readable').toBe(true);
                const authorityUuid = String((await detail.json()).authorityInstanceUuid);
                const watched = readOnlySpy(raw);
                // A forged OwnRef and the guard layer removed on purpose: the helper's own assertOwnLive must refuse.
                const forged = { uuid: raUuid, name: runName('forged'), kind: 'own' } as OwnRef;
                // The refusal must be for OWNERSHIP: the brand of a raw context or a path rule would hide a broken check.
                const helperRefusal = await expectOwnershipRefusal(enableOwnRaProfile(watched.api as unknown as GuardedApi, authorityUuid, forged));
                expect(helperRefusal.uuid, 'the helper refused the pre-existing RA profile itself').toBe(raUuid);
                // The guarded context over the same spy: PATCH and DELETE refused for ownership (also under the dry run).
                const guarded = guardApi(watched.api);
                expect((await expectOwnershipRefusal(guarded.patch(`/api/v1/authorities/${authorityUuid}/raProfiles/${raUuid}/disable`))).uuid).toBe(raUuid);
                expect((await expectOwnershipRefusal(guarded.delete(`/api/v1/authorities/${authorityUuid}/raProfiles/${raUuid}`))).uuid).toBe(raUuid);
                expect(watched.mutations, 'no request but a read reached the raw context').toEqual([]);
            });

            await test.step('The teardown registry deletes the own role and records a deleted line', async () => {
                if (isDryRun()) {
                    testInfo.annotations.push({ type: 'dry run', description: 'API_TEARDOWN_DRY_RUN: the own role is kept; the run-end dry run lists it' });
                    return;
                }
                const line = assertOwn(role, 'guard-proof');
                await removeOwnObject({ api: raw, runId: runId(), ledger: readLedger() }, line, SPEC);
                const deleted = readLedger().filter((l) => l.uuid === role.uuid && l.runId === runId() && l.event === 'deleted');
                expect(deleted, 'one deleted line for the role').toHaveLength(1);
                expect(isOwnObject(role), 'a deleted object is no longer own').toBe(false);
                // 404, or (known bug core#2511) a 5xx detail confirmed by the full role list; a 5xx alone never passes.
                const gone = await absenceOf(raw, 'roles', role.uuid, `/api/v1/roles/${role.uuid}`);
                if (gone.knownBug) testInfo.annotations.push({ type: 'known bug', description: `${gone.knownBug.bug}: ${gone.knownBug.note}` });
                expect(gone.absent, `the role is gone (${gone.detail})`).toBe(true);
            });
        } finally {
            await raw.dispose();
        }
    });

    test('snapshot the shared tier before the first spec', testMeta({ id: 'API-GEN-33', row: 'before', prio: 'P1', issue: 'ilm#428' }), async ({ api }, testInfo) => {
        test.skip(isLocalTier(), 'local stack: the non-interference proof runs on shared tiers only');
        // ~30 resources, three of them read as a newest sample plus an oldest window of up to four pages.
        test.setTimeout(180_000);
        expect(process.env.BASE_URL, 'BASE_URL is unset: a run without a tier fails').toBeTruthy();
        assertRunTier();
        const file = beforeSnapshotFile();
        const purged = purgeOldSnapshots(regressionStateDir());
        if (purged.length) testInfo.annotations.push({ type: 'purged', description: `${purged.length} snapshot file(s) older than 14 days` });
        // A stale snapshot of an earlier run with the same id must never be compared against.
        deleteSnapshot(file);
        const snap = await test.step('Read the total and the pre-existing objects of every resource', async () => snapshotTier(api));
        await test.step('Store it for API-GEN-33 and the run-end teardown', async () => {
            writeSnapshot(snap, file);
            const summary = Object.fromEntries(
                Object.entries(snap.resources).map(([type, r]) => [type, r.error ? `unreadable: ${r.error}` : { total: r.total, stored: Object.keys(r.foreign).length }]),
            );
            await testInfo.attach('snapshot-summary.json', { body: JSON.stringify(summary, null, 2), contentType: 'application/json' });
            for (const [type, r] of Object.entries(snap.resources)) {
                if (r.error) testInfo.annotations.push({ type: 'not protected', description: `${type}: ${r.error}` });
            }
        });
        expect(unreadableRequired(snap), 'required resources must be readable before the run, or the proof is incomplete').toEqual([]);
    });
});
