/**
 * key-onboarding.setup — the tear-up project of the key onboarding block (`@dev-tests`): the only creator of the
 * block's shared objects and of the key pairs on the token.
 *
 * WHAT: one test that runs the preflight, the provisioning and the planting (utils/keyOnboarding/provision) and ALWAYS
 * writes the run's summary (`summaryFile()`, mode 0600): `ready` with the token, the token profile and the planted
 * labels, or `unavailable` with the reason every key onboarding test then skips with.
 * WHY: replaces the source suite's global setup; the objects are this run's (run-prefixed names, ledger spec
 * `key-onboarding/setup`), deleted by the block teardown right after the block and by the run-end teardown as the
 * safety net; the planted key pairs carry the run prefix and are removed by the block teardown's last step.
 * HOW: the first thing the test does is overwrite the summary with "not finished", so a killed or retried attempt never
 * leaves an older `ready` file behind. A tier or runner without what the block needs is not a failure: the test passes
 * with an annotation of the reason. It fails on a refused body or identity, a programming error or a guard refusal (the
 * summary then says so, and the original error is rethrown). The guarded API is built only after the checks that need
 * no request passed (tier, local proof, PIN, docker, sidecar), so a shared tier gets no request at all (not even the
 * token grant the `api` fixture would make); it is built like the fixture, with the guard's `localStack` option, which takes
 * effect only on a proven local stack.
 */
import { test as setup } from '../../fixtures/testFixtures';
import { getAuthenticatedApiContext } from '../../utils/auth/apiContext';
import { keyOnboardingConfig } from '../../utils/keyOnboarding/config';
import { defaultDockerRunner, offlineBlocker, provisionKeyOnboarding, runnerBlocker, SETUP_NOT_FINISHED, unavailableSummary, writeSummary } from '../../utils/keyOnboarding/provision/provision';
import { devTests } from '../../utils/keyOnboarding/tags';
import type { KeyOnboardingSummary } from '../../utils/keyOnboarding/types';
import { Logger } from '../../utils/Logger';
import { guardApi } from '../../utils/regression/guard/createGuard';
import { describeLocalOnly } from '../../utils/regression/tier/localProof';

const logger = new Logger('KeyOnboardingSetup');

// The second guard next to `@local`, as in every spec of the block.
describeLocalOnly(setup);

setup('the block provisions its token and plants its key pairs, or records why the tier cannot', devTests(), async ({ request, env }, testInfo) => {
    // The PIN secret's activation and a container that installs its tools before it plants eleven key pairs.
    setup.setTimeout(5 * 60_000);
    writeSummary(unavailableSummary(SETUP_NOT_FINISHED));
    let summary: KeyOnboardingSummary;
    try {
        const cfg = keyOnboardingConfig();
        const docker = defaultDockerRunner();
        const blocked = offlineBlocker(cfg) ?? (await runnerBlocker(cfg, docker));
        if (blocked) {
            summary = unavailableSummary(blocked);
        } else {
            const api = guardApi(await getAuthenticatedApiContext(request, env), { localStack: true });
            try {
                summary = await provisionKeyOnboarding(api, { cfg, docker });
            } finally {
                await api.dispose();
            }
        }
    } catch (e) {
        // Not the tier's answer: the specs skip with it, and the setup test fails with the original error.
        try {
            // The error itself fails this test (its report shows it); the summary only names its kind.
            writeSummary(unavailableSummary(`the key onboarding setup failed (${e instanceof Error ? e.name : 'error'}); see the key-onboarding-setup test`));
        } catch (writeError) {
            logger.error(`could not write the failed setup's summary: ${String(writeError)}`);
        }
        throw e;
    }
    const file = writeSummary(summary);
    if (summary.status === 'unavailable') {
        testInfo.annotations.push({ type: 'key onboarding unavailable', description: summary.reason });
    } else {
        testInfo.annotations.push({ type: 'key onboarding ready', description: `token ${summary.provisioning.token.uuid}, ${Object.keys(summary.provisioning.planted).length} planted roles` });
    }
    testInfo.annotations.push({ type: 'key onboarding summary', description: file });
});
