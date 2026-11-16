/**
 * tlsTarget — `test` plus the discovery rig of the REG-DISC specs: own TLS targets, the tier's discovery connectors and the trigger gate.
 * The gates only read and run at fixture setup, before the test body can create anything; targets close when the test ends.
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
