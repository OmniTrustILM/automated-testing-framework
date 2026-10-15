/**
 * REG-DISC-09 — an object-level trigger on the OWN discovery (ilm#432 step 8; T8 S6; B2 rule 15, B6 rules 41–42; ilm#267 AC: the same
 * triggers, rules and events): the certificates NEW in the run that match get the action; non-matching ones and EXISTING ones do not;
 * the next run's new certificate is handled the same way; a re-scan of the same target fires nothing (v1).
 *
 * Target 1 serves three leaves: `hit-a`, `hit-b` and `miss`; the test uploads `hit-b` first (EXISTING), so the run onboards `hit-a` and
 * `miss` as NEW. The own rule is "Common Name contains `-hit-`", the action a Set field of an own custom attribute (the plan's
 * "Set field group" is replaced by an attribute: group membership is ADOPTION and would keep the discovered certificate on the tier,
 * teardown R2). Oracles:
 *   run 1  trigger listed in the run's detail; `hit-a` carries the marker; `miss` (non-matching) and `hit-b` (EXISTING) do not; the
 *          certificate history shows a true / true row for `hit-a` and a false / false row for `miss`, no row for `hit-b`
 *   run 2  (target 2, a fresh `hit-c` leaf): `hit-c` is NEW and gets the marker
 *   run 3  (a re-scan of target 1 with the trigger attached): every row EXISTING, no new row of the trigger
 * `@needs:scan-target`, `@needs:v1-discovery`; NEW certificates are `derived` ledger lines deleted by uuid; the attribute is not required.
 */
import { expect, test } from '../../fixtures/testFixtures';
import { createOwnCustomAttribute, customAttributeValue } from '../../utils/regression/eventsDrivers';
import {
    createOwnDiscovery, findDiscoveryConnectors, generationGate, getDiscovery, getInventoryCertificate, listDiscoveredCertificates, recordOnboarded, waitForCompleted,
} from '../../utils/regression/discoveryApi';
import { recordDerivedKeyOf, serverCreatedAfter, uploadOwnCertificate } from '../../utils/regression/regressionApi';
import { scanTargetProblem, startTlsTarget, TlsTarget } from '../../utils/regression/tlsTarget';
import { CERT_FIELD, conditionItem, createOwnChain, EVENT, getObjectHistory, pollUntil, setCustomAttribute, getPlatformTriggerGate} from '../../utils/regression/workflowApi';
import { meta } from '../../utils/regression/tags';

const SPEC = 'REG-DISC-09';
const norm = (fp?: string) => String(fp ?? '').replace(/[:\s]/g, '').toLowerCase();

test.describe('@regression REG-DISC-09 object-level trigger on a discovery', () => {
    const targets: TlsTarget[] = [];
    test.afterEach(async () => {
        await Promise.all(targets.splice(0).map((t) => t.close()));
    });

    test('REG-DISC-09: the discovery\'s own trigger acts on matching NEW certificates only; a re-scan fires nothing',
        meta({
            id: 'REG-DISC-09', prio: 'P1', issue: 'ilm#432', needs: ['scan-target', 'v1-discovery'],
            rule: [
                'T8 B2 rule 15 (triggers on a discovery: event Certificate discovered, associated at create), B6 rules 41–42 (ignore first; action triggers after the import, per trigger; EXISTING rows never fire)',
                'ilm#267 AC (same triggers, rules and events as before); T8 S6',
            ],
        }),
        async ({ api }) => {
            test.setTimeout(600_000);
            const platformGate = await getPlatformTriggerGate(api, [EVENT.discovered]);
            test.skip(platformGate !== undefined, platformGate ?? '');
            const problem = scanTargetProblem();
            test.skip(!!problem, problem ?? '');
            const tier = await findDiscoveryConnectors(api);
            const gate = generationGate(tier, 'v1');
            test.skip(gate !== undefined, gate ?? '');

            const attr = await createOwnCustomAttribute(api, SPEC, { suffix: 'disc09-mark', resources: ['certificates'] });
            const chain = await createOwnChain(api, SPEC, {
                suffix: 'disc09', event: EVENT.discovered, items: [conditionItem('property', CERT_FIELD.commonName, 'CONTAINS', '-hit-')], executionItems: [setCustomAttribute(attr.attributeName, 'STRING', 'applied')],
            });

            const t1 = await startTlsTarget({ listeners: 3, withIntermediate: false, leafStems: ['hit-a', 'hit-b', 'miss'] });
            targets.push(t1);
            const [hitA, hitB, miss] = t1.served.map((c) => c[0]);
            const existing = await uploadOwnCertificate(api, hitB.pem, hitB.commonName, SPEC, 'leaf hit-b uploaded before run 1 (EXISTING)');
            await recordDerivedKeyOf(api, existing.uuid, await serverCreatedAfter(api), SPEC);
            const attrOf = async (uuid: string) => customAttributeValue(await getInventoryCertificate(api, uuid), attr.attributeName);
            const inventoryOf = (rows: Awaited<ReturnType<typeof listDiscoveredCertificates>>, c: { fingerprint: string }) => rows.find((r) => norm(r.fingerprint) === c.fingerprint)!;

            const run1 = await createOwnDiscovery(api, SPEC, tier.v1!, { suffix: 'disc09-1', target: { hosts: [t1.ipAttribute()], ports: t1.ports.map(String), parallel: 3 }, triggers: [chain.trigger] });
            await waitForCompleted(api, run1.uuid, 300_000);
            await recordOnboarded(api, SPEC, run1);

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
                const t2 = await startTlsTarget({ listeners: 1, withIntermediate: false, leafStems: ['hit-c'] });
                targets.push(t2);
                const run2 = await createOwnDiscovery(api, SPEC, tier.v1!, { suffix: 'disc09-2', target: { hosts: [t2.ipAttribute()], ports: t2.ports.map(String), parallel: 1 }, triggers: [chain.trigger] });
                await waitForCompleted(api, run2.uuid, 240_000);
                await recordOnboarded(api, SPEC, run2);
                const row = (await listDiscoveredCertificates(api, run2.uuid))[0];
                expect(row.newlyDiscovered).toBe(true);
                expect(await pollUntil(() => attrOf(String(row.inventoryUuid)), (v) => v === 'applied', { what: 'the action on hit-c' })).toBe('applied');
            });

            await test.step('Run 3: a re-scan of target 1 with the trigger attached fires nothing', async () => {
                const before = (await getObjectHistory(api, 'certificates', String(inventoryOf(await listDiscoveredCertificates(api, run1.uuid), hitA).inventoryUuid))).totalItems;
                const run3 = await createOwnDiscovery(api, SPEC, tier.v1!, { suffix: 'disc09-3', target: { hosts: [t1.ipAttribute()], ports: t1.ports.map(String), parallel: 3 }, triggers: [chain.trigger] });
                await waitForCompleted(api, run3.uuid, 300_000);
                const rows = await listDiscoveredCertificates(api, run3.uuid);
                expect(rows.every((r) => r.newlyDiscovered === false), 'every row of the re-scan is EXISTING').toBe(true);
                const after = (await getObjectHistory(api, 'certificates', String(inventoryOf(await listDiscoveredCertificates(api, run1.uuid), hitA).inventoryUuid))).totalItems;
                expect(after, 'no new history row of any trigger on hit-a').toBe(before);
            });
        });
});
