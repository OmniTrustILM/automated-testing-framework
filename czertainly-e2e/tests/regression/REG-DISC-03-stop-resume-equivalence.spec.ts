/**
 * REG-DISC-03 — stop mid-run and resume gives the SAME certificates as an uninterrupted run (ilm#432 steps 2–3; T8 S2b, E17; core#2269
 * D1–D2; ip-discovery-provider#121): the own TLS target plus two RFC 5737 /24 ranges at parallelism 1 (509 targets, the connector
 * scans in chunks of 256 and commits its cursor at a chunk boundary: about four minutes at a 500 ms connect timeout). `@slow`.
 *
 *   stop in chunk 2 (targetsProcessed > 256)      PATCH 204 and `stopped`; the UI offers Resume and Cancel, no Stop
 *   resume                                          `inProgress` again, then completed
 *   control run (own name, the same target and ranges, created at the same time) completes untouched
 *   SAME SET of certificate fingerprints (= the set the target served) and the same `totalCertificatesDiscovered`; `itemsDiscovered`
 *   never decreases over the whole life of the run; no duplicate row in `/certificates`; item and target totals are NOT compared
 *   (T8 E17: a resume re-scans the interrupted chunk, so counters may differ, certificate SETS may not)
 *   two more stop / resume cycles (API) while the run is still in progress → still the same set
 * The extra ranges are dark (never routable). Cancel is never needed: both runs end completed. `@needs:scan-target`,
 * `@needs:v2-discovery`; the certificates NEW to the inventory are `derived` ledger lines deleted by uuid.
 */
import { expect, loginAsSmokeUser, test } from '../../fixtures/testFixtures';
import { DiscoveryRunPage } from '../../pages/DiscoveryRunPage';
import {
    controlDiscovery, createOwnDiscovery, findDiscoveryConnectors, fingerprintSet, generationGate, getDiscovery, listDiscoveredCertificates, recordOnboarded, waitForCompleted, waitForStatus,
} from '../../utils/regression/discoveryApi';
import { DARK_TWO_RANGES, scanTargetProblem, startTlsTarget, TlsTarget } from '../../utils/regression/tlsTarget';
import { pollUntil } from '../../utils/regression/workflowApi';
import { meta } from '../../utils/regression/tags';

const SPEC = 'REG-DISC-03';

test.describe('@regression REG-DISC-03 stop / resume equals an uninterrupted run', () => {
    let target: TlsTarget | undefined;
    test.afterEach(async () => {
        await target?.close();
        target = undefined;
    });

    const details = meta({
        id: 'REG-DISC-03', prio: 'P1', issue: 'ilm#432', needs: ['scan-target', 'v2-discovery'], slow: true,
        rule: [
            'T8 B5 rules 31, 58 (stop interrupts the chunk, resume re-scans it; duplicates collapse on uniqueRef), E17 (compare distinct certificate SETS, not counters)',
            'core#2269 D1–D2 ("no duplicate certificates; itemsDiscovered never decreases; run completes"); ip-discovery-provider#121 (counters may step back: not asserted)',
        ],
    });

    test('REG-DISC-03: a run stopped in chunk 2 and resumed discovers the same certificate set as an untouched control run', details, async ({ page, api, env }) => {
        test.setTimeout(1_200_000);
        const problem = scanTargetProblem();
        test.skip(!!problem, problem ?? '');
        const tier = await findDiscoveryConnectors(api);
        const gate = generationGate(tier, 'v2');
        test.skip(gate !== undefined, gate ?? '');
        target = await startTlsTarget({ listeners: 1, withIntermediate: true, stem: 'scan-stop' });
        const hosts = [target.ipAttribute(), ...DARK_TWO_RANGES.split(',')];
        const attributes = { hosts, ports: target.ports.map(String), parallel: 1 };
        const run = await createOwnDiscovery(api, SPEC, tier.v2!, { suffix: 'disc03-run', target: attributes });
        const control = await createOwnDiscovery(api, SPEC, tier.v2!, { suffix: 'disc03-ctl', target: attributes });
        const samples: number[] = [];
        const sample = async () => {
            const d = await getDiscovery(api, run.uuid);
            if (typeof d.itemsDiscovered === 'number') samples.push(d.itemsDiscovered);
            return d;
        };

        await test.step('Wait until the run is inside its second chunk (more than 256 targets processed)', async () => {
            await pollUntil(sample, (d) => ((d.progress ?? {}) as { targetsProcessed?: number }).targetsProcessed! > 256 || d.status !== 'inProgress', { what: 'targets processed > 256', timeoutMs: 600_000, intervalMs: 3_000 });
            expect((await sample()).status, 'the run is still in progress at the stop').toBe('inProgress');
        });

        const ui = new DiscoveryRunPage(page);
        await loginAsSmokeUser(page, env);
        await test.step('Stop in the UI: 204, the run is stopped, the page offers Resume and Cancel but no Stop', async () => {
            await ui.openDetail(run.uuid);
            await ui.clickStop();
            await waitForStatus(api, run.uuid, 'stopped', 60_000);
            await sample();
            await page.reload();
            await ui.assertStatus('stopped');
            const controls = await ui.controls();
            expect(controls).toMatchObject({ stop: false, resume: true, cancel: true });
        });

        await test.step('Resume in the UI: the run is in progress again', async () => {
            await ui.clickResume();
            await waitForStatus(api, run.uuid, 'inProgress', 60_000);
            await sample();
        });

        await test.step('Two more stop / resume cycles through the API while the run is still going', async () => {
            for (let i = 0; i < 2; i++) {
                if ((await sample()).status !== 'inProgress') break;
                expect((await controlDiscovery(api, run.uuid, 'stop')).status).toBe(204);
                await waitForStatus(api, run.uuid, 'stopped', 60_000);
                await sample();
                expect((await controlDiscovery(api, run.uuid, 'resume')).status).toBe(204);
                await waitForStatus(api, run.uuid, 'inProgress', 60_000);
            }
        });

        await test.step('Both runs complete; the samples of itemsDiscovered never step back', async () => {
            await pollUntil(sample, (d) => d.status === 'completed' || d.status === 'failed', { what: 'the interrupted run completes', timeoutMs: 900_000, intervalMs: 5_000 });
            await waitForCompleted(api, run.uuid, 60_000);
            await waitForCompleted(api, control.uuid, 600_000);
            expect(samples, 'itemsDiscovered never decreases (core#2269 D2)').toEqual([...samples].sort((a, b) => a - b));
        });

        await recordOnboarded(api, SPEC, run);
        await recordOnboarded(api, SPEC, control);

        await test.step('Same set of certificate fingerprints (= the set served), same total; no duplicate row', async () => {
            const runRows = await listDiscoveredCertificates(api, run.uuid);
            const controlRows = await listDiscoveredCertificates(api, control.uuid);
            const served = target!.servedFingerprints();
            expect(fingerprintSet(controlRows), 'the control run found exactly what the target served').toEqual(served);
            expect(fingerprintSet(runRows), 'the stopped and resumed run found the same set').toEqual(served);
            expect(new Set(runRows.map((r) => r.fingerprint)).size, 'no duplicate rows in /certificates').toBe(runRows.length);
            const runDetail = await getDiscovery(api, run.uuid);
            const controlDetail = await getDiscovery(api, control.uuid);
            expect(runDetail.totalCertificatesDiscovered).toBe(controlDetail.totalCertificatesDiscovered);
        });
    });
});
