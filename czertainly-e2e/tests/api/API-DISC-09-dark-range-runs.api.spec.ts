/**
 * API-DISC-09 — a zero-certificate run on a dark range ends COMPLETED on both generations: messages, counters, nothing onboarded
 * (ilm#432 steps 1–2, the smoke form; T8 rules 22–23 for v1, B5 rules 29–37 for v2; core#1800; core#2269 B1–B4).
 *
 * The range is RFC 5737 TEST-NET-2 (a /29): never routable, the connector's connect timeout is 500 ms, no scan target is needed.
 *   v1  COMPLETED, final message "Discovery completed. No certificates discovered at provider", `endTime` set, total 0; when the
 *       detail carries the run metadata, `failedUrls` equals `totalUrls` and `successUrls` is 0
 *   v2  COMPLETED, `targetsFailed` ≤ `targetsProcessed`, `itemsProcessed + itemsFailed = itemsNewlyDiscovered` (0)
 *   both  `connectorStatus` equals `status` (core#1800: the two status fields never disagree); no staged certificate; the run ends
 *         in the 90 s budget of the plan
 * Each generation is a test of its own with its deploy gate (`@needs:v1-discovery` / `@needs:v2-discovery`). The runs stay (ledger)
 * until the run-end teardown deletes them (a terminal run deletes in any state).
 */
import { expect, test } from '../../fixtures/testFixtures';
import {
    createOwnDiscovery, findDiscoveryConnectors, Generation, generationGate, getDiscovery, listDiscoveredCertificates, metadataNumber, waitForCompleted,
} from '../../utils/regression/discoveryApi';
import { DARK_SMALL } from '../../utils/regression/tlsTarget';
import { meta, tags } from '../../utils/regression/tags';

const SPEC = 'API-DISC-09';

test.describe('API-DISC-09 zero-certificate runs on a dark range', { tag: tags.api }, () => {
    for (const generation of ['v1', 'v2'] as Generation[]) {
        test(`API-DISC-09[${generation}]: a ${generation} run on a dark /29 completes with nothing discovered`,
            meta({
                id: 'API-DISC-09', prio: 'P1', issue: 'ilm#432', needs: [`${generation}-discovery`],
                rule: [
                    generation === 'v1'
                        ? 'T8 rules 22–23, 56 (v1: provider total 0 → COMPLETED, "Discovery completed. No certificates discovered at provider"; failed URLs are only counted in the run metadata); ip-discovery-provider#94'
                        : 'T8 B5 rules 29–37 (v2: connector COMPLETED + drain → COMPLETED; `itemsProcessed + itemsFailed = itemsNewlyDiscovered`), core#2269 B4',
                    'core#1800 AC: the two status fields on the same run never disagree',
                ],
            }),
            async ({ api }) => {
                test.setTimeout(150_000);
                const tier = await findDiscoveryConnectors(api);
                const gate = generationGate(tier, generation);
                test.skip(gate !== undefined, gate ?? '');
                const run = await createOwnDiscovery(api, SPEC, tier[generation]!, { suffix: `disc09-${generation}`, target: { hosts: [DARK_SMALL], parallel: 10 } });

                await test.step('The run reaches COMPLETED within 90 s (fails fast on failed)', async () => waitForCompleted(api, run.uuid, 90_000));

                const detail = await getDiscovery(api, run.uuid);
                await test.step('Both status fields are completed and agree; the run has an end time and discovered nothing', async () => {
                    expect(detail.status).toBe('completed');
                    expect(detail.connectorStatus, 'connectorStatus = status').toBe(detail.status);
                    expect(detail.endTime, 'endTime is set').toBeTruthy();
                    expect(detail.totalCertificatesDiscovered ?? 0).toBe(0);
                    expect(await listDiscoveredCertificates(api, run.uuid), 'no staged certificate: nothing was onboarded').toEqual([]);
                });

                if (generation === 'v1') {
                    await test.step('v1: the final message and the URL counters of the run metadata', async () => {
                        expect(detail.message).toBe('Discovery completed. No certificates discovered at provider');
                        const total = metadataNumber(detail, 'totalUrls');
                        if (total === undefined) test.info().annotations.push({ type: 'metadata', description: 'the run detail carried no totalUrls item: the URL counters were not asserted' });
                        else {
                            expect(total, 'the /29 holds 6 usable addresses: at least one URL was tried').toBeGreaterThan(0);
                            expect(metadataNumber(detail, 'failedUrls'), 'every URL failed: failedUrls = totalUrls').toBe(total);
                            expect(metadataNumber(detail, 'successUrls') ?? 0, 'no URL answered').toBe(0);
                        }
                    });
                } else {
                    await test.step('v2: targets failed inside targets processed; items add up to the newly discovered (0)', async () => {
                        const progress = (detail.progress ?? {}) as { targetsProcessed?: number; targetsFailed?: number };
                        expect(progress.targetsProcessed, 'the run reports its processed targets').toBeGreaterThan(0);
                        expect(progress.targetsFailed ?? 0, 'failed targets are a part of the processed ones').toBeLessThanOrEqual(progress.targetsProcessed!);
                        expect((detail.itemsProcessed ?? 0) + (detail.itemsFailed ?? 0)).toBe(detail.itemsNewlyDiscovered ?? 0);
                        expect(detail.itemsNewlyDiscovered ?? 0).toBe(0);
                    });
                }
            });
    }
});
