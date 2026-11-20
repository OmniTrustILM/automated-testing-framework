/**
 * API-CORE-01, API-CORE-04 — The scheduler lists exactly the six system jobs with their UTC Quartz crons and reachable schedules, and a
 * system job refuses a cron update and a delete (422). ilm#433. The refusal row runs only on a proven local stack.
 */
import { expect, test } from '../../../fixtures/regressionFixtures';
import { expect422Messages } from '../../../utils/regression/errorContract';
import { deleteJob, getJob, isFireTime, jobFingerprint, listJobs, nextFireUtc, SYSTEM_JOB_NAMES, SYSTEM_JOBS, systemJobProblems, systemJobsOf, updateJobCron } from '../../../utils/regression/platform/schedulerApi';
import { testMeta, tags } from '../../../utils/regression/tags';
import { describeLocalOnly } from '../../../utils/regression/tier/localProof';
import { API_READ_TEST_MS, API_SHORT_TEST_MS } from '../../../utils/regression/timeouts';

test.describe('Scheduler jobs', { tag: tags.api }, () => {
    test('the job list holds exactly the six system jobs with their UTC schedules',
        testMeta({
            id: 'API-CORE-01', prio: 'P1', issue: 'ilm#433',
            rule: [
                'six system jobs registered at boot, Quartz crons in UTC',
                'observed scheduleState mapping; every job unknown = scheduler unreachable, still 200; the zone is UTC',
            ],
        }),
        async ({ api }, testInfo) => {
            test.setTimeout(API_READ_TEST_MS);
            const jobs = await test.step('List the jobs', async () => listJobs(api));
            const system = systemJobsOf(jobs);
            expect(systemJobProblems(jobs), 'the system jobs equal the system-job table (names, crons, oneTime, jobType)').toEqual([]);
            expect(system.map((j) => String(j.jobName)).sort(), 'exactly the six system jobs').toEqual([...SYSTEM_JOB_NAMES].sort());

            await test.step('The scheduler answered: not every job is unknown', async () => {
                const states = jobs.map((j) => String(j.scheduleState));
                testInfo.annotations.push({ type: 'schedule-states', description: states.join(', ') });
                expect(jobs.length > 0 && states.every((s) => s === 'unknown'), 'scheduler unreachable: every job reports scheduleState unknown').toBe(false);
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
                    expect(String(job.nextFireTime ?? ''), `${expected.jobName}: nextFireTime is an ISO date-time`).toMatch(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}/);
                    const next = new Date(String(job.nextFireTime));
                    expect(next.getTime(), `${expected.jobName}: nextFireTime ${job.nextFireTime} is in the future`).toBeGreaterThan(now.getTime() - 60_000);
                    expect(isFireTime(expected.cron, next), `${expected.jobName}: ${job.nextFireTime} is a fire time of "${expected.cron}" in UTC`).toBe(true);
                    // a minute ahead of now: a job that fired in the last minute already points at its following fire
                    const computed = nextFireUtc(expected.cron, new Date(now.getTime() + 60_000));
                    expect(next.getTime(), `${expected.jobName}: nextFireTime is not later than the next fire computed from now (${computed.toISOString()})`).toBeLessThanOrEqual(computed.getTime());
                    if (job.previousFireTime) {
                        expect(new Date(String(job.previousFireTime)).getTime(), `${expected.jobName}: previousFireTime is not in the future`).toBeLessThanOrEqual(now.getTime() + 60_000);
                    }
                }
            });
        });

    test.describe('scheduler system jobs on the local stack', () => {
        describeLocalOnly(test);

        test('a system job refuses a cron update and a delete and stays unchanged',
            testMeta({
                id: 'API-CORE-04', prio: 'P1', issue: 'ilm#433', local: true,
                rule: [
                    'system jobs: only delete and cron edit are forbidden (SchedulerServiceImpl "Unable to delete system job.", "Cannot updated system job.")',
                ],
            }),
            async ({ localApi }) => {
                test.setTimeout(API_SHORT_TEST_MS);
                const jobs = await listJobs(localApi);
                const job = systemJobsOf(jobs).find((j) => String(j.jobName) === SYSTEM_JOBS[0].jobName);
                expect(job, `${SYSTEM_JOBS[0].jobName} is registered as a system job`).toEqual(expect.objectContaining({ jobName: SYSTEM_JOBS[0].jobName, system: true }));
                const before = jobFingerprint(await getJob(localApi, String(job!.uuid)));

                await test.step('PUT with the current cron → 422 ["Cannot updated system job."]', async () => {
                    const res = await updateJobCron(localApi, String(job!.uuid), String(before.cronExpression));
                    const text = await res.text();
                    expect(res.status(), text.slice(0, 300)).toBe(422);
                    expect(expect422Messages(text)).toContain('Cannot updated system job.');
                });

                await test.step('DELETE → 422 ["Unable to delete system job."]', async () => {
                    const res = await deleteJob(localApi, String(job!.uuid));
                    const text = await res.text();
                    expect(res.status(), text.slice(0, 300)).toBe(422);
                    expect(expect422Messages(text)).toContain('Unable to delete system job.');
                });

                await test.step('The detail is unchanged and the system set is still six', async () => {
                    expect(jobFingerprint(await getJob(localApi, String(job!.uuid)))).toEqual(before);
                    expect(systemJobsOf(await listJobs(localApi)).length).toBe(6);
                });
            });
    });
});
