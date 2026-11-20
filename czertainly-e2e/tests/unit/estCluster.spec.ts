/**
 * Unit tests for the cluster helpers against a stand-in pod API: reading logs per pod, and a pod
 * restart that waits for the successors to be ready and the old pods to be gone.
 */
import { test, expect } from '@playwright/test';
import type { V1Pod } from '@kubernetes/client-node';
import { CORE_PODS, EST_LOG_SOURCES, PodApi, readLogs, restartPods } from '../../utils/estCluster';

function pod(name: string, ready = true, deleting = false): V1Pod {
    return {
        metadata: { name, deletionTimestamp: deleting ? new Date() : undefined },
        status: { conditions: [{ type: 'Ready', status: ready ? 'True' : 'False' }] },
    };
}

/** Answers each listNamespacedPod with the next snapshot (the last one repeats) and records calls. */
function fakePods(snapshots: V1Pod[][], logs: Record<string, string> = {}) {
    const calls: Array<[string, unknown]> = [];
    let next = 0;
    const api = {
        listNamespacedPod: async (param: unknown) => {
            calls.push(['list', param]);
            const items = snapshots[Math.min(next, snapshots.length - 1)];
            next += 1;
            return { items };
        },
        readNamespacedPodLog: async (param: { name: string }) => {
            calls.push(['log', param]);
            return logs[param.name] ?? '';
        },
        deleteNamespacedPod: async (param: unknown) => {
            calls.push(['delete', param]);
            return {};
        },
    } as unknown as PodApi;
    return { api, calls };
}

test('readLogs keys each pod log by source and pod, with the window and container', async () => {
    const { api, calls } = fakePods([[pod('core-1')]], { 'core-1': 'line' });
    const logs = await readLogs(api, [EST_LOG_SOURCES[0]], 120);
    expect(logs).toEqual({ 'core/core-1': 'line' });
    expect(calls[1]).toEqual(['log', { name: 'core-1', namespace: 'ilm', container: 'core', sinceSeconds: 120 }]);
});

test('readLogs fails when a source has no pods', async () => {
    const { api } = fakePods([[]]);
    await expect(readLogs(api, EST_LOG_SOURCES, 60)).rejects.toThrow('No pods for log source core');
});

test('restartPods deletes the pods and returns once the successors are ready and the old ones gone', async () => {
    const { api, calls } = fakePods([
        [pod('core-old')],
        [pod('core-old', true, true), pod('core-new', false)],
        [pod('core-new', false)],
        [pod('core-new')],
    ]);
    const ready = await restartPods(api, CORE_PODS, { pollIntervalMs: 1 });
    expect(ready).toEqual(['core-new']);
    expect(calls.filter(([kind]) => kind === 'delete')).toEqual([['delete', { name: 'core-old', namespace: 'ilm' }]]);
    expect(calls.filter(([kind]) => kind === 'list')).toHaveLength(4);
});

test('restartPods fails when there is nothing to restart', async () => {
    const { api } = fakePods([[]]);
    await expect(restartPods(api, CORE_PODS)).rejects.toThrow('No pods to restart');
});

test('restartPods fails when the successors are not ready in time', async () => {
    const { api } = fakePods([[pod('core-old')], [pod('core-new', false)]]);
    await expect(restartPods(api, CORE_PODS, { timeoutMs: 5, pollIntervalMs: 2 })).rejects.toThrow(
        'not ready in time: 0 ready, 0 old left',
    );
});
