/**
 * REG-DISC-03 — Stop and resume find the same certificates as an uninterrupted discovery. ilm#432, core#2269.
 *
 * WHAT: 1. Two v2 runs over the same targets (the own TLS target plus two dark documentation /24 ranges, parallelism 1): the run
 *          under test and an untouched control.
 *       2. Wait until the run is inside its second chunk (more than 256 targets processed), then Stop in the UI → 204, status
 *          stopped, the page offers Resume and Cancel but no Stop.
 *       3. Resume in the UI → in progress again; two more stop and resume cycles through the API while it still runs.
 *       4. Both runs complete; the samples of itemsDiscovered never decrease.
 *       5. The certificate fingerprint set of both runs equals the set served, with no duplicate row and equal totals.
 * WHY: stop interrupts the current chunk and resume re-scans it, so duplicates must collapse and nothing may be lost
 *      (core#2269); an operator relies on stop and resume for long scans.
 * HOW: a slow row that needs a scan target and a v2 discovery connector. The connector commits its cursor per chunk of 256 targets (about
 *      four minutes). It compares the certificate sets and the total, never the item counters (a resume re-scans the interrupted
 *      chunk, and counters may step back in the connector). Both runs end completed, so cancel is never needed; discoveries are
 *      own and recorded at creation, new certificates are `derived` ledger lines.
 */
import { expect, test } from '../../../fixtures/areas/tlsTarget';
import { DiscoveryDetailPage } from '../../../pages/DiscoveryDetailPage';
import { controlDiscovery, createOwnDiscovery, fingerprintSet, getDiscovery, listDiscoveredCertificates, recordOnboarded, waitForCompleted, waitForStatus } from '../../../utils/regression/discovery/discoveryApi';
import { DARK_TWO_RANGES } from '../../../utils/regression/discovery/tlsTarget';
import { pollUntil } from '../../../utils/regression/wait';
import { testMeta, tags } from '../../../utils/regression/tags';
import { DISCOVERY_CHUNK_MS, DISCOVERY_STOP_RESUME_TEST_MS, EVENT_DELIVERY_MS, STATUS_CHANGE_MS } from '../../../utils/regression/timeouts';

test.describe('Stop and resume equal an uninterrupted discovery', { tag: tags.regression }, () => {
    const details = testMeta({
        id: 'REG-DISC-03', prio: 'P2', issue: 'ilm#432', needs: ['scan-target', 'v2-discovery'], slow: true,
        rule: [
            'stop interrupts the chunk, resume re-scans it; duplicates collapse on uniqueRef; compare distinct certificate SETS, not counters',
            'core#2269 ("no duplicate certificates; itemsDiscovered never decreases; run completes"); ip-discovery-provider#121 (counters may step back: not asserted)',
        ],
    });

    test('a run stopped in chunk 2 and resumed finds the same certificate set as an untouched run', details, async ({ signedIn: page, api, own, discoveryTier, tlsTargets }) => {
        test.setTimeout(DISCOVERY_STOP_RESUME_TEST_MS);
        const v2 = discoveryTier.v2!;
        const target = await tlsTargets.start({ listeners: 1, withIntermediate: true, stem: 'stop' });
        const hosts = [target.ipAttribute(), ...DARK_TWO_RANGES.split(',')];
        const attributes = { hosts, ports: target.ports.map(String), parallel: 1 };
        const run = await createOwnDiscovery(api, own.spec, 'disc03-run', { connector: v2, target: attributes });
        const control = await createOwnDiscovery(api, own.spec, 'disc03-ctl', { connector: v2, target: attributes });
        try {
            const samples: number[] = [];
            const sample = async () => {
                const d = await getDiscovery(api, run.uuid);
                if (typeof d.itemsDiscovered === 'number') samples.push(d.itemsDiscovered);
                return d;
            };

            await test.step('Wait until the run is inside its second chunk (more than 256 targets processed)', async () => {
                await pollUntil(sample, (d) => ((d.progress ?? {}) as { targetsProcessed?: number }).targetsProcessed! > 256 || d.status !== 'inProgress', { what: 'targets processed > 256', timeoutMs: DISCOVERY_CHUNK_MS, intervalMs: 3_000 });
                expect((await sample()).status, 'the run is still in progress at the stop').toBe('inProgress');
            });

            const ui = new DiscoveryDetailPage(page);
            await test.step('Stop in the UI: 204, the run is stopped, the page offers Resume and Cancel but no Stop', async () => {
                await ui.goToDetail(run.uuid);
                expect((await ui.stopDiscovery()).status, 'PATCH stop').toBe(204);
                await waitForStatus(api, run.uuid, 'stopped', STATUS_CHANGE_MS);
                await sample();
                await page.reload();
                await ui.assertStatus('stopped');
                const controls = await ui.offeredControls();
                expect(controls).toMatchObject({ stop: false, resume: true, cancel: true });
            });

            await test.step('Resume in the UI: the run is in progress again', async () => {
                expect((await ui.resumeDiscovery()).status, 'PATCH resume').toBe(204);
                await waitForStatus(api, run.uuid, 'inProgress', STATUS_CHANGE_MS);
                await sample();
            });

            await test.step('Two more stop / resume cycles through the API while the run is still going', async () => {
                for (let i = 0; i < 2; i++) {
                    expect((await sample()).status, `cycle ${i + 1}: the run is still in progress`).toBe('inProgress');
                    expect((await controlDiscovery(api, run.uuid, 'stop')).status, `cycle ${i + 1}: PATCH stop`).toBe(204);
                    await waitForStatus(api, run.uuid, 'stopped', STATUS_CHANGE_MS);
                    await sample();
                    expect((await controlDiscovery(api, run.uuid, 'resume')).status, `cycle ${i + 1}: PATCH resume`).toBe(204);
                    await waitForStatus(api, run.uuid, 'inProgress', STATUS_CHANGE_MS);
                }
            });

            await test.step('Both runs complete; the samples of itemsDiscovered never step back', async () => {
                await pollUntil(sample, (d) => d.status === 'completed' || d.status === 'failed', { what: 'the interrupted run completes', timeoutMs: EVENT_DELIVERY_MS, intervalMs: 5_000 });
                await waitForCompleted(api, run.uuid, STATUS_CHANGE_MS);
                await waitForCompleted(api, control.uuid, DISCOVERY_CHUNK_MS);
                expect(samples, 'itemsDiscovered never decreases (core#2269)').toEqual([...samples].sort((a, b) => a - b));
            });

            await test.step('Same set of certificate fingerprints (= the set served), same total; no duplicate row', async () => {
                const runRows = await listDiscoveredCertificates(api, run.uuid);
                const controlRows = await listDiscoveredCertificates(api, control.uuid);
                const served = target.servedFingerprints();
                expect(fingerprintSet(controlRows), 'the control run found exactly what the target served').toEqual(served);
                expect(fingerprintSet(runRows), 'the stopped and resumed run found the same set').toEqual(served);
                expect(new Set(runRows.map((r) => r.fingerprint)).size, 'no duplicate rows in /certificates').toBe(runRows.length);
                const runDetail = await getDiscovery(api, run.uuid);
                const controlDetail = await getDiscovery(api, control.uuid);
                expect(runDetail.totalCertificatesDiscovered).toBe(controlDetail.totalCertificatesDiscovered);
            });
        } finally {
            // Whatever either run onboarded is on the tier whether the test passed or not: record it before the failure is shown.
            await recordOnboarded(api, own.spec, run);
            await recordOnboarded(api, own.spec, control);
        }
    });
});
