/**
 * REG-USE-06.1 — A certificate issued through the cert-manager plugin (release checklist: Usage 6; ilm#430).
 *
 * Applies a CzertainlyIssuer driven by the run RA profile and a cert-manager Certificate for a run-prefixed DNS name; the
 * certificate is then in the ILM inventory under the run RA profile.
 *
 * Needs a cluster (the KUBECONFIG and REG_CM_* settings, see .env.example), otherwise it skips with the reason. The issuer,
 * Certificate and Secret are run-prefixed, recorded before they exist and removed by the `clusterRun` fixture after the test.
 * The ILM certificates of the run's DNS names are recorded again after the cleanup, because an issuance in flight can still land.
 */
import { expect, test } from '../../../fixtures/areas/clusterRun';
import { applyOwnManifest, getJsonPath, K8sRef, recordOwnK8sObject, waitReady } from '../../../utils/regression/kubernetesOwnObjects';
import { parseCertificate, sha256Fingerprint } from '../../../utils/regression/pkiBuilders';
import { getCertificate, searchCertificates, serverCreatedAfter } from '../../../utils/regression/apiReads';
import { checkedCommonName, runName } from '../../../utils/regression/ledger/runState';
import { testMeta, tags } from '../../../utils/regression/tags';
import { CERTIFICATE_READY_SECONDS, ISSUER_READY_SECONDS, LIFECYCLE_MS } from '../../../utils/regression/timeouts';
import { uniqueSuffix } from '../../../utils/regression/text';

test.describe('Certificate issue through cert-manager', { tag: tags.regression }, () => {
    test('an issuer driven by the RA profile uuid is Ready and its Certificate is issued by the run RA profile',
        testMeta({
            id: 'REG-USE-06.1', prio: 'P1', issue: 'ilm#430', needs: 'cluster',
            rule: [
                'the CRD requires apiUrl, authSecretName, raProfileUuid; raProfileName is optional and never read',
                'signing: GET /v1/raProfiles/{raProfileUuid}, v2 issue, annotation certificate-uuid',
            ],
        }),
        async ({ api, env, own, regressionEnv, clusterRun, ownRaProfile }) => {
            // Issuer Ready (120 s) + Certificate Ready (240 s) + inventory reads.
            test.setTimeout(LIFECYCLE_MS);
            const ra = ownRaProfile;
            // The `cluster` need has proven the cluster settings before this body runs.
            const { cmNamespace: ns, cmAuthSecret, cmCaBundleSecret, cmApiUrl } = regressionEnv;
            const stamp = uniqueSuffix();
            const issuer: K8sRef = { kind: 'CzertainlyIssuer', namespace: ns, name: runName(`issuer-${stamp}`) };
            const certName = runName(`cm-${stamp}`);
            const certificate: K8sRef = { kind: 'Certificate', namespace: ns, name: certName, resource: 'certificates.cert-manager.io' };
            const secret: K8sRef = { kind: 'Secret', namespace: ns, name: `${certName}-tls` };
            // The name is the certificate's common name and its DNS name alike, so the stricter common name limits apply to both.
            const dns = checkedCommonName(`${certName}.example.test`);
            const apiUrl = cmApiUrl ?? `${env.baseUrl.replace(/\/$/, '')}/api`;

            await test.step('Apply the CzertainlyIssuer (raProfileUuid) → Ready', async () => {
                clusterRun.objects.push(issuer);
                applyOwnManifest(issuer, {
                    apiVersion: 'czertainly-issuer.czertainly.com/v1alpha1',
                    kind: 'CzertainlyIssuer',
                    metadata: { name: issuer.name },
                    spec: {
                        apiUrl,
                        authSecretName: cmAuthSecret,
                        raProfileUuid: ra.uuid,
                        ...(cmCaBundleSecret ? { caBundleSecretName: cmCaBundleSecret } : {}),
                    },
                }, own.spec, 'cert-manager issuer of the run RA profile (raProfileUuid)');
                waitReady(issuer, ISSUER_READY_SECONDS);
            });

            const createdAfter = await serverCreatedAfter(api);
            clusterRun.issued.push({ dns, createdAfter });
            try {
                await test.step('Record the Secret, then apply the Certificate → Ready', async () => {
                    // cert-manager writes the Secret for the run: recorded BEFORE the Certificate exists, so a failing apply
                    // or wait still leaves it in the ledger, and the clusterRun fixture removes the Certificate before the Secret.
                    clusterRun.objects.push(secret);
                    recordOwnK8sObject(secret, own.spec, 'written by cert-manager for the run Certificate');
                    clusterRun.objects.push(certificate);
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
                    }, own.spec, 'cert-manager Certificate');
                    waitReady(certificate, CERTIFICATE_READY_SECONDS);
                });

                await test.step('The issued certificate is in the ILM inventory under the run RA profile', async () => {
                    const uuids = await own.issuedNamed(dns, createdAfter, `cert-manager certificate ${certName}`);
                    const tlsCrt = Buffer.from(getJsonPath(secret, '{.data.tls\\.crt}'), 'base64').toString('utf8');
                    const cert = parseCertificate(tlsCrt);
                    const found = await searchCertificates(api, [{ fieldSource: 'property', fieldIdentifier: 'FINGERPRINT', condition: 'EQUALS', value: sha256Fingerprint(cert) }]);
                    expect(found.length, 'the secret\'s certificate is in the inventory once').toBe(1);
                    expect(uuids, 'the certificate was issued for the run DNS name').toContain(found[0].uuid);
                    const detail = await getCertificate(api, found[0].uuid);
                    expect(detail.raProfile?.uuid, 'issued under the run RA profile').toBe(ra.uuid);
                    const annotation = getJsonPath(certificate, '{.metadata.annotations.czertainly-issuer\\.czertainly\\.com/certificate-uuid}');
                    expect(annotation.trim(), 'the Certificate annotation names the inventory certificate').toBe(found[0].uuid);
                });
            } finally {
                // Also after a failed wait (the CR may have reached core before it failed).
                await own.issuedNamed(dns, createdAfter, `cert-manager certificate ${certName} (recorded in finally)`);
            }
        });
});
