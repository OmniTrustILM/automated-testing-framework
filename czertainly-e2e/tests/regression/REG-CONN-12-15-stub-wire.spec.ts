/**
 * REG-CONN-13 — a free-form attribute-callback body reaches the connector intact (ilm#436, T12; #424 §3 Jackson 2 pin,
 * core#2472; ilm#251; platform area). Local stack only (`@local`, `@phaseB`): the in-test stub connector listens on the
 * runner and is registered through the ADMIN create (`POST /v2/connectors`, own object, ends `connected`, A4 r2); core
 * reaches it through the advertised host (`REG_STUB_ADVERTISED_HOST`, the Docker host-gateway alias by default). The
 * callback POST targets the OWN connector, so the guard sends it. Oracle: the document the test sends through
 * `POST /v2/connectors/{uuid}/callback` (nested objects, arrays, null, unicode, large integers, ISO dates) is found
 * deep-equal inside the request the stub received (absolute oracle, no baseline).
 */
import { expect, test } from '../../fixtures/testFixtures';
import { describeHealth, healthByVersion } from '../../utils/regression/connectorApi';
import { CALLBACK_ATTRIBUTE, callbackProbeDocument, StubConnector } from '../../utils/regression/stubConnector';
import { meta, tags } from '../../utils/regression/tags';
import { describeLocal } from '../../utils/regression/tier';

const SPEC = 'REG-CONN-12-15';

/** True when `needle` is deep-equal to `haystack` or to any value nested in it. */
function containsDeepEqual(haystack: unknown, needle: unknown): boolean {
    if (JSON.stringify(haystack) === JSON.stringify(needle)) return true;
    if (Array.isArray(haystack)) return haystack.some((v) => containsDeepEqual(v, needle));
    if (haystack && typeof haystack === 'object') return Object.values(haystack as Record<string, unknown>).some((v) => containsDeepEqual(v, needle));
    return false;
}

test.describe('REG-CONN stub connector wire (local stack)', { tag: tags.regression }, () => {
    describeLocal(test);
    const stub = new StubConnector('stub13');

    test.beforeAll(async () => {
        await stub.start();
    });

    test.afterAll(async () => {
        await stub.close();
    });

    test('REG-CONN-13: the free-form callback body sent through POST /v2/connectors/{own}/callback arrives at the stub deep-equal (objects, arrays, null, unicode, large integers, ISO dates)',
        meta({ id: 'REG-CONN-13', prio: 'P1', issue: 'ilm#436', local: true, phaseB: true, rule: ['platform-keys-connectors A4 r15 (NG callback forwarded with the free-form body), r2 (admin create ends connected); core#2472 (Jackson 2 wire to connectors pinned); ilm#251 (shared callback-dispatch path must stay unaffected)'] }),
        async ({ api }, testInfo) => {
            test.setTimeout(120_000);
            const connector = await test.step('Register the stub (admin create, own connector) and read its live health', async () => {
                const c = await stub.register(api, SPEC);
                const health = await healthByVersion(api, { uuid: c.uuid, name: c.name, status: String(c.detail.status) });
                expect(health.healthy, describeHealth(health)).toBe(true);
                return c;
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
        });
});
