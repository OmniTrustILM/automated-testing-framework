/**
 * API-CORE-01 / API-CORE-04 — the scheduler jobs API (ilm#433, T9; platform area).
 *
 * API-CORE-01 (shared tier, read-only): `GET /v1/scheduler/jobs` lists exactly the six system jobs of P-JOBS with their
 * UTC Quartz crons, `system = true`, `oneTime = false`, a non-empty `jobType`; an enabled job is `scheduled` with a
 * `nextFireTime` in the future that IS a fire time of its cron in UTC (a scheduler on another zone fails the daily /
 * weekly jobs, J12) and not later than the next fire computed from now; `previousFireTime` is not in the future; a
 * list where every job is `unknown` means the scheduler is unreachable (A3 r12) and fails by name.
 *
 * API-CORE-04 (local stack first, OQ-7): a system job refuses a cron edit (even with its CURRENT cron) and a delete
 * with the fixed 422 texts, and its detail is byte-identical before and after. `/v1/scheduler` is platform-denied by
 * the guard; the local block lifts it with `getGuardedApiContext(request, env, { localStack: true })` on a proven local
 * stack only (describeLocal).
 */
import { expect, test } from '../../fixtures/testFixtures';
import { expect422Messages } from '../../utils/regression/errorContract';
import { getGuardedApiContext } from '../../utils/regression/guardedApi';
import { deleteJob, getJob, isFireTime, jobFingerprint, listJobs, nextFireUtc, SYSTEM_JOB_NAMES, SYSTEM_JOBS, systemJobProblems, systemJobsOf, updateJobCron } from '../../utils/regression/schedulerApi';
import { meta, tags } from '../../utils/regression/tags';
import { describeLocal } from '../../utils/regression/tier';

test.describe('API-CORE scheduler jobs', { tag: tags.api }, () => {
    test('API-CORE-01: GET /v1/scheduler/jobs lists exactly the six system jobs with their UTC crons, flags, schedule state and fire times',
        meta({
            id: 'API-CORE-01', prio: 'P1', issue: 'ilm#433',
            rule: [
                'platform-keys-connectors A3 r1 (six system jobs registered at boot, Quartz crons in UTC: P-JOBS)',
                'platform-keys-connectors A3 r12 (observed scheduleState mapping; every job unknown = scheduler unreachable, still 200), §3.4; J12 (zone)',
            ],
        }),
        async ({ api }, testInfo) => {
            test.setTimeout(30_000);
            const jobs = await test.step('List the jobs', async () => listJobs(api));
            const system = systemJobsOf(jobs);
            expect(systemJobProblems(jobs), 'the system jobs equal P-JOBS (names, crons, oneTime, jobType)').toEqual([]);
            expect(system.map((j) => String(j.jobName)).sort(), 'exactly the six system jobs').toEqual([...SYSTEM_JOB_NAMES].sort());

            await test.step('The scheduler answered: not every job is unknown', async () => {
                const states = jobs.map((j) => String(j.scheduleState));
                testInfo.annotations.push({ type: 'schedule-states', description: states.join(', ') });
                expect(jobs.length > 0 && states.every((s) => s === 'unknown'), 'scheduler unreachable: every job reports scheduleState unknown (A3 r12)').toBe(false);
            });

            await test.step('Each enabled system job is scheduled, its next fire is a fire time of its cron in UTC and not later than the next one from now', async () => {
                const now = new Date();
                for (const expected of SYSTEM_JOBS) {
                    const job = system.find((j) => String(j.jobName) === expected.jobName)!;
                    if (job.enabled !== true) {
                        testInfo.annotations.push({ type: 'disabled-system-job', description: `${expected.jobName} is disabled on this tier (scheduleState ${job.scheduleState})` });
                        continue;
                    }
                    expect(job.scheduleState, `${expected.jobName}: scheduleState`).toBe('scheduled');
                    expect(job.nextFireTime, `${expected.jobName}: nextFireTime present`).toBeTruthy();
                    const next = new Date(String(job.nextFireTime));
                    expect(next.getTime(), `${expected.jobName}: nextFireTime ${job.nextFireTime} is in the future`).toBeGreaterThan(now.getTime() - 60_000);
                    expect(isFireTime(expected.cron, next), `${expected.jobName}: ${job.nextFireTime} is a fire time of "${expected.cron}" in UTC`).toBe(true);
                    const computed = nextFireUtc(expected.cron, new Date(now.getTime() - 60_000));
                    expect(next.getTime(), `${expected.jobName}: nextFireTime is not later than the next fire computed from now (${computed.toISOString()})`).toBeLessThanOrEqual(computed.getTime() + 60_000);
                    if (job.previousFireTime) {
                        expect(new Date(String(job.previousFireTime)).getTime(), `${expected.jobName}: previousFireTime is not in the future`).toBeLessThanOrEqual(now.getTime() + 60_000);
                    }
                }
            });
        });

    test.describe('API-CORE-04 on the local stack (OQ-7: promoted to a shared tier only after a recorded local proof)', () => {
        describeLocal(test);

        test('API-CORE-04: a system job refuses a cron update (its current cron) and a delete with the fixed 422 texts; its detail is unchanged and the system set stays six',
            meta({
                id: 'API-CORE-04', prio: 'P1', issue: 'ilm#433', local: true,
                rule: [
                    'platform-keys-connectors A3 r6 (system jobs: only delete and cron edit are forbidden), r8 (delete guard), §3.3 (SchedulerServiceImpl:183-184 "Unable to delete system job.", :250 "Cannot updated system job.")',
                ],
            }),
            async ({ request, env }) => {
                test.setTimeout(60_000);
                const api = await getGuardedApiContext(request, env, { localStack: true });
                try {
                    const jobs = await listJobs(api);
                    const job = systemJobsOf(jobs).find((j) => String(j.jobName) === SYSTEM_JOBS[0].jobName);
                    expect(job, `${SYSTEM_JOBS[0].jobName} is registered`).toBeTruthy();
                    const before = jobFingerprint(await getJob(api, String(job!.uuid)));

                    await test.step('PUT with the current cron → 422 ["Cannot updated system job."]', async () => {
                        const res = await updateJobCron(api, String(job!.uuid), String(before.cronExpression));
                        const text = await res.text();
                        expect(res.status(), text.slice(0, 300)).toBe(422);
                        expect(expect422Messages(text)).toContain('Cannot updated system job.');
                    });

                    await test.step('DELETE → 422 ["Unable to delete system job."]', async () => {
                        const res = await deleteJob(api, String(job!.uuid));
                        const text = await res.text();
                        expect(res.status(), text.slice(0, 300)).toBe(422);
                        expect(expect422Messages(text)).toContain('Unable to delete system job.');
                    });

                    await test.step('The detail is unchanged and the system set is still six', async () => {
                        expect(jobFingerprint(await getJob(api, String(job!.uuid)))).toEqual(before);
                        expect(systemJobsOf(await listJobs(api)).length).toBe(6);
                    });
                } finally {
                    await api.dispose();
                }
            });
    });
});
