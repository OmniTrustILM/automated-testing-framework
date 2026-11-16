/**
 * REG-DISC-08 — trigger evaluation per unique certificate and the paging of a firing's objects (ilm#432, documentation#355).
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

    const generation: Generation = 'v1';
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
            test.setTimeout(SLOW_LIFECYCLE_MS);
            const { served, run, onboarded, detail: d } = await scanBatch({ api, own, discoveryTier, tlsTargets }, generation);

            await test.step('Seven certificates, seven NEW inventory rows, the served fingerprint set', async () => {
                test.info().annotations.push({ type: 'observed-connector-total', description: `${generation}: connectorTotalCertificatesDiscovered=${String(d.connectorTotalCertificatesDiscovered)}` });
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

});
