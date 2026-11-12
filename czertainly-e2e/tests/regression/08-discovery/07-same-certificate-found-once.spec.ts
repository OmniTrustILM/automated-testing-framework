/**
 * REG-DISC-07 — The same certificate is found once. ilm#432.
 *
 * WHAT: 1. Upload leaf A of the own target to the inventory, so that leaf B is the only new certificate.
 *       2. Run a v1 discovery against the target (two leaves) → A's row is existing and points at the uploaded certificate, B's row
 *          is new; the new-only and existing-only filters split them; only B is onboarded.
 *       3. The uploaded certificate gains the history entry of this discovery; the inventory holds exactly one certificate per served
 *          fingerprint.
 *       4. A second run with an own trigger on "Certificate discovered" → every row is existing, nothing is onboarded, the run
 *          completes successfully and the trigger never fires (no firing, no history row on any certificate).
 * WHY: staging compares SHA-256 fingerprints; an existing certificate must never be imported twice or fire discovery triggers
 *      again, only its metadata and history are updated.
 * HOW: needs a scan target and a v1 discovery connector; the target is a runner-hosted TLS listener closed after the test. A is an own
 *      upload (recorded, with its key); B is a `derived` ledger line, and its key, deleted by uuid. The trigger chain and its custom
 *      attribute are own. Skips with a named reason without the target, the connector or the trigger gate, before anything is created.
 */
import { expect, test } from '../../../fixtures/areas/tlsTarget';
import { countCertificates, createOwnDiscovery, getCertificateHistory, getDiscovery, listDiscoveredCertificates, recordOnboarded, waitForCompleted } from '../../../utils/regression/discovery/discoveryApi';
import { fingerprintFilter } from '../../../utils/regression/apiReads';
import { getFirings, getObjectHistory } from '../../../utils/regression/events/eventHistory';
import { EVENT } from '../../../utils/regression/events/eventVocabulary';
import { createOwnChain, setCustomAttributeAction } from '../../../utils/regression/events/workflowObjects';
import { testMeta, tags } from '../../../utils/regression/tags';
import { DISCOVERY_RUN_MS, SLOW_LIFECYCLE_MS } from '../../../utils/regression/timeouts';

test.describe('Fingerprint dedup of discovered certificates', { tag: tags.regression }, () => {
    test('an existing certificate is EXISTING and never re-fires, and a second run onboards nothing',
        testMeta({
            id: 'REG-DISC-07', prio: 'P2', issue: 'ilm#432', needs: ['scan-target', 'v1-discovery'],
            rule: ['staging: fingerprint = SHA-256, existing → newlyDiscovered false, metadata + history updated, never fires CERTIFICATE_DISCOVERED; import of NEW only', 'existing certificates are never imported twice or re-fire triggers'],
        }),
        async ({ api, own, discoveryTier, tlsTargets, discoveredTriggersFree: _free }) => {
            test.setTimeout(SLOW_LIFECYCLE_MS);
            const v1 = discoveryTier.v1!;
            const target = await tlsTargets.start({ listeners: 2, withIntermediate: false, stem: 'dedup' });
            const [a, b] = target.served.map((chain) => chain[0]);
            const hosts = { hosts: [target.ipAttribute()], ports: target.ports.map(String), parallel: 1 };

            const x = await own.certificate.upload(a.pem, a.commonName, 'the target\'s leaf A, uploaded before the run (EXISTING)');
            expect(await countCertificates(api, fingerprintFilter(a.fingerprint)), 'A is in the inventory').toBe(1);
            expect(await countCertificates(api, fingerprintFilter(b.fingerprint)), 'B is new to the inventory').toBe(0);

            const run1 = await createOwnDiscovery(api, own.spec, 'disc07-1', { connector: v1, target: hosts });
            let onboarded: string[] = [];
            try {
                await waitForCompleted(api, run1.uuid, DISCOVERY_RUN_MS);
            } finally {
                // Whatever the run onboarded is on the tier whether it completed or failed: record it before anything is judged.
                onboarded = await recordOnboarded(api, own.spec, run1);
            }

            await test.step('Run 1: A is EXISTING (the uploaded X), B is NEW; the filters split them', async () => {
                const rows = await listDiscoveredCertificates(api, run1.uuid);
                const rowA = rows.find((r) => r.fingerprint?.replace(/[:\s]/g, '').toLowerCase() === a.fingerprint)!;
                const rowB = rows.find((r) => r.fingerprint?.replace(/[:\s]/g, '').toLowerCase() === b.fingerprint)!;
                expect(rowA, 'row A').toBeTruthy();
                expect(rowB, 'row B').toBeTruthy();
                expect({ newly: rowA.newlyDiscovered, inventory: rowA.inventoryUuid }, 'A is EXISTING and points at the uploaded certificate').toEqual({ newly: false, inventory: x.uuid });
                expect(rowB.newlyDiscovered, 'B is NEW').toBe(true);
                expect((await listDiscoveredCertificates(api, run1.uuid, true)).map((r) => r.fingerprint?.replace(/[:\s]/g, '').toLowerCase())).toEqual([b.fingerprint]);
                expect((await listDiscoveredCertificates(api, run1.uuid, false)).map((r) => r.fingerprint?.replace(/[:\s]/g, '').toLowerCase())).toEqual([a.fingerprint]);
                expect(onboarded, 'only B is onboarded by the run').toEqual([rowB.inventoryUuid]);
            });

            await test.step('X gains the history entry of this discovery; the inventory holds exactly one certificate per served fingerprint', async () => {
                const history = await getCertificateHistory(api, x.uuid);
                expect(history.some((h) => new RegExp(`Discovered from Connector: .+ via discovery: ${run1.name}`).test(String(h.message ?? '')))).toBe(true);
                expect(await countCertificates(api, fingerprintFilter(a.fingerprint))).toBe(1);
                expect(await countCertificates(api, fingerprintFilter(b.fingerprint))).toBe(1);
            });

            await test.step('Run 2 with an own trigger on Certificate discovered: nothing is NEW, nothing fires', async () => {
                const attr = await own.customAttribute('disc07-mark', { resources: ['certificates'] });
                const chain = await createOwnChain(api, own.spec, 'disc07', { event: EVENT.discovered, executionItems: [setCustomAttributeAction(attr.attributeName, 'STRING', 'fired')] });
                const run2 = await createOwnDiscovery(api, own.spec, 'disc07-2', { connector: v1, target: hosts, triggers: [chain.trigger] });
                await waitForCompleted(api, run2.uuid, DISCOVERY_RUN_MS);
                const rows = await listDiscoveredCertificates(api, run2.uuid);
                expect(rows).toHaveLength(2);
                expect(rows.every((r) => r.newlyDiscovered === false), 'every row of run 2 is EXISTING').toBe(true);
                expect(await countCertificates(api, fingerprintFilter(a.fingerprint))).toBe(1);
                expect(await countCertificates(api, fingerprintFilter(b.fingerprint))).toBe(1);
                const detail = await getDiscovery(api, run2.uuid);
                expect(detail.message).toMatch(/^Discovery completed successfully\.?$/);
                const firings = await getFirings(api, { event: EVENT.discovered, scope: { resource: 'discoveries', objectUuid: run2.uuid } });
                expect(firings.page?.totalItems ?? 0, 'the trigger of run 2 never fired').toBe(0);
                for (const r of rows) expect((await getObjectHistory(api, 'certificates', String(r.inventoryUuid))).rows.filter((h) => h.trigger.uuid === chain.trigger.uuid), `no row of the trigger on ${r.commonName}`).toEqual([]);
            });
        });
});
