/**
 * tlsTarget — the discovery rig of the REG-DISC specs: the own TLS targets, the tier's discovery connectors and the trigger gate.
 *
 * WHAT: `test` is the spec-facing `test` of fixtures/regressionFixtures.ts plus three fixtures:
 *   - `tlsTargets`: `await tlsTargets.start({ listeners, … })` opens a runner-hosted TLS listener set
 *     (utils/regression/discovery/tlsTarget.ts)
 *     and closes every target the test opened when the test ends, whatever the outcome. A runner that cannot host a target
 *     (no REG_SCAN_HOST) skips the test with the named deploy gate before anything is created.
 *   - `discoveryTier`: the tier's healthy v1 and v2 discovery connectors, read once per test. A test names the generation it needs in
 *     `testMeta({ needs: ['v1-discovery'] })`; the `needs` fixture skips it with the named reason when that generation is missing, so
 *     `discoveryTier.v1!` is safe after it.
 *   - `discoveredTriggersFree`: skips the test when a platform-level trigger already listens on "Certificate discovered", because a
 *     row that counts firings must stay out of events it does not own.
 * WHY: six discovery specs repeated the same rig by hand: a `target` variable with an `afterEach` that closes it, the scan-target gate, the
 *      connector lookup with its generation gate and, in three of them, the trigger gate. A forgotten close leaves a listener open for the
 *      rest of the worker, and a gate written as a `test.skip` call after a create leaves objects behind for a test that never ran.
 * HOW: the fixtures are test-scoped and lazy (a test that does not name one never builds it); the gates only read, and they run when
 *      the fixture is set up, which is before the test body can create anything. Only the specs of tests/regression/08-discovery
 *      import this file.
 */
import { test as base } from '../regressionFixtures';
import { DiscoveryTier, findDiscoveryConnectors } from '../../utils/regression/discovery/discoveryApi';
import { scanTargetProblem, startTlsTarget, TlsTarget, TlsTargetOptions } from '../../utils/regression/discovery/tlsTarget';
import { EVENT } from '../../utils/regression/events/eventVocabulary';

export { expect } from '../regressionFixtures';
export type { TlsTarget };

/** What the `tlsTargets` fixture offers. */
export interface TlsTargets {
    /** Opens a target; it is closed when the test ends. */
    start(options?: TlsTargetOptions): Promise<TlsTarget>;
}

export interface DiscoveryRigFixtures {
    tlsTargets: TlsTargets;
    discoveryTier: DiscoveryTier;
    discoveredTriggersFree: void;
}

/** Closes every target; a close that fails does not hide the others, and the first failure is raised after all were tried. */
async function closeAll(targets: readonly TlsTarget[]): Promise<void> {
    const results = await Promise.allSettled(targets.map((target) => target.close()));
    const failed = results.find((r): r is PromiseRejectedResult => r.status === 'rejected');
    if (failed) throw failed.reason;
}

export const test = base.extend<DiscoveryRigFixtures>({
    tlsTargets: async ({ declaredNeeds: _declared }, use, testInfo) => {
        // The scan-target gate is decided here, before the test body can write anything: a skip after a create leaves objects behind.
        const problem = scanTargetProblem();
        if (problem) testInfo.skip(true, problem);
        const opened: TlsTarget[] = [];
        try {
            await use({
                start: async (options) => {
                    const target = await startTlsTarget(options);
                    opened.push(target);
                    return target;
                },
            });
        } finally {
            await closeAll(opened);
        }
    },
    discoveryTier: async ({ api, declaredNeeds: _declared }, use) => use(await findDiscoveryConnectors(api)),
    discoveredTriggersFree: async ({ needs, declaredNeeds: _declared }, use) => {
        await needs.platformTriggersFree(EVENT.discovered);
        await use();
    },
});
