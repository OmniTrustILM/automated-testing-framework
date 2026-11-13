/**
 * key-onboarding.setup — the setup project of the key onboarding block (`@dev-tests`). The only creator of the block's
 * shared objects and of the key pairs on the token; every request goes through the framework's strict guard.
 */
import { test as setup } from '../../fixtures/testFixtures';
import { getAuthenticatedApiContext } from '../../utils/auth/apiContext';
import { keyOnboardingConfig } from '../../utils/keyOnboarding/config';
import { offlineBlocker, provisionKeyOnboarding, runnerBlocker, SETUP_NOT_FINISHED, unavailableSummary, writeSummary } from '../../utils/keyOnboarding/provision/provision';
import { devTests } from '../../utils/keyOnboarding/tags';
import type { KeyOnboardingSummary } from '../../utils/keyOnboarding/types';
import { Logger } from '../../utils/Logger';
import { guardApi } from '../../utils/regression/guard/createGuard';
import { scrubError } from '../../utils/devBlocks/provision/transport';

const logger = new Logger('KeyOnboardingSetup');

setup('the block provisions its token and plants its key pairs, or records why the tier cannot', devTests({ infrastructure: true }), async ({ request, env }, testInfo) => {
    setup.setTimeout(5 * 60_000);
    writeSummary(unavailableSummary(SETUP_NOT_FINISHED));
    let summary: KeyOnboardingSummary;
    try {
        const cfg = keyOnboardingConfig();
        const blocked = offlineBlocker(cfg) ?? (await runnerBlocker(cfg));
        if (blocked) {
            summary = unavailableSummary(blocked);
        } else {
            const api = guardApi(await getAuthenticatedApiContext(request, env));
            try {
                summary = await provisionKeyOnboarding(api, { cfg });
            } finally {
                await api.dispose();
            }
        }
    } catch (e) {
        // Not the tier's answer: the specs skip with it, and the setup test fails with the original error.
        try {
            writeSummary(unavailableSummary(`the key onboarding setup failed (${e instanceof Error ? e.name : 'error'}); see the key-onboarding-setup test`));
        } catch (writeError) {
            logger.error(`could not write the failed setup's summary: ${String(writeError)}`);
        }
        // The report shows the message: never with the PIN in it (a guard refusal can quote a body value).
        throw scrubError(e, [keyOnboardingConfig().tokenPin]);
    }
    const file = writeSummary(summary);
    if (summary.status === 'unavailable') {
        testInfo.annotations.push({ type: 'key onboarding unavailable', description: summary.reason });
    } else {
        testInfo.annotations.push({ type: 'key onboarding ready', description: `token ${summary.provisioning.token.uuid}, ${Object.keys(summary.provisioning.planted).length} planted roles` });
    }
    testInfo.annotations.push({ type: 'key onboarding summary', description: file });
});
