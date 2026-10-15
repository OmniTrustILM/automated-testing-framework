/**
 * REG-DISC-01 — a v1 network discovery of the run's OWN TLS target through the UI form (ilm#432 step 1; T8 S1; B4, B6 rules 22–23,
 * 40–41; ilm#437 — SMK-003 is not reused: its cleanup bulk-deletes the first page of certificates, keys and discoveries).
 *
 * The target is a runner-hosted TLS listener serving a leaf and an intermediate with run-prefixed names (utils/regression/
 * tlsTarget.ts, `@needs:scan-target`: REG_SCAN_HOST must be reachable from the tier's discovery connector; a shared tier without one
 * skips until DevOps item 5). The oracle is what the test served, never a baseline:
 *   status inProgress → processing → completed (a subsequence: a fast run may skip one), never failed / warning
 *   detail: no connector interface, kind IP-Hostname, `stoppable` false
 *   `totalCertificatesDiscovered` = the number of DISTINCT certificates served (leaf + intermediate = 2),
 *   `connectorTotalCertificatesDiscovered` ≥ it; the FINGERPRINT SET of the result rows = the SHA-256 set computed from the chain
 *   served; every row processed with an `inventoryUuid`; history "Discovered from Connector: <connector> via discovery: <name>";
 *   the run metadata counts one URL tried and answered (`totalUrls` 1, `successUrls` 1, `failedUrls` 0, when the detail carries it)
 * The certificates the run onboards as NEW are `derived` ledger lines (server-clock createdAfter, their keys too), deleted by uuid by
 * the run-end teardown; EXISTING ones are never touched. The UI half: the detail page shows Completed, offers Delete only (a v1
 * run has no Stop / Resume / Cancel) and lists the same fingerprints in its Results tab.
 */
import { expect, loginAsSmokeUser, test } from '../../fixtures/testFixtures';
import { DiscoveryRunPage } from '../../pages/DiscoveryRunPage';
import {
    fingerprintSet, findDiscoveryConnectors, generationGate, getCertificateHistory, getDiscovery, IP_KIND, isSubsequence, listDiscoveredCertificates, metadataNumber, observeUntilCompleted,
    recordOnboarded,
} from '../../utils/regression/discoveryApi';
import { recordCreated } from '../../utils/regression/regressionRun';
import { scanTargetProblem, startTlsTarget, TlsTarget } from '../../utils/regression/tlsTarget';
import { wfName } from '../../utils/regression/workflowApi';
import { meta } from '../../utils/regression/tags';

const SPEC = 'REG-DISC-01';

test.describe('@regression REG-DISC-01 v1 discovery of the own TLS target', () => {
    let target: TlsTarget | undefined;
    test.afterEach(async () => {
        await target?.close();
        target = undefined;
    });

    test('REG-DISC-01: a v1 run created in the form discovers exactly the certificates the own target serves',
        meta({
            id: 'REG-DISC-01', prio: 'P1', issue: 'ilm#432', needs: ['scan-target', 'v1-discovery'],
            rule: [
                'T8 B4 rules 22–23 (v1 flow, messages), B6 rules 40–41 (fingerprint = SHA-256, NEW rows imported once, history entry), B9 rule 56 (the connector reads the whole chain the server presents)',
                'ilm#432 step 1 (v1 network discovery); ilm#437 (SMK-003 not reused)',
            ],
        }),
        async ({ page, api, env }) => {
            test.setTimeout(420_000);
            const problem = scanTargetProblem();
            test.skip(!!problem, problem ?? '');
            const tier = await findDiscoveryConnectors(api);
            const gate = generationGate(tier, 'v1');
            test.skip(gate !== undefined, gate ?? '');
            const v1 = tier.v1!;
            target = await startTlsTarget({ listeners: 1, withIntermediate: true, stem: 'scan-v1' });
            const served = target.distinct();
            const name = wfName('disc01');
            const ui = new DiscoveryRunPage(page);

            await loginAsSmokeUser(page, env);
            const created = await ui.createV1({ name, provider: v1.name, kind: IP_KIND, hosts: target.ipAttribute(), ports: target.portsAttribute(), parallel: 1 });
            const run = recordCreated('discoveries', { uuid: created.uuid, name }, SPEC, 'v1 run built in the UI form against the own TLS target');

            const statuses = await test.step('The run completes: inProgress → processing → completed (never failed or warning)', async () => {
                const seen = await observeUntilCompleted(api, run.uuid, 240_000);
                expect(isSubsequence(seen, ['inProgress', 'processing', 'completed']), `statuses ${seen.join(' → ')} are a subsequence of inProgress → processing → completed`).toBe(true);
                return seen;
            });
            test.info().annotations.push({ type: 'statuses', description: statuses.join(' → ') });
            const onboarded = await recordOnboarded(api, SPEC, run);

            await test.step('Detail: no connector interface, kind IP-Hostname, not stoppable', async () => {
                const d = await getDiscovery(api, run.uuid);
                expect(d.connectorInterface ?? null).toBeNull();
                expect(d.kind).toBe(IP_KIND);
                expect(d.stoppable ?? false).toBe(false);
                expect(d.status).toBe('completed');
                expect(d.connectorStatus, 'the two status fields agree').toBe('completed');
            });

            await test.step('Counters and the fingerprint set equal what the target served', async () => {
                const d = await getDiscovery(api, run.uuid);
                expect(d.totalCertificatesDiscovered, 'distinct certificates served: leaf + intermediate').toBe(served.length);
                expect(d.connectorTotalCertificatesDiscovered ?? 0).toBeGreaterThanOrEqual(served.length);
                const rows = await listDiscoveredCertificates(api, run.uuid);
                expect(fingerprintSet(rows), 'the fingerprint set of the result rows = the SHA-256 set of the served chain').toEqual(target!.servedFingerprints());
                for (const r of rows) {
                    expect(r.processed, `row ${r.commonName} processed`).toBe(true);
                    expect(r.inventoryUuid, `row ${r.commonName} reached the inventory`).toBeTruthy();
                }
                const total = metadataNumber(d, 'totalUrls');
                if (total !== undefined) {
                    expect(total).toBe(1);
                    expect(metadataNumber(d, 'successUrls')).toBe(1);
                    expect(metadataNumber(d, 'failedUrls') ?? 0).toBe(0);
                }
            });

            await test.step('Every onboarded certificate carries the history entry of this discovery', async () => {
                expect(onboarded.length, 'both served certificates were NEW to the inventory (or already known: then they are not ours to delete)').toBeLessThanOrEqual(served.length);
                const rows = await listDiscoveredCertificates(api, run.uuid);
                for (const r of rows) {
                    const history = await getCertificateHistory(api, String(r.inventoryUuid));
                    expect(history.some((h) => new RegExp(`Discovered from Connector: .+ via discovery: ${name}`).test(String(h.message ?? ''))), `history of ${r.commonName}`).toBe(true);
                }
            });

            await test.step('UI: the detail page shows Completed, offers Delete only and lists the same fingerprints', async () => {
                await ui.openDetail(run.uuid);
                await ui.assertStatus('completed');
                expect(await ui.controls()).toEqual({ stop: false, resume: false, cancel: false, delete: true });
                expect(await ui.detailRowCount('connectorInterface'), 'a v1 run shows no connector interface').toBe(0);
                expect(await ui.detailText('kind')).toContain(IP_KIND);
                await ui.openResultsTab();
                expect(await ui.resultFingerprints(target!.servedFingerprints().length)).toEqual(target!.servedFingerprints());
            });
        });
});
