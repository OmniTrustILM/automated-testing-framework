/**
 * REG-DISC-08 — one batch, many objects: eight ports, SEVEN distinct leaf certificates and one repeat of another port's certificate,
 * on both generations (ilm#432 step 8, the unique-certificate rule; T8 I2, T7, E21; documentation#355; HHH-20943 / HHH-20911; P-D8b).
 * Trigger evaluation is per UNIQUE certificate (documentation#355: "a certificate found on N hosts produces a single trigger-history
 * entry"), and the discovery's Event History pages its objects:
 *   `totalCertificatesDiscovered` 7 on both generations (the DTO documents it as "each certificate counted once");
 *   exactly 7 NEW inventory certificates, one per distinct leaf (the fingerprint set = what the target served);
 *   exactly 7 trigger-history entries (the discovery-scope trigger summary), and the discovery-scope firing has Obj. Evaluated 7;
 *   `objectsPagination` of size 3 pages 3 / 3 / 1 with no repeated object (HHH paging risk: a size that is ignored returns all 7).
 * The own trigger is an action trigger on Certificate discovered attached to the run (`triggers`) that sets an own custom attribute
 * on each matched certificate (the plan's "Set field group" is replaced by an attribute: a group membership counts as ADOPTION
 * (teardown R2) and would keep the discovered certificates on the tier; a custom attribute does not). The 7 NEW certificates are
 * `derived` ledger lines (with their key) deleted by uuid. `@needs:scan-target`, `@needs:v1-discovery`, `@needs:v2-discovery`.
 *
 * BUG CANDIDATE (v2, no bug filed yet, deliberately NOT `test.fail`): a v2 run counts STAGING rows in `totalCertificatesDiscovered`, and
 * the repeat of another port's certificate is staged as an eighth row, so the first live probe may show 8 where the documented rule says 7.
 * The assertion stays the documented one (7); a red [v2] there is the finding, to be filed once the live run confirms it.
 *
 * `connectorTotalCertificatesDiscovered` (the connector's own count: v1 keeps a duplicate DER once per run, v2 counts items) is not asserted
 * from a guess: both runs annotate the value they observed (`observed-connector-total`), and `REG-DISC-08[v1-connector-total]` is the
 * characterisation pin (`@pin`, never P1) that stays `fixme` until the first live probe fixes `PINNED_V1_CONNECTOR_TOTAL`.
 */
import { expect, test } from '../../fixtures/testFixtures';
import type { GuardedApi } from '../../utils/regression/guardedApi';
import { createOwnCustomAttribute } from '../../utils/regression/eventsDrivers';
import {
    countCertificates, createOwnDiscovery, findDiscoveryConnectors, fingerprintSet, Generation, generationGate, getDiscovery, listDiscoveredCertificates, recordOnboarded, waitForCompleted,
} from '../../utils/regression/discoveryApi';
import { scanTargetProblem, startTlsTarget, TlsTarget } from '../../utils/regression/tlsTarget';
import { createOwnChain, EVENT, getFirings, sendJson, setCustomAttribute, getPlatformTriggerGate} from '../../utils/regression/workflowApi';
import { meta } from '../../utils/regression/tags';

/** The v1 connector total observed by the first live probe (`observed-connector-total` annotation); undefined until then. */
const PINNED_V1_CONNECTOR_TOTAL = undefined as number | undefined;

const SPEC = 'REG-DISC-08';
const byFingerprint = (fp: string) => [{ fieldSource: 'property', fieldIdentifier: 'FINGERPRINT', condition: 'EQUALS', value: fp }];

test.describe('@regression REG-DISC-08 unique certificates per batch and objects paging', () => {
    let target: TlsTarget | undefined;
    test.afterEach(async () => {
        await target?.close();
        target = undefined;
    });

    /** One batch: eight ports, seven distinct leaves, the own trigger on the run; the run completes and its onboarded certificates are recorded. */
    async function scanBatch(api: GuardedApi, generation: Generation) {
        const problem = scanTargetProblem();
        test.skip(!!problem, problem ?? '');
        const tier = await findDiscoveryConnectors(api);
        const gate = generationGate(tier, generation);
        test.skip(gate !== undefined, gate ?? '');
        target = await startTlsTarget({ listeners: 8, distinctLeaves: 7, withIntermediate: false, stem: `scan-batch-${generation}` });
        const served = target.servedFingerprints();
        expect(served, 'the target serves seven distinct leaves').toHaveLength(7);

        const attr = await createOwnCustomAttribute(api, SPEC, { suffix: `disc08-${generation}-mark`, resources: ['certificates'] });
        const chain = await createOwnChain(api, SPEC, { suffix: `disc08-${generation}`, event: EVENT.discovered, executionItems: [setCustomAttribute(attr.attributeName, 'STRING', 'seen')] });
        const run = await createOwnDiscovery(api, SPEC, tier[generation]!, {
            suffix: `disc08-${generation}`, target: { hosts: [target.ipAttribute()], ports: target.ports.map(String), parallel: 8 }, triggers: [chain.trigger],
        });
        await waitForCompleted(api, run.uuid, 300_000);
        const onboarded = await recordOnboarded(api, SPEC, run);
        return { served, run, onboarded, detail: await getDiscovery(api, run.uuid) };
    }

    for (const generation of ['v1', 'v2'] as Generation[]) {
        test(`REG-DISC-08[${generation}]: eight ports with seven distinct leaves give seven certificates, seven trigger entries and objects pages 3 / 3 / 1`,
            meta({
                id: 'REG-DISC-08', prio: 'P1', issue: 'ilm#432', needs: ['scan-target', `${generation}-discovery`],
                rule: [
                    'T8 B6 rule 41 (rows grouped by certificate content: one import per unique certificate however many hosts presented it), T7 / documentation#355 (trigger evaluation per unique certificate)',
                    'T14 W31 (`objectsPagination`: objects inside a firing, page size respected); HHH-20943 / HHH-20911 (paging)',
                ],
            }),
            async ({ api }) => {
                test.setTimeout(480_000);
                const platformGate = await getPlatformTriggerGate(api, [EVENT.discovered]);
                test.skip(platformGate !== undefined, platformGate ?? '');
                const { served, run, onboarded, detail: d } = await scanBatch(api, generation);

                await test.step('Seven certificates, seven NEW inventory rows, the served fingerprint set', async () => {
                    test.info().annotations.push({ type: 'observed-connector-total', description: `${generation}: connectorTotalCertificatesDiscovered=${String(d.connectorTotalCertificatesDiscovered)}` });
                    // The documented rule, on both generations. v2 BUG CANDIDATE: the staging rows (8 with the repeat) may be what is counted (see the header).
                    expect(d.totalCertificatesDiscovered, 'distinct certificates: each certificate counted once, the repeat does not add one').toBe(7);
                    expect(fingerprintSet(await listDiscoveredCertificates(api, run.uuid))).toEqual(served);
                    expect(onboarded, 'seven NEW inventory certificates').toHaveLength(7);
                    for (const fp of served) expect(await countCertificates(api, byFingerprint(fp)), `exactly one inventory certificate for ${fp.slice(0, 12)}…`).toBe(1);
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

    test('REG-DISC-08[v1-connector-total]: the v1 connector keeps a duplicate DER once per run (characterisation pin)',
        meta({
            id: 'REG-DISC-08', prio: 'P3', issue: 'ilm#432', pin: 'disc08-v1-connector-total', needs: ['scan-target', 'v1-discovery'],
            rule: ['T8 I2 (connector-side count of a batch with one repeated certificate), pinned from the first live probe: not an oracle written from a guess'],
        }),
        async ({ api }) => {
            test.fixme(PINNED_V1_CONNECTOR_TOTAL === undefined, 'pin from the first live probe: take the `observed-connector-total` annotation of REG-DISC-08[v1] into PINNED_V1_CONNECTOR_TOTAL');
            test.setTimeout(480_000);
            const { detail } = await scanBatch(api, 'v1');
            expect(detail.connectorTotalCertificatesDiscovered, 'the v1 connector total, as pinned by the first probe').toBe(PINNED_V1_CONNECTOR_TOTAL);
        });
});
