/**
 * connector-outage — the example of a developers' e2e test on the throw-away ILM (ATF#165).
 *
 * WHAT: when a connector goes away, ILM's health check of it is no longer `ok`; once it is back, it is `ok` again.
 *
 * WHY: a connector restarts or is scaled down in every real deployment; ILM must notice it and recover without help.
 *
 * HOW: `env/connector.yaml` deploys the folder's own Network Discovery connector. The test registers it in ILM, scales
 * the `Connector` resource to 0 and back to 1 through the Kubernetes API (KUBECONFIG_PATH), and reads
 * GET /v1/connectors/{uuid}/health after each change. It deletes the registration at the end.
 */
import { APIRequestContext, expect, test } from '@playwright/test';
import { loadEnv } from '../../../utils/env';
import { getAuthenticatedApiContext } from '../../../utils/auth/apiContext';
import { getCoreApi, getCustomObjectsApi } from '../../../utils/k8sClient';

const NAMESPACE = 'ilm';
const NAME = 'example-network-discovery';
const URL = `http://${NAME}.${NAMESPACE}.svc.cluster.local:8080`;

async function scaleConnector(replicas: number): Promise<void> {
    await getCustomObjectsApi().patchNamespacedCustomObject({
        group: 'otilm.com', version: 'v1alpha1', namespace: NAMESPACE, plural: 'connectors', name: NAME,
        body: [{ op: 'add', path: '/spec/replicas', value: replicas }],
    });
}

async function readyPods(): Promise<number> {
    const pods = await getCoreApi().listNamespacedPod({ namespace: NAMESPACE, labelSelector: `app.kubernetes.io/name=${NAME}` });
    return pods.items.filter((p) => p.status?.conditions?.some((c) => c.type === 'Ready' && c.status === 'True')).length;
}

/** ILM's view of the connector: `ok`, `nok`, `unknown`, or the HTTP status when the health call itself fails. */
async function health(api: APIRequestContext, uuid: string): Promise<string> {
    const response = await api.get(`/api/v1/connectors/${uuid}/health`);
    return response.ok() ? (await response.json()).status : `HTTP ${response.status()}`;
}

test('a connector that goes away is unhealthy in ILM, and healthy again when it is back @ephemeral', async ({ request }) => {
    const api = await getAuthenticatedApiContext(request, loadEnv());
    let uuid: string | undefined;
    try {
        await test.step('register the folder\'s connector', async () => {
            const created = await api.post('/api/v2/connectors', { data: { name: NAME, url: URL, authType: 'none', customAttributes: [], version: 'v1' } });
            expect(created.ok(), await created.text()).toBe(true);
            const all = await (await api.get('/api/v1/connectors')).json();
            uuid = all.find((c: { name: string }) => c.name === NAME)?.uuid;
            expect(uuid, 'the registered connector is listed').toBeTruthy();
            await expect.poll(() => health(api, uuid!), { timeout: 60_000 }).toBe('ok');
        });
        await test.step('switch it off: ILM sees it unhealthy', async () => {
            await scaleConnector(0);
            await expect.poll(readyPods, { timeout: 120_000 }).toBe(0);
            await expect.poll(() => health(api, uuid!), { timeout: 60_000 }).not.toBe('ok');
        });
        await test.step('switch it on: ILM sees it healthy again', async () => {
            await scaleConnector(1);
            await expect.poll(readyPods, { timeout: 300_000, intervals: [5_000] }).toBe(1);
            await expect.poll(() => health(api, uuid!), { timeout: 60_000 }).toBe('ok');
        });
    } finally {
        await scaleConnector(1).catch(() => undefined);
        if (uuid) await api.delete(`/api/v1/connectors/${uuid}`);
    }
});
