/**
 * REG-DISC-08 — Unique certificates per batch and the paging of a firing's objects. ilm#432, documentation#355.
 *
 * WHAT: 1. One batch of eight ports serving seven distinct leaves and one repeat, per connector generation (v1, v2) → the discovery
 *          counts seven certificates, the fingerprint set is the served set, seven new inventory rows, one certificate per fingerprint.
 *       2. Exactly seven trigger-history entries (per unique certificate), and the firing evaluated seven objects.
 *       3. The firing's objects page by 3 → pages of 3, 3 and 1 with no repeated object (HHH-20943, HHH-20911).
 *       4. The v1 connector's own total for the repeat, a recorded value (fixme until a live run provides it).
 * WHY: trigger evaluation is per unique certificate however many hosts presented it (documentation#355). Unconfirmed: v2 may
 *      count the staged repeat and show 8 where the documented rule says 7; the v2 row is `test.fixme` with its body kept, to be
 *      enabled by the first live run that settles whether the platform counts 7 or 8.
 * HOW: needs a scan target and the discovery connector of the generation. The own trigger sets an own custom attribute (a field group would
 * be an adoption
 *      and keep the certificates on the tier). The connector total is not asserted from a guess: that row stays fixme until the
 *      `observed-connector-total` annotation of a live run is copied into RECORDED_V1_CONNECTOR_TOTAL. New certificates are
 *      `derived` ledger lines deleted by uuid.
 */
import { expect, test } from '../../../fixtures/areas/tlsTarget';
import type { GuardedApi } from '../../../utils/regression/guard/types';
import type { OwnObjects } from '../../../utils/regression/ownObjects';
import type { TlsTargets } from '../../../fixtures/areas/tlsTarget';
import { countCertificates, createOwnDiscovery, fingerprintSet, DiscoveryTier, Generation, getDiscovery, listDiscoveredCertificates, recordOnboarded, waitForCompleted } from '../../../utils/regression/discovery/discoveryApi';
import { getFirings } from '../../../utils/regression/events/eventHistory';
import { EVENT } from '../../../utils/regression/events/eventVocabulary';
import { createOwnChain, setCustomAttributeAction } from '../../../utils/regression/events/workflowObjects';
import { sendJson } from '../../../utils/regression/events/workflowRequests';
import { testMeta, tags } from '../../../utils/regression/tags';
import { DISCOVERY_LARGE_RUN_MS, SLOW_LIFECYCLE_MS } from '../../../utils/regression/timeouts';
import { fingerprintFilter } from '../../../utils/regression/apiReads';

/** The v1 connector total a live run observed (`observed-connector-total` annotation); undefined until then. */
const RECORDED_V1_CONNECTOR_TOTAL = undefined as number | undefined;

test.describe('Unique certificates per batch and objects paging', { tag: tags.regression }, () => {
    /**
     * One batch: eight ports, seven distinct leaves, the own trigger on the run; the run completes and its onboarded certificates
     * are recorded, also when it does not complete.
     */
    async function scanBatch({ api, own, discoveryTier, tlsTargets }: { api: GuardedApi; own: OwnObjects; discoveryTier: DiscoveryTier; tlsTargets: TlsTargets }, generation: Generation) {
        const connector = discoveryTier[generation]!;
        const target = await tlsTargets.start({ listeners: 8, distinctLeaves: 7, withIntermediate: false, stem: `bat-${generation}` });
        const served = target.servedFingerprints();
        expect(served, 'the target serves seven distinct leaves').toHaveLength(7);

        const attr = await own.customAttribute(`disc08-${generation}-mark`, { resources: ['certificates'] });
        const chain = await createOwnChain(api, own.spec, `disc08-${generation}`, { event: EVENT.discovered, executionItems: [setCustomAttributeAction(attr.attributeName, 'STRING', 'seen')] });
        const run = await createOwnDiscovery(api, own.spec, `disc08-${generation}`, { connector, target: { hosts: [target.ipAttribute()], ports: target.ports.map(String), parallel: 8 }, triggers: [chain.trigger] });
        let onboarded: string[] = [];
        try {
            await waitForCompleted(api, run.uuid, DISCOVERY_LARGE_RUN_MS);
        } finally {
            onboarded = await recordOnboarded(api, own.spec, run);
        }
        return { served, run, onboarded, detail: await getDiscovery(api, run.uuid) };
    }

    for (const generation of ['v1', 'v2'] as Generation[]) {
        test(`the ${generation} connector turns eight ports with seven leaves into seven certificates, pages 3 / 3 / 1`,
            testMeta({
                id: 'REG-DISC-08', row: `${generation} connector: eight ports, seven leaves`, prio: 'P2', issue: 'ilm#432', needs: ['scan-target', `${generation}-discovery`],
                rule: [
                    'rows grouped by certificate content: one import per unique certificate however many hosts presented it; documentation#355 (trigger evaluation per unique certificate)',
                    '`objectsPagination` (objects inside a firing, page size respected); HHH-20943 / HHH-20911 (paging)',
                    'the batch gives seven certificates and seven trigger entries',
                ],
            }),
            async ({ api, own, discoveryTier, tlsTargets, discoveredTriggersFree: _free }) => {
                test.fixme(generation === 'v2', 'unconfirmed: v2 may count the staged repeat (8 instead of 7); no live run has settled it. Run it once on a tier with a scan target, then record the observed count');
                test.setTimeout(SLOW_LIFECYCLE_MS);
                const { served, run, onboarded, detail: d } = await scanBatch({ api, own, discoveryTier, tlsTargets }, generation);

                await test.step('Seven certificates, seven NEW inventory rows, the served fingerprint set', async () => {
                    test.info().annotations.push({ type: 'observed-connector-total', description: `${generation}: connectorTotalCertificatesDiscovered=${String(d.connectorTotalCertificatesDiscovered)}` });
                    // The documented rule, on both generations. v2 (fixme, see the header): the staging rows (8 with the repeat) may be
                    // what is counted.
                    expect(d.totalCertificatesDiscovered, 'distinct certificates: each certificate counted once, the repeat does not add one').toBe(7);
                    expect(fingerprintSet(await listDiscoveredCertificates(api, run.uuid))).toEqual(served);
                    expect(onboarded, 'seven NEW inventory certificates').toHaveLength(7);
                    for (const fp of served) expect(await countCertificates(api, fingerprintFilter(fp)), `exactly one inventory certificate for ${fp.slice(0, 12)}…`).toBe(1);
                });

                await test.step('Exactly seven trigger-history entries (per unique certificate) and a firing that evaluated seven objects', async () => {
                    const summary = await sendJson(api, 'GET', `/api/v1/workflows/triggers/history/${run.uuid}`);
                    expect(summary.status, summary.text.slice(0, 200)).toBe(200);
                    const entries = (summary.json.objects as Array<{ triggers: unknown[] }>).reduce((n, o) => n + o.triggers.length, 0);
                    expect(entries, 'one trigger-history entry per unique certificate').toBe(7);
                    const firings = await getFirings(api, { event: EVENT.discovered, scope: { resource: 'discoveries', objectUuid: run.uuid } });
                    expect(firings.page?.items.map((f) => f.objectsEvaluated).reduce((a, b) => a + b, 0), 'Σ Obj. Evaluated over the discovery scope').toBe(7);
                });

                await test.step('The firing\'s objects page by 3: 3 / 3 / 1, no repeated object', async () => {
                    const seen: string[] = [];
                    const sizes: number[] = [];
                    for (let objectsPage = 1; objectsPage <= 3; objectsPage++) {
                        const r = await getFirings(api, { event: EVENT.discovered, scope: { resource: 'discoveries', objectUuid: run.uuid }, objectsPage, objectsPageSize: 3 });
                        const objects = r.page!.items[0].objectHistories;
                        sizes.push(objects.items.length);
                        seen.push(...objects.items.map((o) => String(o.objectUuid)));
                        expect(objects.totalItems, 'the objects total').toBe(7);
                    }
                    expect(sizes, 'page sizes 3 / 3 / 1').toEqual([3, 3, 1]);
                    expect(new Set(seen).size, 'no object repeats across the pages').toBe(7);
                });
            });
    }

    test('the v1 connector keeps a duplicate DER once per run',
        testMeta({
            id: 'REG-DISC-08', row: 'v1 connector keeps a duplicate DER once per run', prio: 'P3', issue: 'ilm#432', pin: 'disc08-v1-connector-total', needs: ['scan-target', 'v1-discovery'],
            rule: ['connector-side count of a batch with one repeated certificate, taken from an observed run: not an oracle written from a guess'],
        }),
        async ({ api, own, discoveryTier, tlsTargets }) => {
            test.fixme(RECORDED_V1_CONNECTOR_TOTAL === undefined, 'record the value of the first live run: take the `observed-connector-total` annotation of REG-DISC-08[v1] into RECORDED_V1_CONNECTOR_TOTAL');
            test.setTimeout(SLOW_LIFECYCLE_MS);
            const { detail } = await scanBatch({ api, own, discoveryTier, tlsTargets }, 'v1');
            expect(detail.connectorTotalCertificatesDiscovered, 'the v1 connector total, as recorded from a live run').toBe(RECORDED_V1_CONNECTOR_TOTAL);
        });
});
