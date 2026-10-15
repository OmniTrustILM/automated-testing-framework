/**
 * API-DISC-03 — the v2 run state matrix on one own run held IN PROGRESS by a dark scan (ilm#432 step 2; §9.5 rule 5; T8 L1, C1,
 * C2; core#2269 D). The run scans three RFC 5737 /24 ranges at parallelism 1 (762 targets, a 500 ms connect timeout: minutes), so
 * every step meets the state it names. After each refusal the run is read again: its `status` and `connectorStatus` are unchanged.
 *
 *   1 resume      In Progress  422 "Discovery <uuid> is In Progress and cannot be resumed"
 *   2 stop        In Progress  204, status `stopped`
 *   3 stop        Stopped      422 "Discovery <uuid> is Stopped and cannot be stopped"
 *   4 resume      Stopped      204, status `inProgress`
 *   5 cancel      In Progress  204, status `cancelled`, connectorStatus `cancelled`
 *   6 stop / resume / cancel   Cancelled   422 "Discovery <uuid> is Cancelled and cannot be stopped|resumed|cancelled"
 *   7 stop / resume / cancel   a COMPLETED own run   422 "… is Completed and cannot be …" (its own dark /29 run)
 *   8 stop        a random uuid  404 "Object of type 'Discovery' identified by <uuid> is not found."
 * The Processing-cancel window (422 "… is Processing and cannot be cancelled") is a matter of seconds and not asserted. `stoppedAt`
 * (set on stop, cleared on resume) is not part of the detail DTO and is not asserted. The run ends CANCELLED (terminal), the
 * completed run COMPLETED: the teardown deletes both. `@needs:v2-discovery`; targets RFC 5737 only.
 */
import { expect, test } from '../../fixtures/testFixtures';
import {
    controlDiscovery, createOwnDiscovery, findDiscoveryConnectors, generationGate, getDiscovery, RunControl, waitForCompleted, waitForStatus,
} from '../../utils/regression/discoveryApi';
import { DARK_LARGE, DARK_SMALL } from '../../utils/regression/tlsTarget';
import { errorShapeOf, errorTexts } from '../../utils/regression/workflowApi';
import { meta, tags } from '../../utils/regression/tags';

const SPEC = 'API-DISC-03';
const PAST: Record<RunControl, string> = { stop: 'stopped', resume: 'resumed', cancel: 'cancelled' };

test.describe('API-DISC-03 v2 run state matrix', { tag: tags.api }, () => {
    test('API-DISC-03: legal edges answer 204 and show the new state, illegal ones answer 422 with the state named and leave the run unchanged',
        meta({
            id: 'API-DISC-03', prio: 'P1', issue: 'ilm#432', needs: ['v2-discovery'],
            rule: [
                'T8 B5 rule 27 / C1 / C2 (stop only IN_PROGRESS, resume only STOPPED, cancel IN_PROGRESS / STOPPED; nothing during PROCESSING or terminal: 422 "Discovery <uuid> is <State> and cannot be …")',
                'ilm#267 D7 / D11 (operation legality); core#2269 D1–D5; unknown uuid → 404 (DiscoveryServiceImpl:726-727)',
            ],
        }),
        async ({ api }) => {
            test.setTimeout(420_000);
            const tier = await findDiscoveryConnectors(api);
            const gate = generationGate(tier, 'v2');
            test.skip(gate !== undefined, gate ?? '');
            const connector = tier.v2!;
            const run = await createOwnDiscovery(api, SPEC, connector, { suffix: 'disc03', target: { hosts: DARK_LARGE.split(','), parallel: 1 } });

            const expectRefused = async (uuid: string, op: RunControl, label: string) => {
                const before = await getDiscovery(api, uuid);
                const sent = await controlDiscovery(api, uuid, op);
                expect(sent.status, `${op} on a ${label} run: ${sent.text.slice(0, 200)}`).toBe(422);
                expect(errorShapeOf(sent)).toBe('array');
                expect(errorTexts(sent)).toContain(`Discovery ${uuid} is ${label} and cannot be ${PAST[op]}`);
                const after = await getDiscovery(api, uuid);
                expect({ status: after.status, connectorStatus: after.connectorStatus }, `the ${label} run is unchanged by the refused ${op}`).toEqual({ status: before.status, connectorStatus: before.connectorStatus });
            };

            await test.step('The run starts IN PROGRESS and is stoppable', async () => {
                const d = await getDiscovery(api, run.uuid);
                expect(d.status).toBe('inProgress');
                expect(d.stoppable, 'the IP discovery connector answers stoppable').toBe(true);
                expect(d.connectorInterface?.version ?? d.connectorInterface?.code, 'a v2 run has a connector interface').toBeTruthy();
            });

            await test.step('1 resume on In Progress → 422', async () => expectRefused(run.uuid, 'resume', 'In Progress'));

            await test.step('2 stop → 204, the run is stopped', async () => {
                const sent = await controlDiscovery(api, run.uuid, 'stop');
                expect(sent.status, sent.text.slice(0, 200)).toBe(204);
                await waitForStatus(api, run.uuid, 'stopped', 60_000);
                expect((await getDiscovery(api, run.uuid)).connectorStatus).toBe('stopped');
            });

            await test.step('3 stop on Stopped → 422', async () => expectRefused(run.uuid, 'stop', 'Stopped'));

            await test.step('4 resume → 204, the run is in progress again', async () => {
                const sent = await controlDiscovery(api, run.uuid, 'resume');
                expect(sent.status, sent.text.slice(0, 200)).toBe(204);
                await waitForStatus(api, run.uuid, 'inProgress', 60_000);
            });

            await test.step('5 cancel → 204, the run is cancelled (status and connectorStatus)', async () => {
                const sent = await controlDiscovery(api, run.uuid, 'cancel');
                expect(sent.status, sent.text.slice(0, 200)).toBe(204);
                await waitForStatus(api, run.uuid, 'cancelled', 60_000);
                expect((await getDiscovery(api, run.uuid)).connectorStatus).toBe('cancelled');
            });

            await test.step('6 stop, resume and cancel on Cancelled → 422 each', async () => {
                for (const op of ['stop', 'resume', 'cancel'] as const) await expectRefused(run.uuid, op, 'Cancelled');
            });

            await test.step('7 stop, resume and cancel on a COMPLETED own run → 422 each', async () => {
                const done = await createOwnDiscovery(api, SPEC, connector, { suffix: 'disc03-done', target: { hosts: [DARK_SMALL], parallel: 10 } });
                await waitForCompleted(api, done.uuid, 120_000);
                for (const op of ['stop', 'resume', 'cancel'] as const) await expectRefused(done.uuid, op, 'Completed');
            });

            await test.step('8 stop on a random uuid → 404', async () => {
                const unknown = api.probeUuid();
                const sent = await controlDiscovery(api, unknown, 'stop');
                expect(sent.status, sent.text.slice(0, 200)).toBe(404);
                expect(errorTexts(sent)).toEqual([`Object of type 'Discovery' identified by ${unknown} is not found.`]);
            });
        });
});
