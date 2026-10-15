/**
 * API-DISC-04 — a v1 run offers no run controls: stop / resume / cancel answer 422 in EVERY state, including COMPLETED; the detail
 * has no `stoppable` (false or absent), no `connectorInterface`, and shows the kind (ilm#432 step 1; T8 rule 25 and B1 rule 5;
 * ilm#267 UC7; core#2269 A1, A3). v1 has no run lifecycle: the adapter throws `UnsupportedOperationException`, translated to
 *   422 "Discovery <uuid> cannot be stopped|resumed|cancelled: not supported by its connector version"
 * (`DiscoveryServiceImpl` stop / resume / cancel).
 *
 * One own v1 run on a dark /27 (30 documentation addresses, parallelism 1, ~15 s): the controls are tried while it runs and again
 * after it completed. Targets: RFC 5737 only. `@needs:v1-discovery`: a tier without a healthy v1 IP discovery registration skips
 * with the named deploy gate.
 */
import { expect, test } from '../../fixtures/testFixtures';
import { controlDiscovery, createOwnDiscovery, findDiscoveriesByName, findDiscoveryConnectors, generationGate, getDiscovery, RunControl, waitForCompleted } from '../../utils/regression/discoveryApi';
import { errorShapeOf, errorTexts } from '../../utils/regression/workflowApi';
import { meta, tags } from '../../utils/regression/tags';

const SPEC = 'API-DISC-04';
const VERB: Record<RunControl, string> = { stop: 'stopped', resume: 'resumed', cancel: 'cancelled' };

test.describe('API-DISC-04 a v1 run has no run controls', { tag: tags.api }, () => {
    test('API-DISC-04: stop, resume and cancel answer 422 in every state of a v1 run; the detail shows no controls and no interface',
        meta({
            id: 'API-DISC-04', prio: 'P1', issue: 'ilm#432', needs: ['v1-discovery'],
            rule: [
                'T8 rule 25 (v1 has no run lifecycle: stop / resume / cancel → 422 "…cannot be stopped|resumed|cancelled: not supported by its connector version" in every state, terminal included)',
                'T8 B1 rule 5 (v1 detail: Kind row, no Connector Interface, `stoppable: false`); ilm#267 UC7; core#2269 A1 / A3',
            ],
        }),
        async ({ api }) => {
            test.setTimeout(240_000);
            const tier = await findDiscoveryConnectors(api);
            const gate = generationGate(tier, 'v1');
            test.skip(gate !== undefined, gate ?? '');
            const run = await createOwnDiscovery(api, SPEC, tier.v1!, { suffix: 'disc04', target: { hosts: ['198.51.100.0/27'], parallel: 1 } });

            const refused = async (state: string) => {
                for (const op of ['stop', 'resume', 'cancel'] as const) {
                    const sent = await controlDiscovery(api, run.uuid, op);
                    expect(sent.status, `${op} on a ${state} v1 run: ${sent.text.slice(0, 200)}`).toBe(422);
                    expect(errorShapeOf(sent)).toBe('array');
                    expect(errorTexts(sent)).toContain(`Discovery ${run.uuid} cannot be ${VERB[op]}: not supported by its connector version`);
                }
            };

            await test.step('While the run is in progress: all three controls are refused', async () => {
                const detail = await getDiscovery(api, run.uuid);
                test.info().annotations.push({ type: 'state-at-first-try', description: `${detail.status}` });
                await refused(detail.status === 'completed' ? 'completed' : 'running');
            });

            await test.step('The run ends: detail shows the kind, no interface, no controls', async () => {
                await waitForCompleted(api, run.uuid, 200_000);
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
