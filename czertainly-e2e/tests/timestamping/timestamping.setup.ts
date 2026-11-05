/**
 * timestamping.setup — the setup project of the timestamping block (`@dev-tests`): the only creator of the block's shared
 * objects.
 *
 * One test runs the preflight and the provisioning and ALWAYS writes the run's summary: `ready`, or `unavailable` with the
 * reason every timestamping test then skips with. The summary is overwritten with "not finished" first, so a killed or
 * retried attempt never leaves an older `ready` file behind. The objects are this run's (ledger spec `timestamping/setup`);
 * the block teardown deletes them. A tier without timestamping is not a failure: the test passes with an annotation. A
 * refused body or identity, a failure of the required RSA family, a programming error or a guard refusal fails it.
 * The guarded API is built only after the offline checks passed. It is the strict guard on every tier
 * (tests/timestamping/SHARED-TIER.md); a second guard with `localStack` exists on a proven local stack only.
 */
import { test as setup } from '../../fixtures/testFixtures';
import { getAuthenticatedApiContext } from '../../utils/auth/apiContext';
import { Logger } from '../../utils/Logger';
import { guardApi } from '../../utils/regression/guard/createGuard';
import { isLocalTier } from '../../utils/regression/tier/kind';
import { hasLocalProof } from '../../utils/regression/tier/localProof';
import { timestampingConfig } from '../../utils/timestamping/config';
import { offlineBlocker, provisionTimestamping, SETUP_NOT_FINISHED, unavailableSummary, writeSummary } from '../../utils/timestamping/provision/provision';
import { devTests } from '../../utils/timestamping/tags';
import type { TimestampingSummary } from '../../utils/timestamping/types';

const logger = new Logger('TimestampingSetup');

setup('the block provisions its timestamping objects, or records why the tier cannot', devTests({ infrastructure: true }), async ({ request, env }, testInfo) => {
    // Four sets, each with a certificate issuance and a chain validation.
    setup.setTimeout(10 * 60_000);
    writeSummary(unavailableSummary(SETUP_NOT_FINISHED));
    let summary: TimestampingSummary;
    try {
        const cfg = timestampingConfig();
        const blocked = offlineBlocker(cfg);
        if (blocked) {
            summary = unavailableSummary(blocked);
        } else {
            const api = guardApi(await getAuthenticatedApiContext(request, env));
            // The local-stack guard exists on a proven local stack only; a shared tier never builds it.
            const localApi = isLocalTier() && hasLocalProof() ? guardApi(await getAuthenticatedApiContext(request, env), { localStack: true }) : undefined;
            try {
                summary = await provisionTimestamping(api, { cfg, ...(localApi ? { localApi } : {}) });
            } finally {
                await api.dispose();
                await localApi?.dispose();
            }
        }
    } catch (e) {
        // Not the tier's answer: the specs skip with it, and the setup test fails with the original error.
        try {
            // The error itself fails this test (its report shows it); the summary only names its kind.
            writeSummary(unavailableSummary(`the timestamping setup failed (${e instanceof Error ? e.name : 'error'}); see the timestamping-setup test`));
        } catch (writeError) {
            logger.error(`could not write the failed setup's summary: ${String(writeError)}`);
        }
        throw e;
    }
    const file = writeSummary(summary);
    if (summary.status === 'unavailable') {
        testInfo.annotations.push({ type: 'timestamping unavailable', description: summary.reason });
    } else {
        testInfo.annotations.push({ type: 'timestamping ready', description: `sets: ${Object.keys(summary.provisioning.sets).join(', ') || 'none'}` });
        for (const [family, why] of Object.entries(summary.missingFamilies)) testInfo.annotations.push({ type: `timestamping family ${family} missing`, description: why });
    }
    testInfo.annotations.push({ type: 'timestamping summary', description: file });
});
