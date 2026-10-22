/**
 * clusterRun — the Kubernetes objects of one cert-manager row and their removal after it.
 *
 * WHAT: one fixture, `clusterRun`: the list of Kubernetes objects the test applied (in recording order) and the certificates it
 *       issued (DNS name and the server time before they were applied). After the test the objects are removed newest first
 *       (Certificate, then Secret, then issuer), then the ILM certificates of the issued DNS names are recorded once more.
 * WHY: an issuance in flight can still land after the Certificate is deleted, so the ledger needs a second look after the cluster
 *      cleanup, and that look must run even when a removal fails. The cleanup must run when the test fails or times out, and the kubectl
 *      deletes (up to 150 s each) need a budget of their own: three of them and the settle poll fit in `CLUSTER_CLEANUP_MS`. So the
 *      removal is a fixture teardown with its own timeout and not the end of the test body.
 * HOW: the test pushes a reference BEFORE it applies the object (so a failing apply or wait still leaves it listed). The
 *      ledger id comes from `own`; the `cluster` need is declared on the row, so the fixture is only built where kubectl works.
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
        // Safety net: after the cluster objects are gone (or the removal failed), record every ILM certificate (and its key) issued for
        // the run's DNS names, after a short API-state poll (`recordIssuedSettled`: two equal reads, none requested / pending; no fixed
        // sleep).
        for (const { dns, createdAfter } of run.issued) await recordIssuedSettled(api, dns, createdAfter, own.spec, 'cert-manager certificate (cleanup safety net)');
        if (removalError !== undefined) throw removalError;
    }, { timeout: CLUSTER_CLEANUP_MS }],
});
