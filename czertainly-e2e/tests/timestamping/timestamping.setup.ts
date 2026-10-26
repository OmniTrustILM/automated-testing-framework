/**
 * timestamping.setup — the tear-up project of the timestamping block (`@dev-tests`): the only creator of the block's
 * shared objects.
 *
 * WHAT: one test that runs the preflight and the provisioning (utils/timestamping/provision/provision.ts) and ALWAYS
 * writes the run's summary (`summaryFile()`, mode 0600): `ready` with the provisioned sets, or `unavailable` with the
 * reason every timestamping test then skips with.
 * WHY: replaces development-environment `scripts/timestamping-setup.sh`; the objects are this run's (run-prefixed names,
 * ledger spec `timestamping/setup`), deleted by the block teardown right after the block and by the run-end teardown as
 * the safety net.
 * HOW: the first thing the test does is overwrite the summary with "not finished", so a killed or retried attempt never
 * leaves an older `ready` file (with older credentials) behind. A tier without timestamping is not a failure: the test
 * passes with an annotation of the reason. It fails on a refused body or identity, a failure of the required RSA
 * family, a programming error or a guard refusal (the summary then says so, and the original error is rethrown). The
 * guarded API is built only after the offline checks passed; it is the STRICT guard, on a shared tier and on a local stack alike
 * (tests/timestamping/SHARED-TIER.md), so a local green run exercises the rules a shared tier runs under. A second guard with the
 * `localStack` option is built on a proven local stack only, for the two requests the strict one refuses (provision.ts `localApi`).
 * A tier without the components ends in `unavailable` after reads only: the preflight creates nothing.
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
