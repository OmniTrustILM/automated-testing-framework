/**
 * API-DISC-03 — The state rules of a v2 discovery run. ilm#432, ilm#267, core#2269.
 *
 * WHAT: 1. The own run starts in progress, is stoppable and names its connector interface.
 *       2. Resume on In Progress → 422; stop → 204 and the run is stopped; stop on Stopped → 422; resume → 204 and the run is in progress
 *          again.
 *       3. Cancel → 204 and the run is cancelled (status and connectorStatus); stop, resume and cancel on Cancelled → 422 each.
 *       4. Stop, resume and cancel on a completed own run → 422 each; stop on a random uuid → 404 "Object of type 'Discovery' identified by
 *          <uuid> is not found.".
 *       After every refusal the run is read again and is unchanged.
 * WHY: stop works only in progress, resume only when stopped, cancel in progress or stopped; nothing during processing or in a terminal
 *      state; the 422 text is "Discovery <uuid> is <State> and cannot be …" (ilm#267: which operations a state allows). The Processing
 *      window and `stoppedAt` are not in the detail DTO and are not asserted.
 * HOW: one own run held in progress by a dark scan of RFC 5737 ranges, plus one own completed run; both end terminal and are deleted by the
 *      teardown. `@needs:v2-discovery`: a tier without a healthy v2 registration is skipped with the named deploy gate.
 */
import { expect, test } from '../../../fixtures/regressionFixtures';
import { controlDiscovery, createOwnDiscovery, findDiscoveryConnectors, getDiscovery, RunControl, waitForCompleted, waitForStatus } from '../../../utils/regression/discovery/discoveryApi';
import { DARK_LARGE, DARK_SMALL } from '../../../utils/regression/discovery/tlsTarget';
import { expectRefused } from '../../../utils/regression/errorContract';
import { testMeta, tags } from '../../../utils/regression/tags';
import { DISCOVERY_CONTROL_WAIT_MS, DISCOVERY_DONE_RUN_WAIT_MS, LIFECYCLE_MS } from '../../../utils/regression/timeouts';

const PAST: Record<RunControl, string> = { stop: 'stopped', resume: 'resumed', cancel: 'cancelled' };

test.describe('State transitions of a v2 discovery run', { tag: tags.api }, () => {
    test('legal transitions answer 204 and show the new state, illegal ones answer 422 and change nothing',
        testMeta({
            id: 'API-DISC-03', prio: 'P1', issue: 'ilm#432', needs: ['v2-discovery'],
            rule: [
                'stop only IN_PROGRESS, resume only STOPPED, cancel IN_PROGRESS / STOPPED; nothing during PROCESSING or terminal: 422 "Discovery <uuid> is <State> and cannot be …"',
                'ilm#267 (which operations a state allows); core#2269; unknown uuid → 404 (DiscoveryServiceImpl)',
            ],
        }),
        async ({ api, own }) => {
            test.setTimeout(LIFECYCLE_MS);
            const tier = await findDiscoveryConnectors(api);
            const connector = tier.v2!;
            const run = await createOwnDiscovery(api, own.spec, 'disc03', { connector, target: { hosts: DARK_LARGE.split(','), parallel: 1 } });

            const expectRefusedAndUnchanged = async (uuid: string, op: RunControl, label: string) => {
                const before = await getDiscovery(api, uuid);
                const sent = await controlDiscovery(api, uuid, op);
                expectRefused(sent, { status: 422, text: `Discovery ${uuid} is ${label} and cannot be ${PAST[op]}`, among: true, what: `${op} on a ${label} run` });
                const after = await getDiscovery(api, uuid);
                expect({ status: after.status, connectorStatus: after.connectorStatus }, `the ${label} run is unchanged by the refused ${op}`).toEqual({ status: before.status, connectorStatus: before.connectorStatus });
            };

            await test.step('The run starts IN PROGRESS and is stoppable', async () => {
                const d = await getDiscovery(api, run.uuid);
                expect(d.status).toBe('inProgress');
                expect(d.stoppable, 'the IP discovery connector answers stoppable').toBe(true);
                expect(d.connectorInterface?.version ?? d.connectorInterface?.code, 'a v2 run names its connector interface').toEqual(expect.stringMatching(/\S/));
            });

            await test.step('1 resume on In Progress → 422', async () => expectRefusedAndUnchanged(run.uuid, 'resume', 'In Progress'));

            await test.step('2 stop → 204, the run is stopped', async () => {
                const sent = await controlDiscovery(api, run.uuid, 'stop');
                expect(sent.status, sent.text.slice(0, 200)).toBe(204);
                await waitForStatus(api, run.uuid, 'stopped', DISCOVERY_CONTROL_WAIT_MS);
                expect((await getDiscovery(api, run.uuid)).connectorStatus).toBe('stopped');
            });

            await test.step('3 stop on Stopped → 422', async () => expectRefusedAndUnchanged(run.uuid, 'stop', 'Stopped'));

            await test.step('4 resume → 204, the run is in progress again', async () => {
                const sent = await controlDiscovery(api, run.uuid, 'resume');
                expect(sent.status, sent.text.slice(0, 200)).toBe(204);
                await waitForStatus(api, run.uuid, 'inProgress', DISCOVERY_CONTROL_WAIT_MS);
            });

            await test.step('5 cancel → 204, the run is cancelled (status and connectorStatus)', async () => {
                const sent = await controlDiscovery(api, run.uuid, 'cancel');
                expect(sent.status, sent.text.slice(0, 200)).toBe(204);
                await waitForStatus(api, run.uuid, 'cancelled', DISCOVERY_CONTROL_WAIT_MS);
                expect((await getDiscovery(api, run.uuid)).connectorStatus).toBe('cancelled');
            });

            await test.step('6 stop, resume and cancel on Cancelled → 422 each', async () => {
                for (const op of ['stop', 'resume', 'cancel'] as const) await expectRefusedAndUnchanged(run.uuid, op, 'Cancelled');
            });

            await test.step('7 stop, resume and cancel on a COMPLETED own run → 422 each', async () => {
                const done = await createOwnDiscovery(api, own.spec, 'disc03-done', { connector, target: { hosts: [DARK_SMALL], parallel: 10 } });
                await waitForCompleted(api, done.uuid, DISCOVERY_DONE_RUN_WAIT_MS);
                for (const op of ['stop', 'resume', 'cancel'] as const) await expectRefusedAndUnchanged(done.uuid, op, 'Completed');
            });

            await test.step('8 stop on a random uuid → 404', async () => {
                const unknown = api.probeUuid();
                const sent = await controlDiscovery(api, unknown, 'stop');
                expectRefused(sent, { status: 404, text: `Object of type 'Discovery' identified by ${unknown} is not found.` });
            });
        });
});
