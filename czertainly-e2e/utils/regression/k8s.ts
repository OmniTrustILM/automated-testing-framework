/**
 * k8s — kubectl for the specs that create Kubernetes objects (REG-USE-06; later REG-PROT-19…21), under the R27 contract
 * (review Q14):
 * - every object carries the run prefix and is recorded as a `k8s:<Kind>` ledger line BEFORE it is applied (its ledger
 *   "uuid" is `<namespace>/<name>.<kind>`, known up front), so an apply or a wait that fails can never leave an unrecorded
 *   object; an object a controller writes for the run (the Secret cert-manager fills) is recorded as soon as the spec
 *   knows its name (`recordOwnK8s`);
 * - the spec removes them in its own `afterAll` through `removeOwnK8s`: each one is checked against the ledger (a
 *   `k8s:` line of this run, run-prefixed name) before `kubectl delete`, absence is proven by `kubectl get`, and the
 *   `deleted` line is appended; a failure goes to the cleanup ledger (attemptCleanup), so the run ends red;
 * - the run-end teardown never deletes k8s objects and reports a live `k8s:` line as a leftover.
 * kubectl comes from REG_KUBECTL_BIN, else `kubectl` on the PATH; KUBECONFIG selects the cluster. Specs never call
 * child_process themselves (specGuards).
 */
import { execFileSync } from 'child_process';
import { attemptCleanup } from '../cleanupLedger';
import { assertOwn, carriesRunPrefix, OwnObjectViolation } from './ownObjects';
import { OwnRef, recordCreated, recordDeleted, RUN_ID } from './regressionRun';

export interface K8sRef {
    /** The object's kind as in its manifest (CzertainlyIssuer, Certificate, Secret). */
    kind: string;
    namespace: string;
    name: string;
    /** The kubectl resource name when the kind alone is ambiguous (e.g. `certificates.cert-manager.io`). */
    resource?: string;
}

/**
 * The ledger "uuid" of a Kubernetes object: `<namespace>/<name>.<kind, lower case>` (the name carries the run prefix).
 * B1 fix pass (Sonnet F1, Fable F1): the kind is part of the id, so a Certificate and a Secret of the same name are two
 * ledger objects — with `<namespace>/<name>` alone the Secret's `deleted` line closed the Certificate's line too and the
 * Certificate was never removed. The shape stays the ledger's `<namespace>/<name>` (regressionRun.ts K8S_ID: the name
 * part may hold dots).
 */
export const k8sUuid = (ref: K8sRef): string => `${ref.namespace}/${ref.name}.${ref.kind.toLowerCase()}`;

const ledgerType = (ref: K8sRef): string => `k8s:${ref.kind}`;
const resourceOf = (ref: K8sRef): string => ref.resource ?? ref.kind.toLowerCase();

/** kubectl in the object's namespace; throws with kubectl's stderr on a non-zero exit. */
export function kubectl(namespace: string, args: string[], input?: string, timeoutMs = 240_000): string {
    const bin = process.env.REG_KUBECTL_BIN || 'kubectl';
    return execFileSync(bin, ['-n', namespace, ...args], { input, encoding: 'utf8', timeout: timeoutMs, stdio: ['pipe', 'pipe', 'pipe'] });
}

function assertRunPrefixed(ref: K8sRef, helper: string): void {
    if (!carriesRunPrefix(ref.name, RUN_ID)) throw new OwnObjectViolation(helper, { uuid: k8sUuid(ref) }, `the name does not start with ${RUN_ID}-`, ledgerType(ref));
}

/** Record an object the run owns (before it exists, or one a controller wrote for the run); returns its OwnRef. */
export function recordOwnK8s(ref: K8sRef, spec: string, note?: string): OwnRef {
    assertRunPrefixed(ref, 'recordOwnK8s');
    return recordCreated(ledgerType(ref), { uuid: k8sUuid(ref), name: ref.name }, spec, note);
}

/**
 * Record, then `kubectl apply` a run-prefixed manifest (its kind and name must be the ref's). The ledger line comes
 * first: a failing apply leaves a line whose object the afterAll finds absent, never an object without a line.
 */
export function applyOwn(ref: K8sRef, manifest: { kind: string; metadata: { name: string } } & Record<string, unknown>, spec: string, note?: string): OwnRef {
    if (manifest.kind !== ref.kind || manifest.metadata.name !== ref.name) {
        throw new Error(`applyOwn: the manifest (${manifest.kind} ${manifest.metadata.name}) is not the ref (${ref.kind} ${ref.name})`);
    }
    const own = recordOwnK8s(ref, spec, note);
    kubectl(ref.namespace, ['apply', '-f', '-'], JSON.stringify(manifest));
    return own;
}

/** The custom resources REG-USE-06 creates in its namespace: the ILM issuer and cert-manager's Certificate. */
export const CERT_MANAGER_KINDS = ['czertainlyissuers.czertainly-issuer.czertainly.com', 'certificates.cert-manager.io'];

/**
 * Why the cluster cannot run the cert-manager flow in `namespace`, or undefined (REG-USE-06.1 preflight, read-only).
 * B1 fix pass (Sonnet F7): NAMESPACED probes only — a runner may hold rights in its namespace and none on cluster-scoped
 * objects (namespaces, CRDs), so a cluster-scoped read would skip a usable cluster. Per kind of CERT_MANAGER_KINDS:
 * `kubectl -n <ns> get <kind> -o name` (the kind exists and can be listed there) and `kubectl -n <ns> auth can-i create
 * <kind>` must answer `yes`; then `auth can-i get secrets` (the spec reads the Secret cert-manager writes) and
 * `auth can-i delete` on each kind and on secrets (the spec's afterAll removes them). kubectl's own error text is never
 * repeated (it may name the cluster).
 */
export function clusterProblem(namespace: string, kinds: string[] = CERT_MANAGER_KINDS): string | undefined {
    const canI = (verb: string, resource: string): boolean => {
        try {
            return kubectl(namespace, ['auth', 'can-i', verb, resource], undefined, 30_000).trim() === 'yes';
        } catch {
            return false; // `can-i` exits 1 with "no"
        }
    };
    for (const kind of kinds) {
        try {
            kubectl(namespace, ['get', kind, '-o', 'name'], undefined, 30_000);
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

/** `kubectl wait --for=condition=Ready` on an own object. */
export function waitReady(ref: K8sRef, timeoutSeconds: number): void {
    kubectl(ref.namespace, ['wait', '--for=condition=Ready', `${resourceOf(ref)}/${ref.name}`, `--timeout=${timeoutSeconds}s`], undefined, (timeoutSeconds + 30) * 1000);
}

/** `kubectl get <resource> <name> -o jsonpath=<path>` (read-only). */
export function getJsonPath(ref: K8sRef, jsonPath: string): string {
    return kubectl(ref.namespace, ['get', resourceOf(ref), ref.name, '-o', `jsonpath=${jsonPath}`]);
}

/**
 * afterAll of a spec that applied Kubernetes objects: delete each own object (newest first), prove it gone, append its
 * `deleted` line. An object the ledger does not prove as this run's is refused, never deleted. Failures are recorded in
 * the cleanup ledger (the run ends red); the function itself does not throw for them.
 */
export async function removeOwnK8s(refs: K8sRef[], spec: string): Promise<void> {
    for (const ref of [...refs].reverse()) {
        await attemptCleanup({ resource: ledgerType(ref), uuid: k8sUuid(ref), name: ref.name }, async () => {
            assertRunPrefixed(ref, 'removeOwnK8s');
            assertOwn({ uuid: k8sUuid(ref) }, 'removeOwnK8s');
            kubectl(ref.namespace, ['delete', resourceOf(ref), ref.name, '--ignore-not-found', '--wait=true', '--timeout=120s'], undefined, 150_000);
            const left = kubectl(ref.namespace, ['get', resourceOf(ref), ref.name, '--ignore-not-found', '-o', 'name']).trim();
            if (left) throw new Error(`${ref.kind} ${k8sUuid(ref)} is still there after the delete`);
            recordDeleted(ledgerType(ref), { uuid: k8sUuid(ref), name: ref.name }, spec, 'removed by the spec afterAll (k8s contract)');
        });
    }
}
