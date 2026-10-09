/**
 * certManagerUtils — the cert-manager side of SMK-005: an ACME client that lives in the cluster.
 *
 * WHAT: writes an Issuer pointed at the platform's ACME directory and a Certificate that asks it
 * for one name, waits for each to become Ready, reads the issued certificate out of its Secret,
 * and removes all of it again.
 *
 * WHY: cert-manager is a real, widely used ACME client, so a certificate it obtains from the
 * platform proves the ACME endpoint works the way customers will use it — account registration,
 * order, HTTP-01 challenge, finalize, download — without us reimplementing any of the protocol.
 *
 * HOW: cert-manager.io/v1 objects through the CustomObjectsApi, in the runner's own namespace.
 * Readiness is polled from `status.conditions`. When a wait runs out, the error carries what
 * cert-manager said about the Order and the Challenge (acme.cert-manager.io), because "not Ready
 * after 3 minutes" alone does not say whether the platform refused, the solver was unreachable,
 * or the account never registered. The solver pod, service and ingress are cert-manager's own;
 * nothing here creates or needs permission for them.
 */

import { getCoreApi, getCustomObjectsApi } from './k8sClient';
import { Logger } from './Logger';

const logger = new Logger('CertManagerUtils');

const CM_GROUP = 'cert-manager.io';
const ACME_GROUP = 'acme.cert-manager.io';
const VERSION = 'v1';

interface Condition { type: string; status: string; reason?: string; message?: string }
interface K8sObject {
    metadata?: { name?: string; ownerReferences?: Array<{ kind: string; name: string }> };
    spec?: Record<string, any>;
    status?: { conditions?: Condition[]; state?: string; reason?: string; presented?: boolean; processing?: boolean };
}

/** The client raises ApiException with the HTTP status in `code`. */
function isNotFound(e: unknown): boolean {
    return (e as { code?: number })?.code === 404;
}

function readyCondition(obj: K8sObject): Condition | undefined {
    return obj.status?.conditions?.find((c) => c.type === 'Ready');
}

export interface CreateIssuerOptions {
    namespace: string;
    name: string;
    directoryUrl: string;
    /** Secret cert-manager creates to hold the ACME account key. */
    accountKeySecretName: string;
    ingressClassName: string;
}

export async function createIssuer(options: CreateIssuerOptions): Promise<void> {
    logger.info(`Creating Issuer ${options.namespace}/${options.name} → ${options.directoryUrl}`);
    await getCustomObjectsApi().createNamespacedCustomObject({
        group: CM_GROUP, version: VERSION, namespace: options.namespace, plural: 'issuers',
        body: {
            apiVersion: `${CM_GROUP}/${VERSION}`,
            kind: 'Issuer',
            metadata: { name: options.name, labels: { 'app.kubernetes.io/managed-by': 'atf-smoke' } },
            spec: {
                acme: {
                    server: options.directoryUrl,
                    privateKeySecretRef: { name: options.accountKeySecretName },
                    solvers: [{ http01: { ingress: { ingressClassName: options.ingressClassName } } }],
                },
            },
        },
    });
}

export interface CreateCertificateOptions {
    namespace: string;
    name: string;
    issuerName: string;
    dnsName: string;
    /** Secret cert-manager writes the issued certificate and its key into. */
    secretName: string;
}

export async function createCertificate(options: CreateCertificateOptions): Promise<void> {
    logger.info(`Creating Certificate ${options.namespace}/${options.name} for ${options.dnsName}`);
    await getCustomObjectsApi().createNamespacedCustomObject({
        group: CM_GROUP, version: VERSION, namespace: options.namespace, plural: 'certificates',
        body: {
            apiVersion: `${CM_GROUP}/${VERSION}`,
            kind: 'Certificate',
            metadata: { name: options.name, labels: { 'app.kubernetes.io/managed-by': 'atf-smoke' } },
            spec: {
                secretName: options.secretName,
                commonName: options.dnsName,
                dnsNames: [options.dnsName],
                privateKey: { algorithm: 'RSA', size: 2048, rotationPolicy: 'Always' },
                issuerRef: { name: options.issuerName, kind: 'Issuer', group: CM_GROUP },
            },
        },
    });
}

async function getObject(namespace: string, plural: string, name: string): Promise<K8sObject> {
    return await getCustomObjectsApi().getNamespacedCustomObject({
        group: CM_GROUP, version: VERSION, namespace, plural, name,
    }) as K8sObject;
}

/**
 * Polls `plural/name` until its Ready condition is True; on timeout throws with the last
 * condition and whatever `explain` can find.
 */
async function waitForReady(
    namespace: string,
    plural: 'issuers' | 'certificates',
    name: string,
    timeoutMs: number,
    explain: () => Promise<string>,
): Promise<void> {
    const deadline = Date.now() + timeoutMs;
    let last: Condition | undefined;
    while (Date.now() < deadline) {
        last = readyCondition(await getObject(namespace, plural, name));
        if (last?.status === 'True') {
            logger.info(`${plural}/${name} is Ready (${last.reason ?? 'no reason'})`);
            return;
        }
        // A False here is not final: cert-manager retries a failed account registration or order
        // with backoff, and a transient network error looks exactly like a refusal at first.
        await new Promise((r) => setTimeout(r, 3000));
    }
    const state = last ? `Ready=${last.status} reason=${last.reason ?? '-'} message=${last.message ?? '-'}` : 'no Ready condition yet';
    throw new Error(`${plural}/${name} did not become Ready within ${timeoutMs / 1000}s: ${state}${await explain()}`);
}

export async function waitForIssuerReady(namespace: string, name: string, timeoutMs = 60_000): Promise<void> {
    await waitForReady(namespace, 'issuers', name, timeoutMs, async () => '');
}

export async function waitForCertificateReady(namespace: string, name: string, timeoutMs = 180_000): Promise<void> {
    await waitForReady(namespace, 'certificates', name, timeoutMs, () => describeAcmeProgress(namespace, name));
}

/**
 * What cert-manager knows about the Orders and Challenges behind one Certificate. The Challenge
 * `reason` is where the actual answer usually is: the self-check could not reach the solver, the
 * platform marked the challenge invalid, and so on.
 */
export async function describeAcmeProgress(namespace: string, certificateName: string): Promise<string> {
    try {
        const api = getCustomObjectsApi();
        const list = async (plural: string) =>
            ((await api.listNamespacedCustomObject({ group: ACME_GROUP, version: VERSION, namespace, plural })) as { items: K8sObject[] }).items;

        // Orders are owned by a CertificateRequest named <certificate>-<n>; matching the prefix
        // keeps another run's objects out of this one's report.
        const mine = (o: K8sObject) => (o.metadata?.name ?? '').startsWith(`${certificateName}-`);
        const orders = (await list('orders')).filter(mine);
        const challenges = (await list('challenges')).filter(mine);

        const lines = [
            ...orders.map((o) => `  order ${o.metadata?.name}: state=${o.status?.state ?? '-'} reason=${o.status?.reason ?? '-'}`),
            ...challenges.map((c) =>
                `  challenge ${c.metadata?.name} (${c.spec?.type} ${c.spec?.dnsName}): state=${c.status?.state ?? '-'} ` +
                `presented=${c.status?.presented ?? '-'} reason=${c.status?.reason ?? '-'}`),
        ];
        return lines.length ? `\ncert-manager ACME progress:\n${lines.join('\n')}` : '\ncert-manager created no Order for it.';
    } catch (e) {
        return `\n(could not read Orders/Challenges: ${e})`;
    }
}

export interface IssuedCertificate {
    /** PEM, leaf first, then whatever chain the platform returned. */
    tlsCrt: string;
}

export async function readIssuedCertificate(namespace: string, secretName: string): Promise<IssuedCertificate> {
    const secret = await getCoreApi().readNamespacedSecret({ name: secretName, namespace });
    const b64 = secret.data?.['tls.crt'];
    if (!b64) {
        throw new Error(`Secret ${namespace}/${secretName} has no tls.crt`);
    }
    return { tlsCrt: Buffer.from(b64, 'base64').toString('utf-8') };
}

async function deleteCustom(group: string, namespace: string, plural: string, name: string): Promise<void> {
    try {
        await getCustomObjectsApi().deleteNamespacedCustomObject({ group, version: VERSION, namespace, plural, name });
        logger.info(`Deleted ${plural}/${name}`);
    } catch (e) {
        if (!isNotFound(e)) throw e;
    }
}

export async function deleteCertificate(namespace: string, name: string): Promise<void> {
    await deleteCustom(CM_GROUP, namespace, 'certificates', name);
}

export async function deleteIssuer(namespace: string, name: string): Promise<void> {
    await deleteCustom(CM_GROUP, namespace, 'issuers', name);
}

/**
 * cert-manager does not delete the Secrets it writes when the Certificate or Issuer goes away —
 * that is deliberate on its side, so a deleted Certificate does not take a live key with it. For
 * a smoke run it means the Secrets are ours to remove.
 */
export async function deleteSecret(namespace: string, name: string): Promise<void> {
    try {
        await getCoreApi().deleteNamespacedSecret({ name, namespace });
        logger.info(`Deleted secret/${name}`);
    } catch (e) {
        if (!isNotFound(e)) throw e;
    }
}
