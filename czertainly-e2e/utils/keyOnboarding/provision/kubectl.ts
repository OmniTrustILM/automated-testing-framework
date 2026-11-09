/**
 * kubectl — the kubectl calls of the key onboarding block on a shared tier, pinned to one cluster (never an ambient context).
 * Token scripts run by `sh -s` in the SoftHSM sidecar with script and values on stdin: no value, the PIN least of all, on a command line.
 */
import { spawn } from 'child_process';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { settings } from '../../regression/run/settings';
import { TierError } from '../../devBlocks/provision/transport';
import type { KubeTarget } from '../config';

export interface KubectlResult {
    code: number;
    stdout: string;
    stderr: string;
    notStarted?: boolean;
}

export interface KubectlOptions {
    stdin?: string;
    env?: Record<string, string>;
    timeoutMs?: number;
    requestTimeoutMs?: number;
}

export type KubectlRunner = (args: string[], opts?: KubectlOptions) => Promise<KubectlResult>;

export const KILLED_EXIT = 124;

export function defaultKubectlRunner(processEnv: NodeJS.ProcessEnv = process.env): KubectlRunner {
    return (args, opts = {}) => {
        const s = settings(processEnv);
        if (s.unitNoDocker) return Promise.resolve({ code: 127, stdout: '', stderr: 'the real kubectl is disabled under the unit tests (inject the seam)', notStarted: true });
        return spawnTool(s.toolBin('kubectl'), args, opts, processEnv);
    };
}

export function spawnTool(bin: string, args: string[], opts: KubectlOptions, processEnv: NodeJS.ProcessEnv): Promise<KubectlResult> {
    return new Promise((resolve) => {
        let stdout = '';
        let stderr = '';
        let killed = false;
        let started = false;
        const child = spawn(bin, args, { env: { ...processEnv, ...opts.env }, stdio: ['pipe', 'pipe', 'pipe'] });
        child.on('spawn', () => { started = true; });
        const timer = opts.timeoutMs ? setTimeout(() => { killed = true; child.kill('SIGKILL'); }, opts.timeoutMs) : undefined;
        child.stdout.on('data', (chunk: Buffer) => { stdout += chunk.toString('utf8'); });
        child.stderr.on('data', (chunk: Buffer) => { stderr += chunk.toString('utf8'); });
        child.on('error', (e) => {
            if (timer) clearTimeout(timer);
            resolve({ code: 127, stdout, stderr: `${stderr}${String(e)}`, ...(started ? {} : { notStarted: true }) });
        });
        child.on('close', (code) => {
            if (timer) clearTimeout(timer);
            resolve(killed ? { code: KILLED_EXIT, stdout, stderr: `${stderr}killed after ${opts.timeoutMs} ms` } : { code: code ?? 1, stdout, stderr });
        });
        child.stdin.on('error', () => undefined);
        child.stdin.end(opts.stdin ?? '');
    });
}

export type ClusterPin = { inCluster: true; server: string; caFile: string; tokenFile: string } | { inCluster: false; context: string };

export const SA_DIR = '/var/run/secrets/kubernetes.io/serviceaccount';

export const REQUEST_TIMEOUT_MS = 30_000;
export const EXEC_TIMEOUT_MS = 180_000;

export function clusterPin(env: NodeJS.ProcessEnv, saDir: string = SA_DIR): ClusterPin | { reason: string } {
    const context = (env.KO_KUBE_CONTEXT ?? '').trim();
    if (context) return { inCluster: false, context };
    const host = env.KUBERNETES_SERVICE_HOST;
    const port = env.KUBERNETES_SERVICE_PORT;
    const tokenFile = path.join(saDir, 'token');
    const caFile = path.join(saDir, 'ca.crt');
    if (host && port && fs.existsSync(tokenFile) && fs.existsSync(caFile)) {
        return { inCluster: true, server: `https://${host.includes(':') ? `[${host}]` : host}:${port}`, caFile, tokenFile };
    }
    return { reason: 'no cluster is pinned: the runner is not in a pod with a service account and KO_KUBE_CONTEXT is not set (no ambient kubectl context is used)' };
}

export function inClusterKubeconfig(pin: Extract<ClusterPin, { inCluster: true }>): string {
    return [
        'apiVersion: v1',
        'kind: Config',
        'clusters:',
        `- name: in-cluster`,
        '  cluster:',
        `    server: ${JSON.stringify(pin.server)}`,
        `    certificate-authority: ${JSON.stringify(pin.caFile)}`,
        'users:',
        '- name: service-account',
        '  user:',
        `    tokenFile: ${JSON.stringify(pin.tokenFile)}`,
        'contexts:',
        '- name: in-cluster',
        '  context:',
        '    cluster: in-cluster',
        '    user: service-account',
        'current-context: in-cluster',
        '',
    ].join('\n');
}

const kubeconfigs = new Map<string, string>();

export function removeKubeconfigs(): void {
    for (const file of kubeconfigs.values()) fs.rmSync(path.dirname(file), { recursive: true, force: true });
    kubeconfigs.clear();
}

/** The in-cluster kubeconfig written once per process to a fresh temp directory (mode 0600; it holds paths, not the token). */
function kubeconfigFile(pin: Extract<ClusterPin, { inCluster: true }>): string {
    const text = inClusterKubeconfig(pin);
    let file = kubeconfigs.get(text);
    if (!file) {
        if (!kubeconfigs.size) process.once('exit', removeKubeconfigs);
        file = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'ko-kubeconfig-')), 'config');
        fs.writeFileSync(file, text, { mode: 0o600 });
        kubeconfigs.set(text, file);
    }
    return file;
}

/** Variables that could point kubectl at another cluster than the pin: emptied in the child (KUBECONFIG is set by the pin). */
const REDIRECTING = ['KUBERNETES_MASTER'];

export function pinnedKubectl(runner: KubectlRunner, pin: ClusterPin, env: NodeJS.ProcessEnv = process.env): KubectlRunner {
    const execTimeout = Number(env.KO_KUBE_EXEC_TIMEOUT_MS) > 0 ? Number(env.KO_KUBE_EXEC_TIMEOUT_MS) : EXEC_TIMEOUT_MS;
    return (args, opts = {}) => {
        const exec = args[0] === 'exec';
        const requestSeconds = Math.max(1, Math.ceil(Math.min(REQUEST_TIMEOUT_MS, opts.requestTimeoutMs ?? REQUEST_TIMEOUT_MS) / 1000));
        const flags = [...(pin.inCluster ? [] : ['--context', pin.context]), ...(exec ? [] : [`--request-timeout=${requestSeconds}s`])];
        const cleared = Object.fromEntries(REDIRECTING.map((k) => [k, '']));
        const { requestTimeoutMs: _requestTimeout, ...rest } = opts;
        return runner([...flags, ...args], {
            ...rest,
            env: { ...opts.env, ...cleared, ...(pin.inCluster ? { KUBECONFIG: kubeconfigFile(pin) } : {}) },
            ...(exec ? { timeoutMs: opts.timeoutMs ?? execTimeout } : {}),
        });
    };
}

export function clusterKubectl(runner: KubectlRunner | undefined, env: NodeJS.ProcessEnv): KubectlRunner | { reason: string } {
    const pin = clusterPin(env);
    if ('reason' in pin) return pin;
    return pinnedKubectl(runner ?? defaultKubectlRunner(env), pin, env);
}

export async function kubectlAvailable(kubectl: KubectlRunner): Promise<boolean> {
    return (await kubectl(['version', '--client'])).code === 0;
}

export async function canIAnswer(kubectl: KubectlRunner, verb: string, resource: string, namespace: string): Promise<'yes' | 'no' | 'unknown'> {
    const r = await kubectl(['auth', 'can-i', verb, resource, '-n', namespace]);
    const answer = r.stdout.trim();
    if (r.code === 0 && answer === 'yes') return 'yes';
    if (r.code === 1 && answer === 'no') return 'no';
    return 'unknown';
}

export async function canI(kubectl: KubectlRunner, verb: string, resource: string, namespace: string): Promise<boolean> {
    return (await canIAnswer(kubectl, verb, resource, namespace)) === 'yes';
}

export function connectorTargetProblem(connectorUrl: string, target: KubeTarget): string | undefined {
    let host: string;
    try {
        host = new URL(connectorUrl).hostname;
    } catch {
        return 'KO_PKCS11_CONNECTOR_URL is no URL';
    }
    const labels = host.split('.');
    const suffix = labels.slice(2).join('.');
    if (labels.length < 2 || labels[0] !== target.deployment || labels[1] !== target.namespace || !['', 'svc', 'svc.cluster.local'].includes(suffix)) {
        return 'the connector KO_PKCS11_CONNECTOR_URL names is not the Service of the Deployment KO_KUBE_DEPLOYMENT names in KO_KUBE_NAMESPACE (<deployment>.<namespace>.svc…): the planted keys would be on another token than the one core lists';
    }
    return undefined;
}

type Json = Record<string, any>;

const running = (statuses: unknown, container: string): boolean =>
    ((statuses ?? []) as Json[]).some((c) => c.name === container && c.ready === true && !!c.state?.running);

export function sidecarPods(podList: unknown, target: KubeTarget): string[] {
    const items = ((podList as Json)?.items ?? []) as Json[];
    const escaped = target.deployment.replace(/[.*+?^$()|[\]\\{}]/g, '\\$&');
    const replicaSet = new RegExp(`^${escaped}-[a-z0-9]+$`);
    return items
        .filter((p) => !p.metadata?.deletionTimestamp && p.status?.phase === 'Running')
        .filter((p) => ((p.metadata?.ownerReferences ?? []) as Json[]).some((o) => o.kind === 'ReplicaSet' && replicaSet.test(String(o.name ?? ''))))
        .filter((p) => running(p.status?.containerStatuses, target.container) || running(p.status?.initContainerStatuses, target.container))
        .map((p) => String(p.metadata.name));
}

export async function sidecarPod(kubectl: KubectlRunner, target: KubeTarget): Promise<{ pod: string } | { reason: string }> {
    const r = await kubectl(['get', 'pods', '-n', target.namespace, '-o', 'json']);
    if (r.code !== 0) return { reason: `kubectl get pods in the namespace KO_KUBE_NAMESPACE names answered exit ${r.code}` };
    let list: unknown;
    try {
        list = JSON.parse(r.stdout);
    } catch {
        return { reason: 'kubectl get pods printed no pod list' };
    }
    const pods = sidecarPods(list, target);
    if (pods.length === 1) return { pod: pods[0] };
    if (!pods.length) return { reason: 'no running pod of the Deployment KO_KUBE_DEPLOYMENT names has a ready KO_KUBE_CONTAINER sidecar' };
    return { reason: `${pods.length} running pods of the Deployment KO_KUBE_DEPLOYMENT names: the SoftHSM token is per pod, so the planted keys could be on another pod than the one core lists` };
}

export function shellQuote(value: string): string {
    return `'${value.replace(/'/g, `'\\''`)}'`;
}

export function scriptStdin(script: string, environment: Record<string, string>): string {
    for (const name of Object.keys(environment)) {
        if (!/^[A-Z_][A-Z0-9_]*$/.test(name)) throw new Error(`execScript: ${name} is no shell variable name`);
    }
    const exports = Object.entries(environment).map(([k, v]) => `export ${k}=${shellQuote(v)}`).join('\n');
    return `${exports}\n${script}`;
}

export function execArgs(target: KubeTarget, pod: string): string[] {
    return ['exec', '-i', '-n', target.namespace, pod, '-c', target.container, '--', 'sh', '-s'];
}

export async function theSidecarPod(kubectl: KubectlRunner, target: KubeTarget): Promise<string> {
    const found = await sidecarPod(kubectl, target);
    if ('reason' in found) throw new TierError(found.reason);
    return found.pod;
}

export function execScriptIn(kubectl: KubectlRunner, target: KubeTarget, pod: string, script: string, environment: Record<string, string>, timeoutMs?: number): Promise<KubectlResult> {
    return kubectl(execArgs(target, pod), { stdin: scriptStdin(script, environment), ...(timeoutMs !== undefined ? { timeoutMs } : {}) });
}

export async function execScript(kubectl: KubectlRunner, target: KubeTarget, script: string, environment: Record<string, string>): Promise<KubectlResult> {
    return execScriptIn(kubectl, target, await theSidecarPod(kubectl, target), script, environment);
}

export function execLineResolvingPod(target: KubeTarget, contextFlag: string): string {
    const ns = shellQuote(target.namespace);
    return `POD=$(kubectl ${contextFlag}get pods -n ${ns} --field-selector=status.phase=Running ` +
        `-o custom-columns=NAME:.metadata.name,DELETING:.metadata.deletionTimestamp --no-headers | awk '$2 == "<none>" { print $1 }' | ` +
        `grep -E ${shellQuote(`^${target.deployment}-[a-z0-9]+-[a-z0-9]+$`)}) && [ "$(printf '%s\\n' "$POD" | grep -c .)" -eq 1 ] && ` +
        `kubectl ${contextFlag}exec -i -n ${ns} "$POD" -c ${shellQuote(target.container)} -- sh -s`;
}
