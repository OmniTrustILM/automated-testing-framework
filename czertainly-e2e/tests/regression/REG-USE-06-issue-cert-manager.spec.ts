/**
 * REG-USE-06 — Issue certificate using the cert-manager plugin (release checklist: Usage 6).
 *
 * Needs a Kubernetes cluster with cert-manager and the ILM issuer (czertainly-issuer.czertainly.com/v1alpha1)
 * installed, and kubectl on the PATH (or REG_KUBECTL_BIN). Skipped with the named reason unless these are set and
 * usable (preflight in beforeAll: `requireTool('kubectl')`, then `clusterProblem`: NAMESPACED probes — both custom
 * resource kinds can be listed in REG_CM_NAMESPACE, and `auth can-i` create / delete on them and get / delete secrets):
 *   KUBECONFIG                    kubeconfig of that cluster
 *   REG_CM_NAMESPACE              existing namespace the test may create resources in
 *   REG_CM_AUTH_SECRET            existing secret there: kubernetes.io/tls (mTLS) or Opaque (OAuth2 client credentials)
 *                                 of an ILM user allowed to issue on the run RA profile
 *   REG_CM_CA_BUNDLE_SECRET       optional, secret with ca.crt to trust the ILM API
 *   REG_CM_API_URL                optional, ILM API URL as seen from the cluster (default: BASE_URL + /api)
 *
 * Flow: CzertainlyIssuer (`raProfileUuid` = the run RA profile) → Ready → Certificate → Ready → the secret's tls.crt is
 * in the ILM inventory under the run RA profile, and the Certificate carries the
 * czertainly-issuer.czertainly.com/certificate-uuid annotation.
 * REG-USE-06.1 (B1 fix, protocols §5.2 rules 1–2, C-M1): the issuer CRD REQUIRES `raProfileUuid`; `raProfileName` is
 * optional and never read by the issuer, so the release check's `raProfileName` made the signer fail ("RA profile UUID
 * is not set"). The issuer is now driven by the uuid only; the manual case (release/main-regression/test-cases.md
 * REG-USE-06 step 3, N2) was corrected the same way.
 * Own objects only (decision D1, review Q14): the issuer, the Certificate and the Secret cert-manager writes are
 * run-prefixed (a time suffix keeps them unique under --repeat-each), recorded as `k8s:<Kind>` ledger lines before they
 * exist (utils/regression/k8s.ts; the ledger id carries the kind) and removed by this spec's afterAll (`removeOwnK8s`:
 * ledger check, delete, absence proof, `deleted` line) in the order Certificate → Secret → issuer (B1 fix pass, Sonnet F1:
 * the Secret is recorded BEFORE the Certificate is applied and is named `<certificate>-tls`; deleting the Secret first
 * made cert-manager issue a successor). The ILM certificate(s) of the run's DNS name and their linked keys are recorded
 * right after the wait, again in a `finally` (a failed or timed-out wait still records what cert-manager made: Sonnet
 * F2) and once more in afterAll after the k8s objects are gone, after a short API-state poll (safety net: an issuance in flight
 * when the Certificate was deleted still lands; `recordIssuedSettled`, Fable F3); the run-end teardown deletes them. The auth and CA-bundle secrets exist before the run and are
 * only referenced. kubectl runs only through utils/regression/k8s.ts and tools.ts (specs never spawn processes).
 */
import { expect, test } from '../../fixtures/testFixtures';
import { applyOwn, clusterProblem, getJsonPath, K8sRef, recordOwnK8s, removeOwnK8s, waitReady } from '../../utils/regression/k8s';
import { parseCertificate, sha256Fingerprint } from '../../utils/regression/pki';
import {
    ensureRaProfileOrSkip, getCertificate, recordIssuedNamed, recordIssuedSettled, searchCertificates, serverCreatedAfter,
} from '../../utils/regression/regressionApi';
import { regName } from '../../utils/regression/regressionRun';
import { meta } from '../../utils/regression/tags';
import { requireTool } from '../../utils/regression/tools';

const SPEC = 'REG-USE-06';
const ns = process.env.REG_CM_NAMESPACE ?? '';

test.describe('@regression REG-USE-06 issue via cert-manager', () => {
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
        test.setTimeout(420_000);
        await removeOwnK8s(recorded, SPEC);
        // Safety net (Sonnet F2, Fable F3): after the k8s objects are gone, record every ILM certificate (and its key) issued
        // for the run's DNS names, after a short API-state poll — an issuance that was in flight when the Certificate was
        // deleted can still land (`recordIssuedSettled`: two equal reads, none requested / pending; no fixed sleep).
        for (const { dns, createdAfter } of issued) await recordIssuedSettled(api, dns, createdAfter, SPEC, 'cert-manager certificate (afterAll safety net)');
    });

    test('REG-USE-06.1: a CzertainlyIssuer driven by raProfileUuid (no raProfileName) is Ready and its Certificate is issued by the run RA profile',
        meta({
            id: 'REG-USE-06.1', prio: 'P1', issue: 'ilm#430', needs: 'cluster',
            rule: [
                'protocols §5.2 rule 1 (the CRD requires apiUrl, authSecretName, raProfileUuid) and rule 2 (raProfileName optional, never read)',
                'protocols §5.2 rules 11, 14 (signing: GET /v1/raProfiles/{raProfileUuid}, v2 issue, annotation certificate-uuid); C-M1 (the release plan used raProfileName)',
            ],
        }),
        async ({ api, env }) => {
            // Issuer Ready (120 s) + Certificate Ready (240 s) + inventory reads.
            test.setTimeout(420_000);
            const ra = await test.step('Prerequisite: the run RA profile (CA-agnostic)', async () => ensureRaProfileOrSkip(api, SPEC, (reason) => test.skip(true, reason)));
            const stamp = Date.now().toString(36);
            const issuer: K8sRef = { kind: 'CzertainlyIssuer', namespace: ns, name: regName(`issuer-${stamp}`) };
            const certName = regName(`cm-${stamp}`);
            const certificate: K8sRef = { kind: 'Certificate', namespace: ns, name: certName, resource: 'certificates.cert-manager.io' };
            const secret: K8sRef = { kind: 'Secret', namespace: ns, name: `${certName}-tls` };
            const dns = `${certName}.example.test`;
            const apiUrl = process.env.REG_CM_API_URL ?? `${env.baseUrl.replace(/\/$/, '')}/api`;

            await test.step('Apply the CzertainlyIssuer (raProfileUuid) → Ready', async () => {
                recorded.push(issuer);
                applyOwn(issuer, {
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
                    recordOwnK8s(secret, SPEC, 'written by cert-manager for the run Certificate');
                    recorded.push(certificate);
                    applyOwn(certificate, {
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
                // Sonnet F2: also after a failed wait (the CR may have reached core before it failed).
                await recordIssuedNamed(api, dns, createdAfter, SPEC, `cert-manager certificate ${certName} (recorded in finally)`);
            }
        });
});
