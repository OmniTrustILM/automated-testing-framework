/**
 * REG-DISC-02 — a v2 network discovery of the run's OWN TLS target (API create, UI detail): lifecycle, interface, progress,
 * counters, the same certificate set as v1 (ilm#432 step 2, first half; T8 S2; core#2269 B1–B4).
 *
 *   statuses as REG-DISC-01; detail `connectorInterface` v2 and `resources` certificates; `progress.targetsProcessed` /
 *   `targetsTotal` / `targetsFailed` present; `itemsProcessed + itemsFailed = itemsNewlyDiscovered`; the DISTINCT fingerprint set of the
 *   result rows (whatever `newlyDiscovered` says) = the SHA-256 set of the chain the target served; a reload of the detail page
 *   mid-run shows the same status and progress as the API (a fast run may already be completed: the UI label must be one the API
 *   showed before or after the reload).
 * Same safety as REG-DISC-01 (`@needs:scan-target`, `@needs:v2-discovery`): only the run's own listener, NEW certificates and their
 * keys are `derived` ledger lines deleted by uuid, no SMK-003 cleanup.
 */
import { expect, loginAsSmokeUser, test } from '../../fixtures/testFixtures';
import { DiscoveryRunPage, STATUS_LABEL } from '../../pages/DiscoveryRunPage';
import {
    createOwnDiscovery, findDiscoveryConnectors, fingerprintSet, generationGate, getDiscovery, isSubsequence, listDiscoveredCertificates, observeUntilCompleted, recordOnboarded,
} from '../../utils/regression/discoveryApi';
import { scanTargetProblem, startTlsTarget, TlsTarget } from '../../utils/regression/tlsTarget';
import { meta } from '../../utils/regression/tags';

const SPEC = 'REG-DISC-02';

test.describe('@regression REG-DISC-02 v2 discovery of the own TLS target', () => {
    let target: TlsTarget | undefined;
    test.afterEach(async () => {
        await target?.close();
        target = undefined;
    });

    test('REG-DISC-02: a v2 run discovers exactly the certificates the own target serves and reports its progress',
        meta({
            id: 'REG-DISC-02', prio: 'P1', issue: 'ilm#432', needs: ['scan-target', 'v2-discovery'],
            rule: ['T8 B5 rules 29–37 (v2 flow and counters), B6 rule 40, B9 rule 58 (v2 attributes, uniqueRef = SHA-256 of the DER)', 'ilm#432 step 2; core#2269 B1–B4 (progress, counters)'],
        }),
        async ({ page, api, env }) => {
            test.setTimeout(420_000);
            const problem = scanTargetProblem();
            test.skip(!!problem, problem ?? '');
            const tier = await findDiscoveryConnectors(api);
            const gate = generationGate(tier, 'v2');
            test.skip(gate !== undefined, gate ?? '');
            target = await startTlsTarget({ listeners: 1, withIntermediate: true, stem: 'scan-v2' });
            const run = await createOwnDiscovery(api, SPEC, tier.v2!, { suffix: 'disc02', target: { hosts: [target.ipAttribute()], ports: target.ports.map(String), parallel: 1 } });

            await loginAsSmokeUser(page, env);
            const ui = new DiscoveryRunPage(page);
            const before = (await getDiscovery(api, run.uuid)).status;
            await ui.openDetail(run.uuid);
            await page.reload();
            const uiLabel = await ui.statusLabel();
            const after = (await getDiscovery(api, run.uuid)).status;
            expect([STATUS_LABEL[before], STATUS_LABEL[after]], 'a reload mid-run shows a status the API showed around it').toContain(uiLabel);

            const statuses = await observeUntilCompleted(api, run.uuid, 300_000);
            expect(isSubsequence(statuses, ['inProgress', 'processing', 'completed']), `statuses ${statuses.join(' → ')}`).toBe(true);
            await recordOnboarded(api, SPEC, run);

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
                expect((d.itemsProcessed ?? 0) + (d.itemsFailed ?? 0), 'itemsProcessed + itemsFailed = itemsNewlyDiscovered (core#2269 B4)').toBe(d.itemsNewlyDiscovered ?? 0);
            });

            await test.step('The distinct fingerprint set of the result rows = the set the target served (same set as v1)', async () => {
                const rows = await listDiscoveredCertificates(api, run.uuid);
                expect(fingerprintSet(rows)).toEqual(target!.servedFingerprints());
            });

            await test.step('UI: Completed, interface v2, the progress widget agrees with the API', async () => {
                await ui.openDetail(run.uuid);
                await ui.assertStatus('completed');
                expect(await ui.detailText('connectorInterface')).toMatch(/v2/i);
                const progress = await ui.progress();
                const api2 = ((await getDiscovery(api, run.uuid)).progress ?? {}) as { targetsProcessed?: number; targetsTotal?: number };
                if (progress) expect(progress).toEqual({ processed: api2.targetsProcessed, total: api2.targetsTotal });
            });
        });
});
