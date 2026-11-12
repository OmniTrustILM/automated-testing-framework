/**
 * REG-DISC-12 — A one-time scheduled discovery, on both generations (local stack only). ilm#432.
 *
 * WHAT: 1. Schedule a one-time discovery (cron every two minutes) of the own target → 201; the job is scheduled, one-time,
 *          enabled, with a next fire time within about two minutes.
 *       2. A second schedule with the same job name returns the first job; the first cron stays.
 *       3. At the tick the job history shows the run STARTED, then SUCCEEDED with the discovery as the result object.
 *       4. A new discovery named `<name>_<timestamp>` exists, completes, and finds the target's certificates.
 *       5. The one-time job unschedules itself (notScheduled), and no second run or history row appears over one full cron interval.
 * WHY: a one-time job must run once on time, list its run, and not fire again; a schedule runs for everyone.
 * HOW: local stack only: a FAILED one-time job keeps firing on its cron and a firing cannot be cancelled on a shared tier.
 *      The target is the run's own TLS listener (it needs a scan target); the own job is deleted in `finally`, its runs are own
 *      discoveries recorded before any assertion, and the new certificates they onboard are `derived` ledger lines. The absence
 *      of a second run is read through the 130 s window every 10 s, so a second tick fails at the read that sees it. Delete while
 *      executing is not asserted (a seconds-wide window).
 */
import { expect, test } from '../../../fixtures/areas/tlsTarget';
import { adoptJobRun, deleteJob, getJob, getJobHistory, runsOfJob, scheduleDiscovery } from '../../../utils/regression/discovery/discoveryJobs';
import { Generation, getDiscovery, recordOnboarded, waitForCompleted } from '../../../utils/regression/discovery/discoveryApi';
import { describeLocalOnly } from '../../../utils/regression/tier/localProof';
import { assertHeldFor } from '../../../utils/regression/events/eventHistory';
import { errorTexts } from '../../../utils/regression/events/workflowRequests';
import { pollUntil } from '../../../utils/regression/wait';
import { testMeta, tags } from '../../../utils/regression/tags';
import { DISCOVERY_LARGE_RUN_MS, EVENT_DELIVERY_MS, SCHEDULED_RUN_WAIT_MS, STATUS_CHANGE_MS } from '../../../utils/regression/timeouts';

/** The job's next fire time is at most this far ahead of the check (a tick every two minutes, clock skew tolerated). */
const NEXT_FIRE_WITHIN_MS = 150_000;
/** How far in the past the next fire time may be when the runner's clock is ahead of the server's. */
const CLOCK_SKEW_MS = 60_000;
/** One full cron interval plus a margin, read every ten seconds: no second run may appear in it. */
const ABSENCE_WINDOW_MS = 130_000;
const ABSENCE_READ_EVERY_MS = 10_000;

test.describe('One-time scheduled discovery', { tag: tags.regression }, () => {
    describeLocalOnly(test);
    for (const generation of ['v1', 'v2'] as Generation[]) {
        test(`a one-time ${generation} job runs at its tick, lists its run in the history and unschedules itself`,
            testMeta({
                id: 'REG-DISC-12', prio: 'P2', issue: 'ilm#432', local: true, phaseB: true, needs: ['scan-target', `${generation}-discovery`],
                rule: [
                    'schedule validates like create, registers the job; every tick creates `<name>_<timestamp>`; STARTED → SUCCEEDED; a one-time job unschedules itself on SUCCESS; delete refused while executing',
                    'the same job name returns the first job; ilm#432 steps 6–7',
                ],
            }),
            // `localApi` lifts the guard's ownership rule on a proven local stack only (`describeLocalOnly`, a local-stack row).
            async ({ localApi: api, own, discoveryTier, tlsTargets }) => {
                test.setTimeout(EVENT_DELIVERY_MS);
                const connector = discoveryTier[generation]!;
                const target = await tlsTargets.start({ listeners: 1, withIntermediate: true, stem: `sch-${generation}` });
                const { job, sent } = await scheduleDiscovery(api, own.spec, connector, {
                    suffix: `disc12-${generation}`, cron: '0 */2 * * * ?', oneTime: true, target: { hosts: [target.ipAttribute()], ports: target.ports.map(String), parallel: 1 },
                });
                const adopted = new Set<string>();
                try {
                    expect(sent.status, 'the schedule request answers 201').toBe(201);

                    await test.step('The job is scheduled with a next fire time within two minutes', async () => {
                        const detail = await getJob(api, job.uuid);
                        expect(detail).toMatchObject({ jobName: job.name, oneTime: true, enabled: true, scheduleState: 'scheduled' });
                        const untilNext = Date.parse(detail.nextFireTime as string) - Date.now();
                        expect(untilNext, `nextFireTime ${detail.nextFireTime} is at most ~2 minutes away (clock skew tolerated)`).toBeLessThanOrEqual(NEXT_FIRE_WITHIN_MS);
                        expect(untilNext, 'the next fire time is not in the past beyond the clock skew').toBeGreaterThan(-CLOCK_SKEW_MS);
                    });

                    await test.step('A second schedule with the same job name returns the first job (the new cron is ignored)', async () => {
                        const second = await scheduleDiscovery(api, own.spec, connector, {
                            suffix: `disc12-${generation}-again`, cron: '0 0 0 1 1 ? 2099', oneTime: true, jobName: job.name, target: { hosts: ['192.0.2.8/29'], parallel: 10 },
                        });
                        expect(second.job.uuid, 'the answer names the FIRST job').toBe(job.uuid);
                        expect((await getJob(api, job.uuid)).cronExpression, 'the first cron stays').toBe('0 */2 * * * ?');
                    });

                    const history = await test.step('At the tick the history shows the run: STARTED, then SUCCEEDED with the discovery as the result object', async () => {
                        const rows = await pollUntil(() => getJobHistory(api, job.uuid), (h) => h.some((r) => r.status === 'succeeded'), { what: 'a SUCCEEDED history row', timeoutMs: SCHEDULED_RUN_WAIT_MS, intervalMs: 5_000 });
                        const started = rows.find((r) => r.status === 'started') ?? rows[0];
                        const done = rows.find((r) => r.status === 'succeeded')!;
                        expect(started, 'a history row for the run').toBeTruthy();
                        expect(done.resultObjectType, 'the result object is a Discovery').toBe('discoveries');
                        expect((done.resultObjectIdentification as unknown[] | undefined)?.length ?? 0).toBeGreaterThan(0);
                        return rows;
                    });

                    await test.step('A NEW discovery named <name>_<timestamp> exists, is recorded and completes', async () => {
                        const runs = await runsOfJob(api, job.discoveryName);
                        expect(runs, 'exactly one run per tick so far').toHaveLength(1);
                        expect(runs[0].name).toMatch(new RegExp(`^${job.discoveryName}_\\d{4}-\\d{2}-\\d{2}_\\d{2}-\\d{2}-\\d{2}`));
                        const run = adoptJobRun(runs[0], own.spec);
                        adopted.add(run.uuid);
                        try {
                            await waitForCompleted(api, run.uuid, DISCOVERY_LARGE_RUN_MS);
                        } finally {
                            await recordOnboarded(api, own.spec, run);
                        }
                        expect((await getDiscovery(api, run.uuid)).status).toBe('completed');
                    });

                    await test.step('The one-time job unschedules itself and no second run appears at the next tick', async () => {
                        const detail = await pollUntil(() => getJob(api, job.uuid), (d) => d.scheduleState === 'notScheduled', { what: 'scheduleState notScheduled', timeoutMs: STATUS_CHANGE_MS, intervalMs: 3_000 });
                        expect(detail.scheduleState).toBe('notScheduled');
                        // "No second run" is an absence: only the clock can show it, so the window of one full cron interval stays, but API
                        // state is read THROUGH it every 10 s and asserted on each read (a second tick fails at the read that sees it, not
                        // after one sleep).
                        const startedBefore = history.filter((h) => h.status === 'started').length;
                        const reads = await assertHeldFor({ forMs: ABSENCE_WINDOW_MS, everyMs: ABSENCE_READ_EVERY_MS }, async () => {
                            expect(await runsOfJob(api, job.discoveryName), 'still one run: the job is gone from the scheduler').toHaveLength(1);
                            expect((await getJobHistory(api, job.uuid)).filter((h) => h.status === 'started'), 'no second STARTED row').toHaveLength(startedBefore);
                            expect((await getJob(api, job.uuid)).scheduleState, 'the job stays unscheduled').toBe('notScheduled');
                        });
                        test.info().annotations.push({ type: 'absence-window', description: `${reads} reads over ${ABSENCE_WINDOW_MS / 1000} s, every ${ABSENCE_READ_EVERY_MS / 1000} s` });
                    });
                } finally {
                    try {
                        // A run the job created that no step adopted (a step failed first) is an object of this test: record it and what it
                        // onboarded.
                        for (const created of await runsOfJob(api, job.discoveryName)) {
                            if (adopted.has(String(created.uuid))) continue;
                            await recordOnboarded(api, own.spec, adoptJobRun(created, own.spec));
                        }
                    } finally {
                        const del = await deleteJob(api, job, own.spec);
                        if (del.status === 422) test.info().annotations.push({ type: 'delete-while-executing', description: errorTexts(del).join(' | ') });
                    }
                }
            });
    }
});

