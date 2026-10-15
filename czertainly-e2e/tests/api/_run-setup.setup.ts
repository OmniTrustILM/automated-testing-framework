/**
 * API-GEN-33 setup — the `snapshot` project of both configs: the guard proof, then the "before" snapshot. One file,
 * serial, in this order (review R23): the snapshot is taken only after the guard proved itself on the target tier.
 *
 * 1. API-GEN-33[guard] — live proof of the own-object guard (decision Q1, reviews M2 / R6 / R7 / Q1). Before any spec
 *    relies on it, this test shows on the target tier that
 *      - the tier assertion of the configs still holds (TIER_KIND frozen, local proof, header auth, BASE_URL unchanged),
 *        and, under TIER_KIND=local, BASE_URL's /api/v1/info read WITH the run's authentication names the same core
 *        build as REG_LOCAL_CORE_URL (review Q4); the run uses one worker;
 *      - under TIER_KIND=local only (B0 fix pass 3, instance identity): a run-prefixed role created through BASE_URL
 *        (guarded, recorded) is read back through REG_LOCAL_CORE_URL with the header-mode admin certificate; only then
 *        the run's local-backend proof is written, which `describeLocal` and the guard's `localStack` require. The role
 *        is removed by the run-end teardown;
 *      - the guard accepts a role this run created (ledger line + live run-prefixed name);
 *      - it refuses a uuid that carries this run's name prefix but has no ledger line (the prefix alone is never enough);
 *      - it refuses a role that existed before the run, by the ledger and by the live check;
 *      - a REAL guarded helper (`enableOwnRaProfile`, handed a pre-existing RA profile disguised as an OwnRef, with the
 *        guard layer removed on purpose) and the guarded API context (PATCH, DELETE) refuse it with an OwnObjectViolation
 *        of kind `ownership` (fix pass 3: not the runtime brand, not a path rule) — also under API_TEARDOWN_DRY_RUN,
 *        because the guard checks ownership before the dry run (review Q15);
 *      - all of that behind a BLOCKING spy (review Q1, utils/regression/guardProof.ts) that forwards GET / HEAD only:
 *        any other request that got past the guard is recorded and refused by the spy itself (SpyBlockedRequest), never
 *        forwarded, so a guard regression cannot disable or delete a real object; the test then fails on the error
 *        class and on the recorded list;
 *      - the teardown registry deletes the own role, appends its `deleted` ledger line, and the role is proven absent:
 *        its detail answers 404, or — known bug core#2511, the detail answers 500 for a deleted role — the full
 *        `GET /v1/roles` list no longer names it (annotated as a known bug; a 5xx alone never passes).
 *    Under API_TEARDOWN_DRY_RUN the delete is not done: the role stays and the run-end dry run lists it. If the test
 *    fails half-way, the role still has its `created` line and the run-end teardown removes it.
 * 2. API-GEN-33[before] — snapshot of a shared tier before the first spec; API-GEN-33 (the `non-interference`
 *    project) and the run-end teardown compare against it. Per resource it stores the total and the objects that do not
 *    carry a run prefix, with their name and the marker of their mutable state (utils/regression/nonInterference.ts). A
 *    required resource that cannot be read fails this test (R9): without it the proof is not a proof. Snapshot files
 *    older than 14 days are purged first (they hold foreign names, R20). Local stacks are disposable and not proven.
 *
 * BASE_URL unset is a failure, not a skip (review Q11): a run without a tier must never end green and empty.
 * This file is the one exception to the deny-by-default lint (tests/unit/specGuards.spec.ts): it needs the raw context
 * for the spy and a cast that removes the guard layer from the helper on purpose.
 */
import { randomUUID } from 'crypto';
import { expect, getAuthenticatedApiContext, test } from '../../fixtures/testFixtures';
import { isDryRun } from '../../utils/regression/flags';
import { blockingSpy, ownershipRefusal } from '../../utils/regression/guardProof';
import { guardApi, GuardedApi } from '../../utils/regression/guardedApi';
import { purgeOldSnapshots, removeSnapshot, saveSnapshot, snapshotTier, unreadableRequired } from '../../utils/regression/nonInterference';
import { absenceOf, assertOwn, assertOwnLive, isOwn, OwnObjectViolation } from '../../utils/regression/ownObjects';
import { createRole, enableOwnRaProfile } from '../../utils/regression/regressionApi';
import { OwnRef, readLedger, recordCreated, regName, RUN_ID } from '../../utils/regression/regressionRun';
import { regressionStateDir, snapshotBeforeFile } from '../../utils/regression/runId';
import { removeOwnObject } from '../../utils/regression/runTeardown';
import { meta, tags } from '../../utils/regression/tags';
import { assertRunTier, assertRunTierLive, isLocalTier, proveLocalInstance } from '../../utils/regression/tier';

const SPEC = 'API-GEN-33';

test.describe.configure({ mode: 'serial' });

test.describe('API-GEN-33 run setup: guard proof, then the before snapshot', { tag: tags.api }, () => {
    test('API-GEN-33[guard]: the guard accepts this run\'s role and refuses pre-existing objects before any request', meta({ id: 'API-GEN-33', prio: 'P1', issue: 'ilm#428' }), async ({ request, env }, testInfo) => {
        test.setTimeout(120_000);
        expect(process.env.BASE_URL, 'BASE_URL is unset: a run without a tier fails (Q11)').toBeTruthy();
        const raw = await getAuthenticatedApiContext(request, env);
        try {
            await test.step('The tier assertion of the configs still holds (authenticated local-backend check under TIER_KIND=local); one worker', async () => {
                await assertRunTierLive(raw);
                expect(testInfo.config.workers, 'the REG / API suites run on one worker').toBe(1);
            });
            const own = guardApi(raw);
            if (isLocalTier()) {
                await test.step('Local stack: a run-prefixed role created through BASE_URL is read back through REG_LOCAL_CORE_URL (instance proof, Q4)', async () => {
                    await proveLocalInstance(raw, process.env, {
                        createRole: async () => recordCreated('roles', await createRole(own, regName(`instance-${Date.now().toString(36)}`)), SPEC, 'local instance proof (Q4)'),
                    });
                });
            }
            const role = await test.step('Create a run-prefixed role through the guarded API; the ledger line comes first', async () =>
                recordCreated('roles', await createRole(own, regName(`guard-${Date.now().toString(36)}`)), SPEC, 'guard proof (review S3)'));

            await test.step('The guard accepts it (ledger + live name); a run-prefixed name without a ledger line is refused', async () => {
                expect(isOwn(role), 'own: created line of this run and the run prefix').toBe(true);
                await assertOwnLive(raw, 'roles', role, 'guard-proof');
                expect(() => assertOwn({ uuid: randomUUID(), name: regName('not-in-the-ledger') }, 'guard-proof')).toThrow(OwnObjectViolation);
            });

            await test.step('The guard refuses a role that existed before the run (ledger and live)', async () => {
                const roles = (await snapshotTier(raw, { only: ['roles'] })).resources.roles;
                expect(roles.error, 'roles are readable').toBeUndefined();
                const uuid = Object.keys(roles.foreign)[0];
                expect(uuid, 'the tier has at least one pre-existing role').toBeTruthy();
                expect(isOwn({ uuid })).toBe(false);
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
                const watched = blockingSpy(raw);
                // A forged OwnRef and the guard layer removed on purpose: the helper's own assertOwnLive must refuse.
                const forged = { uuid: raUuid, name: regName('forged'), kind: 'own' } as OwnRef;
                // The refusal must be for OWNERSHIP (fix pass 3): the brand of a raw context or a path rule would hide a broken check.
                const helperRefusal = await ownershipRefusal(enableOwnRaProfile(watched.api as unknown as GuardedApi, authorityUuid, forged));
                expect(helperRefusal.uuid, 'the helper refused the pre-existing RA profile itself').toBe(raUuid);
                // The guarded context over the same spy: PATCH and DELETE refused for ownership (also under the dry run).
                const guarded = guardApi(watched.api);
                expect((await ownershipRefusal(guarded.patch(`/api/v1/authorities/${authorityUuid}/raProfiles/${raUuid}/disable`))).uuid).toBe(raUuid);
                expect((await ownershipRefusal(guarded.delete(`/api/v1/authorities/${authorityUuid}/raProfiles/${raUuid}`))).uuid).toBe(raUuid);
                expect(watched.mutations, 'no request but a read reached the raw context').toEqual([]);
            });

            await test.step('The teardown registry deletes the own role and records a deleted line', async () => {
                if (isDryRun()) {
                    testInfo.annotations.push({ type: 'dry run', description: 'API_TEARDOWN_DRY_RUN: the own role is kept; the run-end dry run lists it' });
                    return;
                }
                const line = assertOwn(role, 'guard-proof');
                await removeOwnObject({ api: raw, runId: RUN_ID, ledger: readLedger() }, line, SPEC);
                const deleted = readLedger().filter((l) => l.uuid === role.uuid && l.runId === RUN_ID && l.event === 'deleted');
                expect(deleted, 'one deleted line for the role').toHaveLength(1);
                expect(isOwn(role), 'a deleted object is no longer own').toBe(false);
                // 404, or (known bug core#2511) a 5xx detail confirmed by the full role list; a 5xx alone never passes.
                const gone = await absenceOf(raw, 'roles', role.uuid, `/api/v1/roles/${role.uuid}`);
                if (gone.knownBug) testInfo.annotations.push({ type: 'known bug', description: `${gone.knownBug.bug}: ${gone.knownBug.note}` });
                expect(gone.absent, `the role is gone (${gone.detail})`).toBe(true);
            });
        } finally {
            await raw.dispose();
        }
    });

    test('API-GEN-33[before]: snapshot the shared tier before the first spec', meta({ id: 'API-GEN-33', prio: 'P1', issue: 'ilm#428' }), async ({ api }, testInfo) => {
        test.skip(isLocalTier(), 'local stack: the non-interference proof runs on shared tiers only');
        // ~30 resources, three of them read as a newest sample plus an oldest window of up to four pages.
        test.setTimeout(180_000);
        expect(process.env.BASE_URL, 'BASE_URL is unset: a run without a tier fails (Q11)').toBeTruthy();
        assertRunTier();
        const file = snapshotBeforeFile();
        const purged = purgeOldSnapshots(regressionStateDir());
        if (purged.length) testInfo.annotations.push({ type: 'purged', description: `${purged.length} snapshot file(s) older than 14 days` });
        // A stale snapshot of an earlier run with the same id must never be compared against.
        removeSnapshot(file);
        const snap = await test.step('Read the total and the pre-existing objects of every resource', async () => snapshotTier(api));
        await test.step('Store it for API-GEN-33 and the run-end teardown', async () => {
            saveSnapshot(snap, file);
            const summary = Object.fromEntries(
                Object.entries(snap.resources).map(([type, r]) => [type, r.error ? `unreadable: ${r.error}` : { total: r.total, stored: Object.keys(r.foreign).length }]),
            );
            await testInfo.attach('snapshot-summary.json', { body: JSON.stringify(summary, null, 2), contentType: 'application/json' });
            for (const [type, r] of Object.entries(snap.resources)) {
                if (r.error) testInfo.annotations.push({ type: 'not protected', description: `${type}: ${r.error}` });
            }
        });
        expect(unreadableRequired(snap), 'required resources must be readable before the run, or the proof is incomplete (R9)').toEqual([]);
    });
});
