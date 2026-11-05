/**
 * clusterRun — the Kubernetes objects of one cert-manager row, removed after the test (newest first), and the ILM
 * certificates it issued, recorded once more: an issuance in flight can land after the Certificate is deleted.
 */
import { test as base } from '../regressionFixtures';
import { recordIssuedSettled } from '../../utils/regression/issuedRecords';
import { removeOwnK8sObject, type K8sRef } from '../../utils/regression/kubernetesOwnObjects';
import { CLUSTER_CLEANUP_MS } from '../../utils/regression/timeouts';

export { expect } from '../regressionFixtures';

export interface ClusterRun {
    readonly objects: K8sRef[];
    /** DNS names of the run's Certificates and the server time before each was applied (for the derived keys). */
    readonly issued: Array<{ dns: string; createdAfter: string | undefined }>;
}

export const test = base.extend<{ clusterRun: ClusterRun }>({
    clusterRun: [async ({ api, own }, use) => {
        const run: ClusterRun = { objects: [], issued: [] };
        await use(run);
        let removalError: unknown;
        try {
            await removeOwnK8sObject(run.objects, own.spec);
        } catch (e) {
            removalError = e;
        }
        // Record the issued certificates even when the removal failed; its error is thrown only afterwards.
        for (const { dns, createdAfter } of run.issued) await recordIssuedSettled(api, dns, createdAfter, own.spec, 'cert-manager certificate (cleanup safety net)');
        if (removalError !== undefined) throw removalError;
    }, { timeout: CLUSTER_CLEANUP_MS }],
});
