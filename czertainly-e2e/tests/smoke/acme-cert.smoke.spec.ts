/**
 * SMK-005 — issue a certificate through the platform's ACME endpoint, with cert-manager as the client.
 *
 * WHAT: the platform gets an ACME Profile on the run's RA Profile; cert-manager gets an Issuer
 * pointed at that profile's directory and a Certificate for one fresh name. The test passes when
 * cert-manager holds a certificate for that name AND the platform's inventory holds the same
 * certificate on our RA Profile — the second half is what proves the platform issued it.
 *
 * WHY: ACME is how most customers' machines get certificates without a person in the loop, and it
 * is a separate exposed path from the REST issuance SMK-004 covers: its own account handling,
 * nonces, orders, challenge validation and finalize.
 *
 * HOW: the HTTP-01 challenge is answered by cert-manager's own solver Ingress in the runner's
 * namespace, on `smk005-<ts>.<ACME_SOLVER_DOMAIN>`. That works only when the platform resolves the
 * name to the ingress of the runner's cluster, which is why the domain defaults to the one BASE_URL
 * is served under. Everything the test creates — in the cluster and in the platform — is removed in
 * afterEach, and anything that will not go is recorded in the cleanup ledger, failing the run.
 *
 * Needs a cluster: it skips outside one, since there is nowhere to run the ACME client.
 * The file also holds the SMOKE_RECON permission check that unblocked this test.
 */

import * as crypto from 'crypto';
import { APIRequestContext } from '@playwright/test';
import { test, expect, getAuthenticatedApiContext } from '../../fixtures/testFixtures';
import { getAuthorizationApi } from '../../utils/k8sClient';
import * as acmeProfileUtils from '../../utils/acmeProfileUtils';
import * as certManager from '../../utils/certManagerUtils';
import { findCertificateByFingerprint, revokeCertificate, deleteCertificate, waitForCertificateState } from '../../utils/certificateUtils';
import { attemptCleanup } from '../../utils/cleanupLedger';
import { readSmokeState, SmokeState } from '../../utils/smokeState';
import { Logger } from '../../utils/Logger';

const logger = new Logger('AcmeSmokeTest');

/** What one run put in the cluster and the platform, so afterEach removes exactly that. */
interface AcmeRun {
    namespace: string;
    issuerName: string;
    accountKeySecretName: string;
    certificateName: string;
    tlsSecretName: string;
    dnsName: string;
    acmeProfile?: acmeProfileUtils.AcmeProfileDto;
    k8sTouched: boolean;
}

/**
 * Every certificate the platform holds for this run's name. Found by name rather than by the one
 * the test saw, so a certificate issued after the test gave up waiting is removed too — otherwise
 * it keeps the RA Profile, and with it the whole PKI chain, from being deleted.
 */
async function certificatesFor(api: APIRequestContext, dnsName: string): Promise<string[]> {
    const resp = await api.post('/api/v1/certificates', {
        data: {
            itemsPerPage: 50, pageNumber: 1, includeArchived: false,
            filters: [{ fieldSource: 'property', fieldIdentifier: 'COMMON_NAME', condition: 'EQUALS', value: dnsName }],
        },
    });
    if (!resp.ok()) throw new Error(`Search for certificates of ${dnsName} failed: ${resp.status()} - ${await resp.text()}`);
    return ((await resp.json()) as { certificates: Array<{ uuid: string }> }).certificates.map((c) => c.uuid);
}

async function cleanUp(run: AcmeRun, state: SmokeState, api: APIRequestContext): Promise<void> {
    if (run.k8sTouched) {
        // The Certificate first: cert-manager then removes its Order, Challenge and solver itself.
        await attemptCleanup({ resource: 'k8s certificate', name: run.certificateName },
            () => certManager.deleteCertificate(run.namespace, run.certificateName));
        await attemptCleanup({ resource: 'k8s secret', name: run.tlsSecretName },
            () => certManager.deleteSecret(run.namespace, run.tlsSecretName));
        await attemptCleanup({ resource: 'k8s issuer', name: run.issuerName },
            () => certManager.deleteIssuer(run.namespace, run.issuerName));
        await attemptCleanup({ resource: 'k8s secret', name: run.accountKeySecretName },
            () => certManager.deleteSecret(run.namespace, run.accountKeySecretName));
    }

    let uuids: string[] = [];
    try {
        uuids = await certificatesFor(api, run.dnsName);
    } catch (e) {
        await attemptCleanup({ resource: 'certificate', name: run.dnsName }, () => Promise.reject(e));
    }
    for (const uuid of uuids) {
        await attemptCleanup({ resource: 'certificate', uuid, name: run.dnsName }, async () => {
            // Already revoked on the retry is fine — the delete is what matters. Revoke only queues
            // an action, and deleting before it has run makes it fail on a missing certificate
            // (core#2519), so wait for Revoked first.
            await revokeCertificate(api, { authorityUuid: state.authorityUuid, raProfileUuid: state.raProfileUuid, certUuid: uuid })
                .then(() => waitForCertificateState(api, uuid, 'revoked', 30_000))
                .catch((e) => logger.warn(`Revoke of ${uuid} failed, deleting anyway: ${e}`));
            await deleteCertificate(api, uuid);
        });
    }

    if (run.acmeProfile) {
        const profile = run.acmeProfile;
        await attemptCleanup({ resource: 'acmeProfile', uuid: profile.uuid, name: profile.name },
            () => acmeProfileUtils.deleteAcmeProfile(api, {
                uuid: profile.uuid, authorityUuid: state.authorityUuid, raProfileUuid: state.raProfileUuid,
            }));
    }
}

test.describe('@smoke acme', () => {
    let run: AcmeRun | undefined;

    test.afterEach(async ({ request, env }) => {
        const state = readSmokeState();
        if (!run || !state) return;
        const current = run;
        run = undefined;
        const api = await getAuthenticatedApiContext(request, env);
        try {
            await cleanUp(current, state, api);
        } finally {
            await api.dispose();
        }
    });

    test('SMK-005: issue certificate through ACME', async ({ request, env }) => {
        test.skip(!process.env.KUBERNETES_SERVICE_HOST && !env.kubeconfigPath,
            'Needs a cluster to run cert-manager in — runs in Testkube, or locally with KUBECONFIG_PATH.');
        test.setTimeout(5 * 60_000);  // issuer ~10s, challenge + issuance usually under a minute

        const state = readSmokeState();
        if (!state) {
            test.skip(true, 'Smoke fixtures not provisioned — globalSetup skipped');
            return;
        }

        const ts = Date.now();
        const thisRun: AcmeRun = {
            namespace: env.smoke.namespace!,
            issuerName: `smk005-issuer-${ts}`,
            accountKeySecretName: `smk005-account-${ts}`,
            certificateName: `smk005-cert-${ts}`,
            tlsSecretName: `smk005-tls-${ts}`,
            dnsName: `smk005-${ts}.${env.smoke.acmeSolverDomain}`,
            k8sTouched: false,
        };
        run = thisRun;
        logger.info(`ACME run: ${thisRun.dnsName}, ingress class ${env.smoke.acmeIngressClass}, namespace ${thisRun.namespace}`);

        const api = await getAuthenticatedApiContext(request, env);
        try {
            await test.step('Create and enable an ACME Profile on the run\'s RA Profile', async () => {
                thisRun.acmeProfile = await acmeProfileUtils.createAcmeProfile(api, {
                    name: `smoke-acme-${ts}`,
                    authorityUuid: state.authorityUuid,
                    raProfileUuid: state.raProfileUuid,
                });
            });

            await test.step('cert-manager registers an ACME account with the platform (Issuer Ready)', async () => {
                thisRun.k8sTouched = true;
                await certManager.createIssuer({
                    namespace: thisRun.namespace,
                    name: thisRun.issuerName,
                    directoryUrl: thisRun.acmeProfile!.directoryUrl,
                    accountKeySecretName: thisRun.accountKeySecretName,
                    ingressClassName: env.smoke.acmeIngressClass!,
                });
                await certManager.waitForIssuerReady(thisRun.namespace, thisRun.issuerName);
            });

            await test.step('cert-manager orders, answers HTTP-01 and receives the certificate (Certificate Ready)', async () => {
                await certManager.createCertificate({
                    namespace: thisRun.namespace,
                    name: thisRun.certificateName,
                    issuerName: thisRun.issuerName,
                    dnsName: thisRun.dnsName,
                    secretName: thisRun.tlsSecretName,
                });
                try {
                    await certManager.waitForCertificateReady(thisRun.namespace, thisRun.certificateName);
                } catch (e) {
                    // cert-manager's status only says what it last heard; the platform says what it did.
                    throw new Error(`${(e as Error).message}${await acmeProfileUtils.describePlatformSide(api, {
                        acmeProfileUuid: thisRun.acmeProfile!.uuid, dnsName: thisRun.dnsName,
                    })}`);
                }
            });

            let fingerprint = '';
            await test.step('The certificate in the Secret is for the requested name and currently valid', async () => {
                const { tlsCrt } = await certManager.readIssuedCertificate(thisRun.namespace, thisRun.tlsSecretName);
                const leaf = new crypto.X509Certificate(tlsCrt);  // parses the first PEM block — the leaf
                logger.info(`Issued: subject "${leaf.subject}", issuer "${leaf.issuer}", serial ${leaf.serialNumber}`);

                expect(leaf.checkHost(thisRun.dnsName), 'certificate covers the requested name').toBe(thisRun.dnsName);
                expect(leaf.subjectAltName, 'name is in subjectAltName').toContain(`DNS:${thisRun.dnsName}`);
                const now = Date.now();
                expect(new Date(leaf.validFrom).getTime(), 'already valid').toBeLessThanOrEqual(now + 5 * 60_000);
                expect(new Date(leaf.validTo).getTime(), 'not expired').toBeGreaterThan(now);
                expect(leaf.verify(leaf.publicKey), 'not self-signed — a CA issued it').toBe(false);

                fingerprint = leaf.fingerprint256.replace(/:/g, '').toLowerCase();
            });

            await test.step('The platform holds the same certificate, issued, on our RA Profile', async () => {
                let uuid: string | undefined;
                await expect.poll(async () => {
                    uuid = (await findCertificateByFingerprint(api, fingerprint))?.uuid;
                    return uuid;
                }, { message: `certificate ${fingerprint} never appeared in the inventory`, timeout: 30_000 }).toBeTruthy();

                const resp = await api.get(`/api/v1/certificates/${uuid}`);
                expect(resp.ok(), `GET certificate ${uuid}`).toBe(true);
                const detail = await resp.json() as { state: string; commonName: string; raProfile?: { uuid: string } };
                expect(detail.state).toBe('issued');
                expect(detail.commonName).toBe(thisRun.dnsName);
                expect(detail.raProfile?.uuid, 'issued through the run\'s RA Profile').toBe(state.raProfileUuid);
            });
        } finally {
            await api.dispose();
        }
    });
});

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
test.describe('@smoke acme reconnaissance', () => {
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

            // Every verb the test will actually use, not only the ones that start the work. Creating an
            // Issuer without being able to read it back means the run cannot tell whether the handshake
            // with the ACME endpoint succeeded, and without delete a run leaves objects behind, which
            // the suite now reports as a failure rather than tidying away quietly.
            const checks: Array<{ verb: string; resource: string; group: string; namespace?: string }> = [
                // Cluster-scope — expected to be denied, and nothing here is needed.
                { verb: 'list', resource: 'namespaces', group: '' },
                { verb: 'create', resource: 'clusterissuers', group: 'cert-manager.io' },
                { verb: 'list', resource: 'clusterissuers', group: 'cert-manager.io' },
                { verb: 'list', resource: 'ingressclasses', group: 'networking.k8s.io' },
                { verb: 'list', resource: 'customresourcedefinitions', group: 'apiextensions.k8s.io' },

                // The two objects the test writes itself: create them, watch them reach Ready, remove them.
                ...['create', 'get', 'list', 'watch', 'delete'].flatMap((verb) => [
                    { verb, resource: 'issuers', group: 'cert-manager.io', namespace: smokeNs },
                    { verb, resource: 'certificates', group: 'cert-manager.io', namespace: smokeNs },
                ]),

                // cert-manager's own objects, read only: where the reason lives when a challenge fails.
                ...['get', 'list', 'watch'].flatMap((verb) => [
                    { verb, resource: 'orders', group: 'acme.cert-manager.io', namespace: smokeNs },
                    { verb, resource: 'challenges', group: 'acme.cert-manager.io', namespace: smokeNs },
                ]),

                // The account key and the issued certificate both land in Secrets.
                ...['create', 'get', 'list', 'delete'].map((verb) => ({ verb, resource: 'secrets', group: '', namespace: smokeNs })),

                // Solver resources are cert-manager's to create, so these are expected to be denied.
                { verb: 'create', resource: 'ingresses', group: 'networking.k8s.io', namespace: smokeNs },
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
