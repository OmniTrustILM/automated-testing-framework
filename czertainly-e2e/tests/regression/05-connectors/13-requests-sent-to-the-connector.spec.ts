/**
 * REG-CONN-13 — a free-form attribute-callback body reaches an own fake v2 connector unchanged (local stack; ilm#436, core#2472).
 */
import { expect, test } from '../../../fixtures/regressionFixtures';
import { describeHealth, healthByVersion } from '../../../utils/regression/platform/connectorApi';
import { CALLBACK_ATTRIBUTE, callbackProbeDocument, StubConnector } from '../../../utils/regression/platform/fakeConnector';
import { testMeta, tags } from '../../../utils/regression/tags';
import { describeLocalOnly } from '../../../utils/regression/tier/localProof';
import { CONNECTOR_WRITE_TEST_MS } from '../../../utils/regression/timeouts';


/** True when `needle` is deep-equal to `haystack` or to any value nested in it. */
function containsDeepEqual(haystack: unknown, needle: unknown): boolean {
    if (JSON.stringify(haystack) === JSON.stringify(needle)) return true;
    if (Array.isArray(haystack)) return haystack.some((v) => containsDeepEqual(v, needle));
    if (haystack && typeof haystack === 'object') return Object.values(haystack as Record<string, unknown>).some((v) => containsDeepEqual(v, needle));
    return false;
}

test.describe('Requests sent to a fake connector (local stack)', { tag: tags.regression }, () => {
    describeLocalOnly(test);

    test('a free-form callback body reaches the connector unchanged',
        testMeta({ id: 'REG-CONN-13', prio: 'P2', issue: 'ilm#436', local: true, phaseB: true, rule: ['NG callback forwarded with the free-form body; admin create ends connected; core#2472 (Jackson 2 wire to connectors pinned); ilm#251 (shared callback-dispatch path must stay unaffected)'] }),
        async ({ api, own }, testInfo) => {
            test.setTimeout(CONNECTOR_WRITE_TEST_MS);
            const stub = new StubConnector('stub13');
            await stub.start();
            try {
                const connector = await test.step('Register the stub (admin create, own connector) and read its live health', async () => {
                    const registered = await stub.register(api, own.spec);
                    const health = await healthByVersion(api, { uuid: registered.uuid, name: registered.name, status: String(registered.detail.status) });
                    expect(health.healthy, describeHealth(health)).toBe(true);
                    return registered;
                });
                const probe = callbackProbeDocument();
                const received = await test.step('POST the probe document through the connector callback', async () => {
                    stub.requests.length = 0;
                    const res = await api.post(`/api/v2/connectors/${connector.uuid}/callback`, {
                        data: { uuid: CALLBACK_ATTRIBUTE.uuid, name: CALLBACK_ATTRIBUTE.name, pathVariables: {}, queryParameters: {}, requestBody: probe },
                    });
                    testInfo.annotations.push({ type: 'core-answer', description: `${res.status()} ${(await res.text()).slice(0, 160)}` });
                    expect(res.status(), 'core forwarded the callback').toBeLessThan(500);
                    const calls = stub.callbacks();
                    expect(calls.length, 'the stub received the callback').toBeGreaterThanOrEqual(1);
                    return calls[calls.length - 1];
                });
                expect(containsDeepEqual(received.json, probe), `the probe document is inside the received body: ${received.body.slice(0, 400)}`).toBe(true);
            } finally {
                await stub.close();
            }
        });
});
