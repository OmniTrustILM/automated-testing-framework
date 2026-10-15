/**
 * Merge pass 2026-10-15 — rows for the pieces the merge itself added (nothing here existed in an area sandbox):
 * - item 9: the `scheduledJobs` teardown handler of `schedulerApi` (the registry entry had no export): a job is read (200 → seen),
 *   a system job or a job with another name is refused, a 404 is done, a normal delete proves absence by the same GET;
 * - item 9: `HANDLER_MODULES.scheduledJobs` resolves to a handler (every ledger type a spec records has one: see the merge exit check);
 * - item 9 (fold): `stackConfig` reads both spellings of the compose settings (LOCAL_* and REG_LOCAL_*), the platform names first.
 */
import { expect, test } from '@playwright/test';
import { handlerFor, TeardownContext } from '../../utils/regression/runTeardown';
import { JOBS_URL, teardownHandlers } from '../../utils/regression/schedulerApi';
import { stackConfig } from '../../utils/regression/platformStack';

type Json = Record<string, any>;
const JOB = 'aaaaaaaa-0000-4000-8000-000000000001';
const RUN = 'qa-reg-20261014-120000-ab12';
const line = (name = `${RUN}-job`) => ({ type: 'scheduledJobs', uuid: JOB, name, event: 'created' as const, runId: RUN }) as any;

/** A fake API over one job: GET / DELETE with a call log. */
function fakeApi(job: Json | undefined, opts: { deleteStatus?: number; stillThere?: boolean } = {}) {
    const calls: string[] = [];
    let present = job !== undefined;
    const reply = (status: number, body?: unknown) => ({ status: () => status, ok: () => status >= 200 && status < 300, json: async () => body, text: async () => JSON.stringify(body ?? '') });
    const api = {
        get: async (url: string) => { calls.push(`GET ${url}`); return present ? reply(200, job) : reply(404, {}); },
        delete: async (url: string) => { calls.push(`DELETE ${url}`); const s = opts.deleteStatus ?? 204; if (s < 300 && !opts.stillThere) present = false; return reply(s, {}); },
    };
    return { api, calls };
}

const ctxOf = (api: unknown): TeardownContext => ({ api: api as any, runId: RUN, ledger: [line()], seen: new Set(), tier: null, warn: () => undefined, pollMs: 1 });

test('scheduledJobs handler: a 404 is done without a delete; a system job and a job with another name are refused with nothing deleted', async () => {
    const gone = fakeApi(undefined);
    await teardownHandlers.scheduledJobs.remove(ctxOf(gone.api), line());
    expect(gone.calls).toEqual([`GET ${JOBS_URL}/${JOB}`]);

    const system = fakeApi({ uuid: JOB, jobName: `${RUN}-job`, system: true });
    await expect(teardownHandlers.scheduledJobs.remove(ctxOf(system.api), line())).rejects.toThrow(/system job/);
    expect(system.calls.some((c) => c.startsWith('DELETE'))).toBe(false);

    const other = fakeApi({ uuid: JOB, jobName: 'someone-elses-job', system: false });
    await expect(teardownHandlers.scheduledJobs.remove(ctxOf(other.api), line())).rejects.toThrow(/name is not the ledger line/);
    expect(other.calls.some((c) => c.startsWith('DELETE'))).toBe(false);
});

test('scheduledJobs handler: an own job is read (200), deleted once and proven gone by the same GET; a delete that is refused or leaves the job fails the step', async () => {
    const ok = fakeApi({ uuid: JOB, jobName: `${RUN}-job`, system: false });
    const ctx = ctxOf(ok.api);
    await teardownHandlers.scheduledJobs.remove(ctx, line());
    expect(ok.calls).toEqual([`GET ${JOBS_URL}/${JOB}`, `DELETE ${JOBS_URL}/${JOB}`, `GET ${JOBS_URL}/${JOB}`]);
    expect(ctx.seen.has(JOB)).toBe(true);

    const executing = fakeApi({ uuid: JOB, jobName: `${RUN}-job` }, { deleteStatus: 422 });
    await expect(teardownHandlers.scheduledJobs.remove(ctxOf(executing.api), line())).rejects.toThrow(/Failed to delete scheduled job.*422/);

    const stuck = fakeApi({ uuid: JOB, jobName: `${RUN}-job` }, { stillThere: true });
    await expect(teardownHandlers.scheduledJobs.remove(ctxOf(stuck.api), line())).rejects.toThrow(/absence not proven/);
});

test('the registry resolves scheduledJobs to the schedulerApi handler (wrapped by guardHandler); its plan line names the scheduler route', () => {
    const h = handlerFor('scheduledJobs');
    expect(h, 'a handler for scheduledJobs').toBeDefined();
    expect(h!.action).toMatch(/scheduler\/jobs/);
});

test('stackConfig reads LOCAL_* first and REG_LOCAL_* as the alias (the names the tier proof and the auth area documented)', () => {
    expect(stackConfig({ REG_LOCAL_COMPOSE_PROJECT: 'ilm', REG_LOCAL_COMPOSE_FILE: '/abs/c.yml', REG_LOCAL_SERVICE_CORE: 'core-api' } as NodeJS.ProcessEnv))
        .toMatchObject({ project: 'ilm', composeFile: '/abs/c.yml', services: { core: 'core-api' } });
    expect(stackConfig({ LOCAL_COMPOSE_PROJECT: 'a', REG_LOCAL_COMPOSE_PROJECT: 'b', LOCAL_SERVICE_CORE: 'x', REG_LOCAL_SERVICE_CORE: 'y' } as NodeJS.ProcessEnv))
        .toMatchObject({ project: 'a', services: { core: 'x' } });
    expect(stackConfig({} as NodeJS.ProcessEnv)).toMatchObject({ project: undefined, composeFile: undefined, services: { core: 'core' } });
});
