/**
 *
 * WHAT: SMK-005 test to issue a certificate through ACME protocol, now just to explore the k8s cluster on what have been already installed (cert-manager, ingress-nginx) and what permissions we have
 * 
 * WHY: because we don't know concrete versions, names, and namespaces in the cluster 
 * 
 * HOW: we send read-only requests via k8sClient to get:
 *      1. list of namespaces
 *      2. pods in cert-manager namespace
 *      3. ingress classes
 *      4. CRDs with cert-manager.io suffix
 *      5. SelfSubjectAccessReview for critical operations (create Issuer/Certificate/Secret/Ingress)
 *      6. we print everything to the logs via Logger
 */

import { test } from '../../fixtures/testFixtures';
import {
    getCoreApi,
    getCustomObjectsApi,
    getNetworkingApi,
    getAuthorizationApi,
} from '../../utils/k8sClient';
import { Logger } from '../../utils/Logger';

const logger = new Logger('AcmeSmokeTest');

/**
 * The reconnaissance is a diagnostic, not part of the daily smoke run: it answers "what may this
 * service account do" rather than "does the platform work", and its output is a wall of verdicts
 * nobody needs every morning. Set SMOKE_RECON=true to run it once and read the answer.
 *
 * It only means anything inside the cluster. `loadFromCluster()` does not throw when there is no
 * service account to load - it returns a client that quietly fails later - so running it from a
 * laptop would produce confident nonsense rather than an error. The guard below refuses that.
 *
 * Every service account may ask what it is allowed to do, so this needs no permission of its own:
 * the answer it gives is exactly the answer SMK-005 is waiting for.
 */
test.describe('@smoke acme', () => {
    test('SMK-005: reconnaissance — what is available in the cluster', async ({ env }) => {
        test.skip(process.env.SMOKE_RECON !== 'true', 'Diagnostic — set SMOKE_RECON=true to run it.');
        test.skip(!process.env.KUBERNETES_SERVICE_HOST, 'Only meaningful inside the cluster, where a service account exists.');

        await test.step('Check permissions via SelfSubjectAccessReview', async () => {
            const authApi = getAuthorizationApi();

            const canI = async (
                verb: string,
                resource: string,
                group: string,
                namespace?: string,
            ): Promise<boolean> => {
                const review = await authApi.createSelfSubjectAccessReview({
                    body: {
                        spec: {
                            resourceAttributes: { verb, resource, group, namespace },
                        },
                    },
                });
                return review.status?.allowed === true;
            };

            const smokeNs = env.smoke.namespace!;  // guaranteed present by strict env validation

            const checks: Array<{ verb: string; resource: string; group: string; namespace?: string }> = [
                // Cluster-scope — what we can do at the cluster level
                { verb: 'list', resource: 'namespaces', group: '' },
                { verb: 'create', resource: 'clusterissuers', group: 'cert-manager.io' },
                { verb: 'list', resource: 'clusterissuers', group: 'cert-manager.io' },
                { verb: 'list', resource: 'ingressclasses', group: 'networking.k8s.io' },
                { verb: 'list', resource: 'customresourcedefinitions', group: 'apiextensions.k8s.io' },

                // Namespaced in our smoke namespace — what we can read/write at our place
                { verb: 'create', resource: 'issuers', group: 'cert-manager.io', namespace: smokeNs },
                { verb: 'create', resource: 'certificates', group: 'cert-manager.io', namespace: smokeNs },
                { verb: 'create', resource: 'secrets', group: '', namespace: smokeNs },
                { verb: 'get', resource: 'secrets', group: '', namespace: smokeNs },
                { verb: 'create', resource: 'ingresses', group: 'networking.k8s.io', namespace: smokeNs },

                // Namespaced в cert-manager — can we read at least what's installed there
                { verb: 'list', resource: 'pods', group: '', namespace: 'cert-manager' },
            ];

            for (const check of checks) {
                const allowed = await canI(check.verb, check.resource, check.group, check.namespace);
                const scope = check.namespace ? `ns:${check.namespace}` : 'cluster-scope';
                const groupLabel = check.group || 'core';
                const verdict = allowed ? 'ALLOWED' : 'DENIED';
                logger.info(`${verdict} — ${check.verb} ${check.resource} (${groupLabel}) [${scope}]`);
            }
        });

    });
});
