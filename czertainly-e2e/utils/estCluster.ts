/**
 * estCluster — the Kubernetes side of the EST suite: reading component logs and restarting Core.
 *
 * WHAT: reads the logs of the pods behind a label selector since a number of seconds ago, and
 * replaces the pods behind a selector, waiting until their successors are ready.
 * WHY: the log-hygiene check scans what Core and the proxies in front of it logged during the run,
 * and the restart check needs Core to come back from a restart while a request is pending.
 * HOW: through a CoreV1Api (`getCoreApi()` from k8sClient, so KUBECONFIG_PATH or the in-cluster
 * account), passed in so the logic can be tested with a stand-in. A restart deletes the pods and
 * lets their Deployment recreate them, which works whether or not an operator owns the Deployment.
 */

import type { CoreV1Api, V1Pod } from '@kubernetes/client-node';
import { Logger } from './Logger';

const logger = new Logger('EstCluster');

export type PodApi = Pick<CoreV1Api, 'listNamespacedPod' | 'readNamespacedPodLog' | 'deleteNamespacedPod'>;

export interface PodSelector {
  namespace: string;
  labelSelector: string;
}

export interface LogSource extends PodSelector {
  name: string;
  container?: string;
}

/** Core and the two proxies an EST request passes: ingress-nginx, then Kong. */
export const EST_LOG_SOURCES: LogSource[] = [
  { name: 'core', namespace: 'ilm', labelSelector: 'app.kubernetes.io/name=core', container: 'core' },
  { name: 'kong', namespace: 'ilm', labelSelector: 'app.kubernetes.io/name=api-gateway' },
  { name: 'ingress', namespace: 'ingress-nginx', labelSelector: 'app.kubernetes.io/name=ingress-nginx' },
];

export const CORE_PODS: PodSelector = { namespace: 'ilm', labelSelector: 'app.kubernetes.io/name=core' };

async function listPods(api: PodApi, selector: PodSelector): Promise<V1Pod[]> {
  return (await api.listNamespacedPod(selector)).items;
}

/** The text each pod logged in the last `sinceSeconds`, keyed `<source>/<pod>`. */
export async function readLogs(api: PodApi, sources: LogSource[], sinceSeconds: number): Promise<Record<string, string>> {
  const logs: Record<string, string> = {};
  for (const source of sources) {
    const pods = await listPods(api, source);
    if (pods.length === 0) throw new Error(`No pods for log source ${source.name} (${source.labelSelector})`);
    for (const pod of pods) {
      const name = pod.metadata?.name as string;
      logs[`${source.name}/${name}`] = await api.readNamespacedPodLog({
        name,
        namespace: source.namespace,
        container: source.container,
        sinceSeconds,
      });
    }
  }
  return logs;
}

function isReady(pod: V1Pod): boolean {
  return !pod.metadata?.deletionTimestamp && !!pod.status?.conditions?.some((c) => c.type === 'Ready' && c.status === 'True');
}

/** Deletes the selected pods and waits until as many successors are ready and none of the old ones is left. */
export async function restartPods(
  api: PodApi,
  selector: PodSelector,
  opts: { timeoutMs?: number; pollIntervalMs?: number } = {},
): Promise<string[]> {
  const old = (await listPods(api, selector)).map((pod) => pod.metadata?.name as string);
  if (old.length === 0) throw new Error(`No pods to restart for ${selector.labelSelector}`);
  logger.info(`Restarting pods: ${old.join(', ')}`);
  for (const name of old) await api.deleteNamespacedPod({ name, namespace: selector.namespace });

  const deadline = Date.now() + (opts.timeoutMs ?? 300_000);
  for (;;) {
    const pods = await listPods(api, selector);
    const successors = pods.filter((pod) => !old.includes(pod.metadata?.name as string));
    const oldLeft = pods.length - successors.length;
    const ready = successors.filter(isReady).map((pod) => pod.metadata?.name as string);
    if (oldLeft === 0 && ready.length >= old.length) {
      logger.info(`Pods ready: ${ready.join(', ')}`);
      return ready;
    }
    if (Date.now() > deadline) {
      throw new Error(`Pods for ${selector.labelSelector} not ready in time: ${ready.length} ready, ${oldLeft} old left`);
    }
    await new Promise((resolve) => setTimeout(resolve, opts.pollIntervalMs ?? 2000));
  }
}
