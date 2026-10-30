/**
 * clusterRun — the Kubernetes objects of one cert-manager row and their removal after it.
 *
 * The `clusterRun` fixture holds the objects the test applied and the certificates it issued. After the test, even when
 * it fails or times out, the objects are removed newest first, then the ILM certificates of the issued DNS names are
 * recorded once more, because an issuance in flight can land after the Certificate is deleted. If a removal fails, the
 * certificates are still recorded and the error is thrown afterwards; the removal has its own timeout (CLUSTER_CLEANUP_MS).
 *
 * The test pushes a reference BEFORE it applies the object. The row declares the `cluster` need, so the fixture is only
 * built where kubectl works.
 */
import { test as base } from '../regressionFixtures';
import { recordIssuedSettled } from '../../utils/regression/issuedRecords';
import { removeOwnK8sObject, type K8sRef } from '../../utils/regression/kubernetesOwnObjects';
import { CLUSTER_CLEANUP_MS } from '../../utils/regression/timeouts';

export { expect } from '../regressionFixtures';

/** What the test hands the teardown. */
export interface ClusterRun {
    /** Every Kubernetes object this test recorded, in recording order. */
    readonly objects: K8sRef[];
    /** The run's Certificates: their DNS names and the server time before they were applied (for the derived keys). */
    readonly issued: Array<{ dns: string; createdAfter: string | undefined }>;
}

export const test = base.extend<{ clusterRun: ClusterRun }>({
    clusterRun: [async ({ api, own }, use) => {
        const run: ClusterRun = { objects: [], issued: [] };
        await use(run);
        // The removal error is reported, but only after the settle record ran: an issuance in flight can still land.
        let removalError: unknown;
        try {
            await removeOwnK8sObject(run.objects, own.spec);
        } catch (e) {
            removalError = e;
        }
        // Safety net: after the cluster objects are gone (or the removal failed), record every ILM certificate (and its key) issued for the
        // run's DNS names, after a short API-state poll (`recordIssuedSettled`: two equal reads, none requested / pending; no fixed sleep).
        for (const { dns, createdAfter } of run.issued) await recordIssuedSettled(api, dns, createdAfter, own.spec, 'cert-manager certificate (cleanup safety net)');
        if (removalError !== undefined) throw removalError;
    }, { timeout: CLUSTER_CLEANUP_MS }],
});
