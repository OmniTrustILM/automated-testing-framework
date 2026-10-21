/**
 * REG-USE-06 — a certificate issued through the cert-manager plugin (release checklist: Usage 6): a CzertainlyIssuer
 * driven by `raProfileUuid` is Ready, its Certificate is Ready and the secret's certificate is in the inventory under the
 * run RA profile. Needs a cluster (KUBECONFIG, REG_CM_NAMESPACE, REG_CM_AUTH_SECRET; optional REG_CM_CA_BUNDLE_SECRET,
 * REG_CM_API_URL), else skipped with the reason. The issuer, Certificate and Secret are run-prefixed, recorded before they
 * exist and removed in afterAll; the ILM certificates of the run's DNS names are recorded, also after the cluster cleanup.
 */
import { expect, test } from '../../fixtures/testFixtures';
import { applyOwnManifest, clusterProblem, getJsonPath, K8sRef, recordOwnK8sObject, removeOwnK8sObject, waitReady } from '../../utils/regression/kubernetesOwnObjects';
import { parseCertificate, sha256Fingerprint } from '../../utils/regression/pkiBuilders';
import { getCertificate, searchCertificates, serverCreatedAfter } from '../../utils/regression/apiReads';
import { recordIssuedNamed, recordIssuedSettled } from '../../utils/regression/issuedRecords';
import { runName } from '../../utils/regression/ledger/runState';
import { testMeta, tags } from '../../utils/regression/tags';
import { LIFECYCLE_MS } from '../../utils/regression/timeouts';
import { requireTool } from '../../utils/regression/requireTool';

const SPEC = 'REG-USE-06';
const ns = process.env.REG_CM_NAMESPACE ?? '';

test.describe('Certificate issue through cert-manager', { tag: tags.regression }, () => {
    test.skip(!process.env.KUBECONFIG || !ns || !process.env.REG_CM_AUTH_SECRET, 'cert-manager flow needs KUBECONFIG, REG_CM_NAMESPACE and REG_CM_AUTH_SECRET (no cluster configured)');

    test.beforeAll(() => {
        // Preflight at run time, never at collection (a `--list` runs no tool): the tool, then the namespaced probes.
        const tool = requireTool('kubectl');
        test.skip(!!tool, `@needs:cluster — ${tool}`);
        const cluster = clusterProblem(ns);
        test.skip(!!cluster, `@needs:cluster — ${cluster}`);
    });

    /** Every Kubernetes object this spec recorded, in recording order (removed newest first: Certificate, Secret, issuer). */
    const recorded: K8sRef[] = [];
    /** The run's Certificates: their DNS names and the server time before they were applied (for the derived keys). */
    const issued: Array<{ dns: string; createdAfter: string | undefined }> = [];

    test.afterAll(async ({ api }) => {
        // The hook's own budget: the kubectl deletes (up to 150 s each) come first, then the settle poll.
        test.setTimeout(LIFECYCLE_MS);
        await removeOwnK8sObject(recorded, SPEC);
        // Safety net: after the k8s objects are gone, record every ILM certificate (and its key) issued
        // for the run's DNS names, after a short API-state poll — an issuance that was in flight when the Certificate was
        // deleted can still land (`recordIssuedSettled`: two equal reads, none requested / pending; no fixed sleep).
        for (const { dns, createdAfter } of issued) await recordIssuedSettled(api, dns, createdAfter, SPEC, 'cert-manager certificate (afterAll safety net)');
    });

    test('an issuer driven by the RA profile uuid is Ready and its Certificate is issued by the run RA profile',
        testMeta({
            id: 'REG-USE-06.1', prio: 'P1', issue: 'ilm#430', needs: 'cluster',
            rule: [
                'the CRD requires apiUrl, authSecretName, raProfileUuid; raProfileName is optional and never read',
                'signing: GET /v1/raProfiles/{raProfileUuid}, v2 issue, annotation certificate-uuid',
            ],
        }),
        async ({ api, env, ownRaProfile }) => {
            // Issuer Ready (120 s) + Certificate Ready (240 s) + inventory reads.
            test.setTimeout(LIFECYCLE_MS);
            const ra = ownRaProfile;
            const stamp = Date.now().toString(36);
            const issuer: K8sRef = { kind: 'CzertainlyIssuer', namespace: ns, name: runName(`issuer-${stamp}`) };
            const certName = runName(`cm-${stamp}`);
            const certificate: K8sRef = { kind: 'Certificate', namespace: ns, name: certName, resource: 'certificates.cert-manager.io' };
            const secret: K8sRef = { kind: 'Secret', namespace: ns, name: `${certName}-tls` };
            const dns = `${certName}.example.test`;
            const apiUrl = process.env.REG_CM_API_URL ?? `${env.baseUrl.replace(/\/$/, '')}/api`;

            await test.step('Apply the CzertainlyIssuer (raProfileUuid) → Ready', async () => {
                recorded.push(issuer);
                applyOwnManifest(issuer, {
                    apiVersion: 'czertainly-issuer.czertainly.com/v1alpha1',
                    kind: 'CzertainlyIssuer',
                    metadata: { name: issuer.name },
                    spec: {
                        apiUrl,
                        authSecretName: process.env.REG_CM_AUTH_SECRET,
                        raProfileUuid: ra.uuid,
                        ...(process.env.REG_CM_CA_BUNDLE_SECRET ? { caBundleSecretName: process.env.REG_CM_CA_BUNDLE_SECRET } : {}),
                    },
                }, SPEC, 'cert-manager issuer of the run RA profile (raProfileUuid)');
                waitReady(issuer, 120);
            });

            const createdAfter = await serverCreatedAfter(api);
            issued.push({ dns, createdAfter });
            try {
                await test.step('Record the Secret, then apply the Certificate → Ready', async () => {
                    // cert-manager writes the Secret for the run: recorded BEFORE the Certificate exists, so a failing apply
                    // or wait still leaves it in the ledger, and the afterAll removes the Certificate before the Secret.
                    recorded.push(secret);
                    recordOwnK8sObject(secret, SPEC, 'written by cert-manager for the run Certificate');
                    recorded.push(certificate);
                    applyOwnManifest(certificate, {
                        apiVersion: 'cert-manager.io/v1',
                        kind: 'Certificate',
                        metadata: { name: certName },
                        spec: {
                            secretName: secret.name,
                            commonName: dns,
                            dnsNames: [dns],
                            issuerRef: { group: 'czertainly-issuer.czertainly.com', kind: 'CzertainlyIssuer', name: issuer.name },
                        },
                    }, SPEC, 'cert-manager Certificate');
                    waitReady(certificate, 240);
                });

                await test.step('The issued certificate is in the ILM inventory under the run RA profile', async () => {
                    const uuids = await recordIssuedNamed(api, dns, createdAfter, SPEC, `cert-manager certificate ${certName}`);
                    const tlsCrt = Buffer.from(getJsonPath(secret, '{.data.tls\\.crt}'), 'base64').toString('utf8');
                    const cert = parseCertificate(tlsCrt);
                    const found = await searchCertificates(api, [{ fieldSource: 'property', fieldIdentifier: 'FINGERPRINT', condition: 'EQUALS', value: sha256Fingerprint(cert) }]);
                    expect(found.length).toBe(1);
                    expect(uuids).toContain(found[0].uuid);
                    const detail = await getCertificate(api, found[0].uuid);
                    expect(detail.raProfile?.uuid).toBe(ra.uuid);
                    const annotation = getJsonPath(certificate, '{.metadata.annotations.czertainly-issuer\\.czertainly\\.com/certificate-uuid}');
                    expect(annotation.trim()).toBe(found[0].uuid);
                });
            } finally {
                // Also after a failed wait (the CR may have reached core before it failed).
                await recordIssuedNamed(api, dns, createdAfter, SPEC, `cert-manager certificate ${certName} (recorded in finally)`);
            }
        });
});
