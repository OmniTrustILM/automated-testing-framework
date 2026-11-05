/**
 * kubernetesOwnObjects — kubectl for the specs that create Kubernetes objects: every object is run-prefixed and recorded as a `k8s:<Kind>`
 * ledger line before it is applied; specs never call child_process themselves.
 */
import { execFileSync } from 'child_process';
import { attemptCleanup } from '../cleanupLedger';
import { assertOwn, carriesRunPrefix, OwnObjectViolation } from './ledger/ownership';
import { OwnRef, recordCreated, recordDeleted } from './ledger/ledger';
import { runId } from './ledger/runState';
import { settings } from './run/settings';

export interface K8sRef {
    kind: string;
    namespace: string;
    name: string;
    resource?: string;
}

/**
 * The ledger "uuid" of a Kubernetes object: `<namespace>/<name>.<kind>`; the kind is part of the id so a Certificate and a Secret of one
 * name are two ledger objects.
 */
export const k8sUuid = (ref: K8sRef): string => `${ref.namespace}/${ref.name}.${ref.kind.toLowerCase()}`;

const ledgerType = (ref: K8sRef): string => `k8s:${ref.kind}`;
const resourceOf = (ref: K8sRef): string => ref.resource ?? ref.kind.toLowerCase();

export function runKubectl(namespace: string, args: string[], input?: string, timeoutMs = 240_000): string {
    const bin = settings().kubectlBin;
    return execFileSync(bin, ['-n', namespace, ...args], { input, encoding: 'utf8', timeout: timeoutMs, stdio: ['pipe', 'pipe', 'pipe'] });
}

function assertRunPrefixed(ref: K8sRef, helper: string): void {
    if (!carriesRunPrefix(ref.name, runId())) throw new OwnObjectViolation(helper, { uuid: k8sUuid(ref) }, `the name does not start with ${runId()}-`, ledgerType(ref));
}

export function recordOwnK8sObject(ref: K8sRef, spec: string, note?: string): OwnRef {
    assertRunPrefixed(ref, 'recordOwnK8sObject');
    return recordCreated(ledgerType(ref), { uuid: k8sUuid(ref), name: ref.name }, { spec, note });
}

/**
 * Record, then `kubectl apply` a run-prefixed manifest; the ledger line
 * comes first, so a failing apply never leaves an object without a line.
 */
export function applyOwnManifest(ref: K8sRef, manifest: { kind: string; metadata: { name: string } } & Record<string, unknown>, spec: string, note?: string): OwnRef {
    if (manifest.kind !== ref.kind || manifest.metadata.name !== ref.name) {
        throw new Error(`applyOwnManifest: the manifest (${manifest.kind} ${manifest.metadata.name}) is not the ref (${ref.kind} ${ref.name})`);
    }
    const own = recordOwnK8sObject(ref, spec, note);
    runKubectl(ref.namespace, ['apply', '-f', '-'], JSON.stringify(manifest));
    return own;
}

export const CERT_MANAGER_KINDS = ['czertainlyissuers.czertainly-issuer.czertainly.com', 'certificates.cert-manager.io'];

/**
 * Why the cluster cannot run the cert-manager flow in `namespace`, or undefined (read-only preflight). NAMESPACED probes only
 * (a runner may hold no cluster-scoped rights); kubectl's error text is never repeated (it may name the cluster).
 */
export function clusterProblem(namespace: string, kinds: string[] = CERT_MANAGER_KINDS): string | undefined {
    const canI = (verb: string, resource: string): boolean => {
        try {
            return runKubectl(namespace, ['auth', 'can-i', verb, resource], undefined, 30_000).trim() === 'yes';
        } catch {
            return false; // `can-i` exits 1 with "no"
        }
    };
    for (const kind of kinds) {
        try {
            runKubectl(namespace, ['get', kind, '-o', 'name'], undefined, 30_000);
        } catch {
            return `${kind} cannot be listed in namespace ${namespace} (cert-manager / ILM issuer not installed, or no access)`;
        }
        if (!canI('create', kind)) return `no permission to create ${kind} in namespace ${namespace}`;
        if (!canI('delete', kind)) return `no permission to delete ${kind} in namespace ${namespace} (the spec removes its own objects)`;
    }
    if (!canI('get', 'secrets')) return `no permission to read secrets in namespace ${namespace}`;
    if (!canI('delete', 'secrets')) return `no permission to delete secrets in namespace ${namespace} (the spec removes its own Secret)`;
    return undefined;
}

export function waitReady(ref: K8sRef, timeoutSeconds: number): void {
    runKubectl(ref.namespace, ['wait', '--for=condition=Ready', `${resourceOf(ref)}/${ref.name}`, `--timeout=${timeoutSeconds}s`], undefined, (timeoutSeconds + 30) * 1000);
}

export function getJsonPath(ref: K8sRef, jsonPath: string): string {
    return runKubectl(ref.namespace, ['get', resourceOf(ref), ref.name, '-o', `jsonpath=${jsonPath}`]);
}

/**
 * afterAll of a spec that applied objects: delete each own object (newest first), prove it gone, append its `deleted` line; an object not
 * proven own is refused; failures go to the cleanup ledger and do not throw.
 */
export async function removeOwnK8sObject(refs: K8sRef[], spec: string): Promise<void> {
    for (const ref of [...refs].reverse()) {
        await attemptCleanup({ resource: ledgerType(ref), uuid: k8sUuid(ref), name: ref.name }, async () => {
            assertRunPrefixed(ref, 'removeOwnK8sObject');
            assertOwn({ uuid: k8sUuid(ref) }, 'removeOwnK8sObject');
            runKubectl(ref.namespace, ['delete', resourceOf(ref), ref.name, '--ignore-not-found', '--wait=true', '--timeout=120s'], undefined, 150_000);
            const left = runKubectl(ref.namespace, ['get', resourceOf(ref), ref.name, '--ignore-not-found', '-o', 'name']).trim();
            if (left) throw new Error(`${ref.kind} ${k8sUuid(ref)} is still there after the delete`);
            recordDeleted(ledgerType(ref), { uuid: k8sUuid(ref), name: ref.name }, spec, 'removed by the spec afterAll (k8s contract)');
        });
    }
}
