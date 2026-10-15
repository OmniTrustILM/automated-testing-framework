/**
 * REG-DISC-12 — a ONE-TIME scheduled discovery on both generations (`@local`; ilm#432 steps 6–7; T8 S5, SC3, SC7; B7 rules 47–52; P-D12):
 * the job runs on time, each run is listed in the job's history, and the job removes itself from the scheduler on success.
 *
 * Local stack only: a schedule runs for everyone, a FAILED one-time job is NOT unscheduled and keeps firing on its cron, and the
 * platform has no way to cancel a firing (open question: one-time on shared tiers). The target is the run's own TLS listener
 * (`@needs:scan-target`). The own job is deleted in `finally`; its runs are own discoveries (names carry the prefix) recorded
 * before any assertion, and the NEW certificates they onboard are `derived` ledger lines.
 *
 *   cron every 2 minutes (6 fields, seconds first, UTC): `scheduleState` scheduled and `nextFireTime` within ~2 minutes
 *   at the tick: history STARTED then SUCCEEDED, `resultObjectType` Discovery and its uuid; a NEW discovery `<name>_<timestamp>` exists
 *   and completes; afterwards the job is `notScheduled` and no second run appears at the next tick
 *   NOT asserted: delete while the job is executing → 422 "Unable to delete scheduled job while it is executing. Wait for the current run
 *   to finish." (T8 B7 rule 52): the window is seconds wide and a missed window would delete the job under test; the text is annotated
 *   when the `finally` delete happens to hit it
 *   a second schedule with the same job name answers 201 with the FIRST job (observation, T8 E13: the new cron / data are ignored)
 */
import { expect, test } from '../../fixtures/testFixtures';
import {
    adoptJobRun, deleteJob, DiscoveryConnector, findDiscoveryConnectors, Generation, generationGate, getJob, getJobHistory, getDiscovery, recordOnboarded, runsOfJob, scheduleDiscovery,
    waitForCompleted,
} from '../../utils/regression/discoveryApi';
import { getGuardedApiContext } from '../../utils/regression/guardedApi';
import type { GuardedApi } from '../../utils/regression/guardedApi';
import { describeLocal } from '../../utils/regression/tier';
import { scanTargetProblem, startTlsTarget, TlsTarget } from '../../utils/regression/tlsTarget';
import { assertHeldFor, errorTexts, pollUntil } from '../../utils/regression/workflowApi';
import { meta } from '../../utils/regression/tags';

const SPEC = 'REG-DISC-12';

test.describe('@regression REG-DISC-12 one-time scheduled discovery', () => {
    describeLocal(test);
    // `@local` rows lift the guard's ownership rule on a proven local stack only (`localStack`, `describeLocal`): the guarded
    // context is built per test here, since a spec may not `test.use` the guard options.
    let api: GuardedApi;
    test.beforeEach(async ({ request, env }) => {
        api = await getGuardedApiContext(request, env, { localStack: true });
    });
    test.afterEach(async () => {
        await api?.dispose();
    });
    let target: TlsTarget | undefined;
    test.afterEach(async () => {
        await target?.close();
        target = undefined;
    });

    for (const generation of ['v1', 'v2'] as Generation[]) {
        test(`REG-DISC-12[${generation}]: a one-time ${generation} job runs at its tick, lists its run in the history and unschedules itself`,
            meta({
                id: 'REG-DISC-12', prio: 'P1', issue: 'ilm#432', local: true, phaseB: true, needs: ['scan-target', `${generation}-discovery`],
                rule: [
                    'T8 B7 rules 47–52 (schedule validates like create, registers the job; every tick creates `<name>_<timestamp>`; STARTED → SUCCEEDED; a one-time job unschedules itself on SUCCESS; delete refused while executing)',
                    'T8 SC3, SC7, E13 (the same job name returns the first job); ilm#432 steps 6–7',
                ],
            }),
            async () => {
                test.setTimeout(900_000);
                const problem = scanTargetProblem();
                test.skip(!!problem, problem ?? '');
                const tier = await findDiscoveryConnectors(api);
                const gate = generationGate(tier, generation);
                test.skip(gate !== undefined, gate ?? '');
                const connector: DiscoveryConnector = tier[generation]!;
                target = await startTlsTarget({ listeners: 1, withIntermediate: true, stem: `scan-sched-${generation}` });
                const { job, sent } = await scheduleDiscovery(api, SPEC, connector, {
                    suffix: `disc12-${generation}`, cron: '0 */2 * * * ?', oneTime: true, target: { hosts: [target.ipAttribute()], ports: target.ports.map(String), parallel: 1 },
                });
                try {
                    expect(sent.status, 'the schedule request answers 201').toBe(201);

                    await test.step('The job is scheduled with a next fire time within two minutes', async () => {
                        const detail = await getJob(api, job.uuid);
                        expect(detail).toMatchObject({ jobName: job.name, oneTime: true, enabled: true, scheduleState: 'scheduled' });
                        const untilNext = Date.parse(detail.nextFireTime) - Date.now();
                        expect(untilNext, `nextFireTime ${detail.nextFireTime} is at most ~2 minutes away (clock skew tolerated)`).toBeLessThanOrEqual(150_000);
                        expect(untilNext).toBeGreaterThan(-60_000);
                    });

                    await test.step('A second schedule with the same job name returns the first job (the new cron is ignored: T8 E13)', async () => {
                        const second = await scheduleDiscovery(api, SPEC, connector, {
                            suffix: `disc12-${generation}-again`, cron: '0 0 0 1 1 ? 2099', oneTime: true, jobName: job.name, target: { hosts: ['192.0.2.8/29'], parallel: 10 },
                        }).catch((e) => ({ error: String(e) }));
                        if ('error' in second) test.info().annotations.push({ type: 'observation', description: `the repeated schedule was refused: ${second.error.slice(0, 200)}` });
                        else {
                            expect(second.job.uuid, 'the answer names the FIRST job').toBe(job.uuid);
                            expect((await getJob(api, job.uuid)).cronExpression, 'the first cron stays').toBe('0 */2 * * * ?');
                        }
                    });

                    const history = await test.step('At the tick the history shows the run: STARTED, then SUCCEEDED with the discovery as the result object', async () => {
                        const rows = await pollUntil(() => getJobHistory(api, job.uuid), (h) => h.some((r) => r.status === 'succeeded'), { what: 'a SUCCEEDED history row', timeoutMs: 420_000, intervalMs: 5_000 });
                        const started = rows.find((r) => r.status === 'started') ?? rows[0];
                        const done = rows.find((r) => r.status === 'succeeded')!;
                        expect(started, 'a history row for the run').toBeTruthy();
                        expect(done.resultObjectType, 'the result object is a Discovery').toBe('discoveries');
                        expect(done.resultObjectIdentification?.length ?? 0).toBeGreaterThan(0);
                        return rows;
                    });

                    await test.step('A NEW discovery named <name>_<timestamp> exists, is recorded and completes', async () => {
                        const runs = await runsOfJob(api, job.discoveryName);
                        expect(runs, 'exactly one run per tick so far').toHaveLength(1);
                        expect(runs[0].name).toMatch(new RegExp(`^${job.discoveryName}_\\d{4}-\\d{2}-\\d{2}_\\d{2}-\\d{2}-\\d{2}`));
                        const run = adoptJobRun(runs[0], SPEC);
                        await waitForCompleted(api, run.uuid, 300_000);
                        await recordOnboarded(api, SPEC, run);
                        expect((await getDiscovery(api, run.uuid)).status).toBe('completed');
                    });

                    await test.step('The one-time job unschedules itself and no second run appears at the next tick', async () => {
                        const detail = await pollUntil(() => getJob(api, job.uuid), (d) => d.scheduleState === 'notScheduled', { what: 'scheduleState notScheduled', timeoutMs: 60_000, intervalMs: 3_000 });
                        expect(detail.scheduleState).toBe('notScheduled');
                        // "No second run" is an absence: only the clock can show it, so the window of one full cron interval stays, but API state is
                        // read THROUGH it every 10 s and asserted on each read (a second tick fails at the read that sees it, not after one sleep).
                        const startedBefore = history.filter((h) => h.status === 'started').length;
                        const reads = await assertHeldFor({ forMs: 130_000, everyMs: 10_000 }, async () => {
                            expect(await runsOfJob(api, job.discoveryName), 'still one run: the job is gone from the scheduler').toHaveLength(1);
                            expect((await getJobHistory(api, job.uuid)).filter((h) => h.status === 'started'), 'no second STARTED row').toHaveLength(startedBefore);
                            expect((await getJob(api, job.uuid)).scheduleState, 'the job stays unscheduled').toBe('notScheduled');
                        });
                        test.info().annotations.push({ type: 'absence-window', description: `${reads} reads over 130 s, every 10 s` });
                    });
                } finally {
                    const del = await deleteJob(api, job, SPEC);
                    if (del.status === 422) test.info().annotations.push({ type: 'delete-while-executing', description: errorTexts(del).join(' | ') });
                }
            });
    }
});

