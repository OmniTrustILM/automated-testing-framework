/**
 * REG-DISC-09 — An object-level trigger on the run's own discovery. ilm#432, ilm#267.
 *
 * WHAT: 1. A trigger on "Certificate discovered" (rule: Common Name contains `-hit-`; action: set an own custom attribute) is
 *          associated with a v1 discovery at create. Target 1 serves hit-a, hit-b and miss; hit-b was uploaded before.
 *       2. Run 1 → the detail lists the trigger; only hit-a (matching and new) got the marker; miss was evaluated and not satisfied;
 *          the existing hit-b was never evaluated.
 *       3. Run 2 on a fresh target serving hit-c → the new matching certificate is handled the same way.
 *       4. Run 3, a re-scan of target 1 with the trigger attached → every row is existing and no new trigger-history row appears.
 * WHY: ilm#267 requires the same triggers, rules and events as before: ignore triggers first, action triggers after the import,
 *      per trigger, and existing rows never fire.
 * HOW: needs a scan target and a v1 discovery connector; the targets are runner-hosted TLS listeners closed after the test. The action sets
 *      an own custom attribute (a field group would be an adoption and keep the certificate on the tier). The upload is own;
 *      new certificates are `derived` ledger lines deleted by uuid.
 */
import { expect, test } from '../../../fixtures/areas/tlsTarget';
import { customAttributeValue } from '../../../utils/regression/customAttributes';
import { createOwnDiscovery, getDiscovery, getInventoryCertificate, listDiscoveredCertificates, recordOnboarded, waitForCompleted } from '../../../utils/regression/discovery/discoveryApi';
import { getObjectHistory } from '../../../utils/regression/events/eventHistory';
import { EVENT } from '../../../utils/regression/events/eventVocabulary';
import { CERT_FIELD, conditionItem, createOwnChain, setCustomAttributeAction } from '../../../utils/regression/events/workflowObjects';
import { pollUntil } from '../../../utils/regression/wait';
import { testMeta, tags } from '../../../utils/regression/tags';
import { DISCOVERY_LARGE_RUN_MS, DISCOVERY_RUN_MS, DISCOVERY_TRIGGER_TEST_MS } from '../../../utils/regression/timeouts';

const norm = (fp?: string) => String(fp ?? '').replace(/[:\s]/g, '').toLowerCase();

test.describe('Object-level trigger on a discovery', { tag: tags.regression }, () => {
    test('the discovery\'s own trigger acts on matching NEW certificates only, and a re-scan fires nothing',
        testMeta({
            id: 'REG-DISC-09', prio: 'P2', issue: 'ilm#432', needs: ['scan-target', 'v1-discovery'],
            rule: [
                'triggers on a discovery: event Certificate discovered, associated at create; ignore triggers first, action triggers after the import, per trigger; EXISTING rows never fire',
                'ilm#267 AC (same triggers, rules and events as before)',
            ],
        }),
        async ({ api, own, discoveryTier, tlsTargets, discoveredTriggersFree: _free }) => {
            test.setTimeout(DISCOVERY_TRIGGER_TEST_MS);
            const v1 = discoveryTier.v1!;

            const attr = await own.customAttribute('disc09-mark', { resources: ['certificates'] });
            const chain = await createOwnChain(api, own.spec, 'disc09', { event: EVENT.discovered, items: [conditionItem('property', CERT_FIELD.commonName, 'CONTAINS', '-hit-')], executionItems: [setCustomAttributeAction(attr.attributeName, 'STRING', 'applied')] });

            const t1 = await tlsTargets.start({ listeners: 3, withIntermediate: false, leafStems: ['hit-a', 'hit-b', 'miss'] });
            const [hitA, hitB, miss] = t1.served.map((c) => c[0]);
            const existing = await own.certificate.upload(hitB.pem, hitB.commonName, 'leaf hit-b uploaded before run 1 (EXISTING)');
            const attrOf = async (uuid: string) => customAttributeValue(await getInventoryCertificate(api, uuid), attr.attributeName);
            const inventoryOf = (rows: Awaited<ReturnType<typeof listDiscoveredCertificates>>, c: { fingerprint: string }) => rows.find((r) => norm(r.fingerprint) === c.fingerprint)!;

            /** Waits for the run to complete; what it onboarded is recorded whether it completed or failed, before anything is judged. */
            const waitForThenRecord = async (uuid: string, timeoutMs: number, run: { uuid: string }): Promise<void> => {
                try {
                    await waitForCompleted(api, uuid, timeoutMs);
                } finally {
                    await recordOnboarded(api, own.spec, run);
                }
            };

            const run1 = await createOwnDiscovery(api, own.spec, 'disc09-1', { connector: v1, target: { hosts: [t1.ipAttribute()], ports: t1.ports.map(String), parallel: 3 }, triggers: [chain.trigger] });
            await waitForThenRecord(run1.uuid, DISCOVERY_LARGE_RUN_MS, run1);

            await test.step('Run 1: the detail lists the trigger; only the matching NEW certificate got the action', async () => {
                const detail = await getDiscovery(api, run1.uuid);
                expect((detail.triggers ?? []).map((t) => t.uuid), 'the run lists its trigger').toEqual([chain.trigger.uuid]);
                const rows = await listDiscoveredCertificates(api, run1.uuid);
                const rowA = inventoryOf(rows, hitA);
                const rowMiss = inventoryOf(rows, miss);
                const rowB = inventoryOf(rows, hitB);
                expect({ a: rowA.newlyDiscovered, miss: rowMiss.newlyDiscovered, b: rowB.newlyDiscovered }).toEqual({ a: true, miss: true, b: false });
                expect(await pollUntil(() => attrOf(String(rowA.inventoryUuid)), (v) => v === 'applied', { what: 'the action on hit-a' }), 'the matching NEW certificate got the marker').toBe('applied');
                expect(await attrOf(String(rowMiss.inventoryUuid)), 'the non-matching certificate is untouched').toBeUndefined();
                expect(await attrOf(existing.uuid), 'the EXISTING certificate is untouched').toBeUndefined();
                const aRows = (await getObjectHistory(api, 'certificates', String(rowA.inventoryUuid))).rows.filter((r) => r.trigger.uuid === chain.trigger.uuid);
                expect(aRows.map((r) => [r.conditionsMatched, r.actionsPerformed]), 'hit-a: matched and performed').toEqual([[true, true]]);
                const missRows = (await getObjectHistory(api, 'certificates', String(rowMiss.inventoryUuid))).rows.filter((r) => r.trigger.uuid === chain.trigger.uuid);
                expect(missRows.map((r) => [r.conditionsMatched, r.actionsPerformed]), 'miss: evaluated, not satisfied').toEqual([[false, false]]);
                expect((await getObjectHistory(api, 'certificates', existing.uuid)).rows.filter((r) => r.trigger.uuid === chain.trigger.uuid), 'EXISTING: never evaluated').toEqual([]);
            });

            await test.step('Run 2 on a fresh target: the new matching certificate is handled the same way', async () => {
                const t2 = await tlsTargets.start({ listeners: 1, withIntermediate: false, leafStems: ['hit-c'] });
                const run2 = await createOwnDiscovery(api, own.spec, 'disc09-2', { connector: v1, target: { hosts: [t2.ipAttribute()], ports: t2.ports.map(String), parallel: 1 }, triggers: [chain.trigger] });
                await waitForThenRecord(run2.uuid, DISCOVERY_RUN_MS, run2);
                const row = (await listDiscoveredCertificates(api, run2.uuid))[0];
                expect(row.newlyDiscovered).toBe(true);
                expect(await pollUntil(() => attrOf(String(row.inventoryUuid)), (v) => v === 'applied', { what: 'the action on hit-c' })).toBe('applied');
            });

            await test.step('Run 3: a re-scan of target 1 with the trigger attached fires nothing', async () => {
                const before = (await getObjectHistory(api, 'certificates', String(inventoryOf(await listDiscoveredCertificates(api, run1.uuid), hitA).inventoryUuid))).totalItems;
                const run3 = await createOwnDiscovery(api, own.spec, 'disc09-3', { connector: v1, target: { hosts: [t1.ipAttribute()], ports: t1.ports.map(String), parallel: 3 }, triggers: [chain.trigger] });
                await waitForThenRecord(run3.uuid, DISCOVERY_LARGE_RUN_MS, run3);
                const rows = await listDiscoveredCertificates(api, run3.uuid);
                expect(rows.every((r) => r.newlyDiscovered === false), 'every row of the re-scan is EXISTING').toBe(true);
                const after = (await getObjectHistory(api, 'certificates', String(inventoryOf(await listDiscoveredCertificates(api, run1.uuid), hitA).inventoryUuid))).totalItems;
                expect(after, 'no new history row of any trigger on hit-a').toBe(before);
            });
        });
});
