/**
 * REG-DISC-02 — A v2 network discovery of the run's own TLS target. ilm#432, core#2269.
 *
 * WHAT: 1. Create a v2 discovery through the API against the own target; open its detail in the UI and reload mid-run → the UI
 *          shows a status the API showed around the reload.
 *       2. The run goes inProgress → processing → completed.
 *       3. The detail has a v2 connector interface, resources `certificates`, progress (targets total and processed) and counters
 *          where itemsProcessed plus itemsFailed equals itemsNewlyDiscovered.
 *       4. The distinct fingerprint set of the result rows equals the SHA-256 set of the chain served (the same set as REG-DISC-01).
 *       5. The UI shows Completed, interface v2 and a progress widget that agrees with the API.
 * WHY: v2 discoveries report progress and counters that operators watch; core#2269 fixed the counters, so a red test means they
 *      drifted again or the result set is not what the target served.
 * HOW: same safety as the v1 spec (a scan target and a v2 discovery connector are needed): only the run's own listener; new
 *      certificates and keys are `derived` ledger lines. The discovery is created through the API and recorded before any assertion.
 */
import { expect, test } from '../../../fixtures/areas/tlsTarget';
import { DiscoveryDetailPage, DiscoveryStatus, STATUS_LABEL } from '../../../pages/DiscoveryDetailPage';
import { createOwnDiscovery, fingerprintSet, getDiscovery, isSubsequence, listDiscoveredCertificates, observeUntilCompleted, recordOnboarded } from '../../../utils/regression/discovery/discoveryApi';
import { testMeta, tags } from '../../../utils/regression/tags';
import { DISCOVERY_LARGE_RUN_MS, LIFECYCLE_MS } from '../../../utils/regression/timeouts';

test.describe('V2 discovery of the own TLS target', { tag: tags.regression }, () => {
    test('a v2 run discovers exactly the certificates the own target serves and reports its progress',
        testMeta({
            id: 'REG-DISC-02', prio: 'P2', issue: 'ilm#432', needs: ['scan-target', 'v2-discovery'],
            rule: ['v2 flow and counters; v2 attributes, uniqueRef = SHA-256 of the DER', 'ilm#432 step 2; core#2269 (progress and counters of a v2 discovery)'],
        }),
        async ({ signedIn: page, api, own, discoveryTier, tlsTargets }) => {
            test.setTimeout(LIFECYCLE_MS);
            const v2 = discoveryTier.v2!;
            const target = await tlsTargets.start({ listeners: 1, withIntermediate: true, stem: 'scanv2' });
            const run = await createOwnDiscovery(api, own.spec, 'disc02', { connector: v2, target: { hosts: [target.ipAttribute()], ports: target.ports.map(String), parallel: 1 } });
            const ui = new DiscoveryDetailPage(page);

            await test.step('A reload mid-run shows a status the API showed around it', async () => {
                const before = (await getDiscovery(api, run.uuid)).status;
                await ui.goToDetail(run.uuid);
                await page.reload();
                const uiLabel = await ui.readStatusLabel();
                const after = (await getDiscovery(api, run.uuid)).status;
                expect([STATUS_LABEL[before as DiscoveryStatus], STATUS_LABEL[after as DiscoveryStatus]], 'a reload mid-run shows a status the API showed around it').toContain(uiLabel);
            });

            await test.step('The run goes inProgress → processing → completed', async () => {
                let statuses: string[] = [];
                try {
                    statuses = await observeUntilCompleted(api, run.uuid, DISCOVERY_LARGE_RUN_MS);
                } finally {
                    // Whatever the run onboarded is on the tier whether it completed or failed: record it before anything is judged.
                    await recordOnboarded(api, own.spec, run);
                }
                expect(isSubsequence(statuses, ['inProgress', 'processing', 'completed']), `statuses ${statuses.join(' → ')}`).toBe(true);
            });

            await test.step('Detail: connector interface v2, resources certificates, progress and counters', async () => {
                const d = await getDiscovery(api, run.uuid);
                expect(d.status).toBe('completed');
                expect(d.connectorStatus).toBe('completed');
                expect(d.connectorInterface?.version ?? d.connectorInterface?.code, 'a v2 run has a connector interface').toBeTruthy();
                expect(d.resources).toEqual(['certificates']);
                const progress = (d.progress ?? {}) as { targetsProcessed?: number; targetsTotal?: number; targetsFailed?: number };
                expect(progress.targetsTotal, 'targetsTotal is reported').toBeGreaterThanOrEqual(1);
                expect(progress.targetsProcessed, 'targetsProcessed is reported').toBeGreaterThanOrEqual(1);
                expect(progress.targetsFailed ?? 0).toBeLessThanOrEqual(progress.targetsProcessed!);
                expect((d.itemsProcessed ?? 0) + (d.itemsFailed ?? 0), 'itemsProcessed + itemsFailed = itemsNewlyDiscovered (core#2269)').toBe(d.itemsNewlyDiscovered ?? 0);
            });

            await test.step('The distinct fingerprint set of the result rows = the set the target served (same set as v1)', async () => {
                const rows = await listDiscoveredCertificates(api, run.uuid);
                expect(fingerprintSet(rows)).toEqual(target.servedFingerprints());
            });

            await test.step('UI: Completed, interface v2, the progress widget agrees with the API', async () => {
                await ui.goToDetail(run.uuid);
                await ui.assertStatus('completed');
                expect(await ui.readDetail('connectorInterface')).toMatch(/v2/i);
                const progress = await ui.readProgress();
                const api2 = ((await getDiscovery(api, run.uuid)).progress ?? {}) as { targetsProcessed?: number; targetsTotal?: number };
                expect(progress, 'a v2 run shows its progress widget').toBeDefined();
                expect(progress, 'the widget agrees with the API progress').toEqual({ processed: api2.targetsProcessed, total: api2.targetsTotal });
            });
        });
});
