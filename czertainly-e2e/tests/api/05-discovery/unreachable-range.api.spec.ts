/**
 * API-DISC-09 — A run on a range nothing answers on (RFC 5737 TEST-NET-2) completes with nothing discovered, its two status fields
 * agreeing (core#1800, core#2269 for the v2 drain); a provider total of 0 is a normal completion. ilm#432.
 */
import { expect, test } from '../../../fixtures/regressionFixtures';
import { createOwnDiscovery, findDiscoveryConnectors, Generation, getDiscovery, listDiscoveredCertificates, metadataNumber, waitForCompleted } from '../../../utils/regression/discovery/discoveryApi';
import { DARK_SMALL } from '../../../utils/regression/discovery/tlsTarget';
import { testMeta, tags } from '../../../utils/regression/tags';
import { API_DISCOVERY_RUN_TEST_MS, DISCOVERY_SMALL_RUN_WAIT_MS } from '../../../utils/regression/timeouts';

test.describe('Zero-certificate runs on a dark range', { tag: tags.api }, () => {
    for (const generation of ['v1', 'v2'] as Generation[]) {
        test(`a ${generation} run on a dark /29 completes with nothing discovered`,
            testMeta({
                id: 'API-DISC-09', prio: 'P1', issue: 'ilm#432', needs: [`${generation}-discovery`],
                rule: [
                    generation === 'v1'
                        ? 'v1 (provider total 0 → COMPLETED, "Discovery completed. No certificates discovered at provider"; failed URLs are only counted in the run metadata); ip-discovery-provider#94'
                        : 'v2 (connector COMPLETED + drain → COMPLETED; `itemsProcessed + itemsFailed = itemsNewlyDiscovered`), core#2269',
                    'core#1800 AC: the two status fields on the same run never disagree',
                ],
            }),
            async ({ api, own }) => {
                test.setTimeout(API_DISCOVERY_RUN_TEST_MS);
                const tier = await findDiscoveryConnectors(api);
                const run = await createOwnDiscovery(api, own.spec, `disc09-${generation}`, { connector: tier[generation]!, target: { hosts: [DARK_SMALL], parallel: 10 } });

                await test.step('The run reaches COMPLETED within 90 s (fails fast on failed)', async () => waitForCompleted(api, run.uuid, DISCOVERY_SMALL_RUN_WAIT_MS));

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
                        expect(total, 'liveness: at least one URL of the /29 was tried (the count also depends on the connector\'s ports)').toBeGreaterThan(0);
                        expect(metadataNumber(detail, 'failedUrls'), 'every URL failed: failedUrls = totalUrls').toBe(total);
                        expect(metadataNumber(detail, 'successUrls') ?? 0, 'no URL answered').toBe(0);
                    });
                } else {
                    await test.step('v2: targets failed inside targets processed; items add up to the newly discovered (0)', async () => {
                        const progress = (detail.progress ?? {}) as { targetsProcessed?: number; targetsFailed?: number };
                        expect(progress.targetsProcessed, 'liveness: the run reports processed targets (the count of probed addresses of the /29 is not fixed)').toBeGreaterThan(0);
                        expect(progress.targetsFailed ?? 0, 'failed targets are a part of the processed ones').toBeLessThanOrEqual(progress.targetsProcessed!);
                        expect((detail.itemsProcessed ?? 0) + (detail.itemsFailed ?? 0)).toBe(detail.itemsNewlyDiscovered ?? 0);
                        expect(detail.itemsNewlyDiscovered ?? 0).toBe(0);
                    });
                }
            });
    }
});
