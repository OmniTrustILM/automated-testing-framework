/**
 * API-DISC-04 — A v1 discovery run offers no run controls. ilm#432, ilm#267, core#2269.
 *
 * WHAT: 1. While the own v1 run is in progress, stop, resume and cancel each answer 422 "Discovery <uuid> cannot be
 *          stopped|resumed|cancelled: not supported by its connector version" (a 422 string array).
 *       2. When the run ends the detail shows the kind (IP-Hostname), no connector interface and no `stoppable` (false or absent); the list
 *          row has no interface either.
 *       3. After COMPLETED the three controls are still refused.
 * WHY: the v1 interface has no run lifecycle: the adapter throws UnsupportedOperationException, which DiscoveryServiceImpl translates to
 *      the 422; ilm#267 (use case 7) fixes which operations a state allows.
 * HOW: one own v1 run on a dark /27 (RFC 5737 range only), recorded in the ledger and deleted by the teardown; `@needs:v1-discovery`: a
 *      tier without a healthy v1 registration skips with the named deploy gate.
 */
import { expect, test } from '../../../fixtures/regressionFixtures';
import { controlDiscovery, createOwnDiscovery, findDiscoveriesByName, findDiscoveryConnectors, getDiscovery, RunControl, waitForCompleted } from '../../../utils/regression/discovery/discoveryApi';
import { expectRefused } from '../../../utils/regression/errorContract';
import { testMeta, tags } from '../../../utils/regression/tags';
import { DISCOVERY_V1_RUN_WAIT_MS, ISSUE_MS } from '../../../utils/regression/timeouts';

const VERB: Record<RunControl, string> = { stop: 'stopped', resume: 'resumed', cancel: 'cancelled' };

test.describe('A v1 discovery run has no run controls', { tag: tags.api }, () => {
    test('stop, resume and cancel answer 422 in every state of a v1 run and its detail shows no controls',
        testMeta({
            id: 'API-DISC-04', prio: 'P1', issue: 'ilm#432', needs: ['v1-discovery'],
            rule: [
                'v1 has no run lifecycle: stop / resume / cancel → 422 "…cannot be stopped|resumed|cancelled: not supported by its connector version" in every state, terminal included',
                'v1 detail: Kind row, no Connector Interface, `stoppable: false`; ilm#267 (which operations a state allows); core#2269',
            ],
        }),
        async ({ api, own }) => {
            test.setTimeout(ISSUE_MS);
            const tier = await findDiscoveryConnectors(api);
            const run = await createOwnDiscovery(api, own.spec, 'disc04', { connector: tier.v1!, target: { hosts: ['198.51.100.0/27'], parallel: 1 } });

            const refused = async (state: string) => {
                for (const op of ['stop', 'resume', 'cancel'] as const) {
                    const sent = await controlDiscovery(api, run.uuid, op);
                    expectRefused(sent, { status: 422, text: `Discovery ${run.uuid} cannot be ${VERB[op]}: not supported by its connector version`, among: true, what: `${op} on a ${state} v1 run` });
                }
            };

            await test.step('While the run is in progress: all three controls are refused', async () => {
                const detail = await getDiscovery(api, run.uuid);
                test.info().annotations.push({ type: 'state-at-first-try', description: `${detail.status}` });
                await refused(detail.status === 'completed' ? 'completed' : 'running');
            });

            await test.step('The run ends: detail shows the kind, no interface, no controls', async () => {
                await waitForCompleted(api, run.uuid, DISCOVERY_V1_RUN_WAIT_MS);
                const detail = await getDiscovery(api, run.uuid);
                expect(detail.kind, 'the kind is shown').toBe('IP-Hostname');
                expect(detail.connectorInterface ?? null, 'a v1 run has no connector interface').toBeNull();
                expect(detail.stoppable ?? false, 'a v1 run is not stoppable').toBe(false);
                const rows = await findDiscoveriesByName(api, run.name);
                expect(rows).toHaveLength(1);
                expect(rows[0].connectorInterface ?? null, 'the list row of a v1 run has no interface (the UI column reads v1)').toBeNull();
            });

            await test.step('After COMPLETED: the controls are still refused', async () => refused('completed'));
        });
});
