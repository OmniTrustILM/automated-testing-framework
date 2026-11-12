/**
 * REG-DISC-01 — A v1 network discovery of the run's own TLS target. ilm#432, ilm#437.
 *
 * WHAT: 1. Discoveries → create in the UI form (v1 provider, kind IP-Hostname, the target's address and port) → the run goes
 *          inProgress → processing → completed, never failed or warning.
 *       2. The detail has no connector interface, the kind is IP-Hostname and it is not stoppable.
 *       3. The counters and the SHA-256 fingerprint set of the result rows equal what the target served (leaf and intermediate);
 *          every row is processed and reached the inventory.
 *       4. Every onboarded certificate carries the history entry "Discovered from Connector … via discovery: <name>".
 *       5. The UI detail page shows Completed, offers Delete only and lists the same fingerprints.
 * WHY: a discovery must find exactly what the server presents, import new certificates once and leave a history entry; the
 *      smoke discovery check is not reused because its cleanup bulk-deletes (ilm#437).
 * HOW: the target is a runner-hosted TLS listener serving a leaf and an intermediate (it needs a scan target and is closed after
 *      the test), so the oracle is what the test served. The discovery's ledger line comes from the form's answer, before the redirect
 *      is waited for; certificates onboarded as new are `derived` ledger lines deleted by uuid, existing ones are never touched.
 *      Skips with a named reason without a scan target or a v1 discovery connector.
 */
import { expect, test } from '../../../fixtures/areas/tlsTarget';
import { DiscoveryDetailPage } from '../../../pages/DiscoveryDetailPage';
import { DiscoveryPage } from '../../../pages/DiscoveryPage';
import { fingerprintSet, getCertificateHistory, getDiscovery, IP_KIND, isSubsequence, listDiscoveredCertificates, metadataNumber, observeUntilCompleted, recordOnboarded } from '../../../utils/regression/discovery/discoveryApi';
import { lookupDiscovery, submitRecordingByNameOnFailure } from '../../../utils/regression/ledger/uiCreates';
import { testMeta, tags } from '../../../utils/regression/tags';
import { DISCOVERY_RUN_MS, LIFECYCLE_MS } from '../../../utils/regression/timeouts';
import { ownName } from '../../../utils/regression/ledger/runState';

test.describe('V1 discovery of the own TLS target', { tag: tags.regression }, () => {
    test('a v1 run created in the form discovers exactly the certificates the own target serves',
        testMeta({
            id: 'REG-DISC-01', prio: 'P2', issue: 'ilm#432', needs: ['scan-target', 'v1-discovery'],
            rule: [
                'v1 flow and messages; fingerprint = SHA-256, NEW rows imported once, history entry; the connector reads the whole chain the server presents',
                'ilm#432 step 1 (v1 network discovery); ilm#437 (a discovery check must not bulk-delete what it did not create)',
            ],
        }),
        async ({ signedIn: page, api, own, discoveryTier, tlsTargets }) => {
            test.setTimeout(LIFECYCLE_MS);
            const v1 = discoveryTier.v1!;
            const scan = await tlsTargets.start({ listeners: 1, withIntermediate: true, stem: 'scanv1' });
            const served = scan.distinct();
            const name = ownName('disc01');
            const ui = new DiscoveryDetailPage(page);

            const discoveries = new DiscoveryPage(page);
            const note = 'v1 run built in the UI form against the own TLS target';
            const run = await test.step('Create the run in the form and record it before the redirect is waited for', async () => {
                const created = await submitRecordingByNameOnFailure({ type: 'discoveries', name, spec: own.spec, note, lookup: lookupDiscovery(api) }, () => discoveries.createDiscovery({ name, provider: v1.name, kind: IP_KIND, hosts: scan.ipAttribute(), ports: scan.portsAttribute(), parallel: 1 }));
                const ref = own.record('discoveries', created, { name, note });
                await discoveries.waitForDetailRoute();
                return ref;
            });

            let onboarded: string[] = [];
            const statuses = await test.step('The run completes: inProgress → processing → completed (never failed or warning)', async () => {
                let seen: string[] = [];
                try {
                    seen = await observeUntilCompleted(api, run.uuid, DISCOVERY_RUN_MS);
                } finally {
                    // Whatever the run onboarded is on the tier whether it completed or failed: record it before anything is judged.
                    onboarded = await recordOnboarded(api, own.spec, run);
                }
                expect(isSubsequence(seen, ['inProgress', 'processing', 'completed']), `statuses ${seen.join(' → ')} are a subsequence of inProgress → processing → completed`).toBe(true);
                return seen;
            });
            test.info().annotations.push({ type: 'statuses', description: statuses.join(' → ') });

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
                expect(fingerprintSet(rows), 'the fingerprint set of the result rows = the SHA-256 set of the served chain').toEqual(scan.servedFingerprints());
                for (const r of rows) {
                    expect(r.processed, `row ${r.commonName} processed`).toBe(true);
                    expect(r.inventoryUuid, `row ${r.commonName} reached the inventory`).toBeTruthy();
                }
                expect(metadataNumber(d, 'totalUrls'), 'the v1 run reports one url in its metadata').toBe(1);
                expect(metadataNumber(d, 'successUrls'), 'the one url succeeded').toBe(1);
                expect(metadataNumber(d, 'failedUrls') ?? 0, 'no url failed').toBe(0);
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
                await ui.goToDetail(run.uuid);
                await ui.assertStatus('completed');
                expect(await ui.offeredControls()).toEqual({ stop: false, resume: false, cancel: false, delete: true });
                expect(await ui.countDetailRows('connectorInterface'), 'a v1 run shows no connector interface').toBe(0);
                expect(await ui.readDetail('kind')).toContain(IP_KIND);
                await ui.openTab('Results');
                expect(await ui.readResultFingerprints(scan.servedFingerprints().length)).toEqual(scan.servedFingerprints());
            });
        });
});
