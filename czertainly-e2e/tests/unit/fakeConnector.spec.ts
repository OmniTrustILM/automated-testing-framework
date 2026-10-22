/**
 * fakeConnector — the fake v2 connector on loopback: info, health, metrics and attributes answers, the callback echo
 * and its record, fault injection, and the probe document's round trip through JSON. No core is involved: the tests
 * talk to the fake connector directly.
 */
import { expect, test } from '@playwright/test';
import { CALLBACK_ATTRIBUTE, callbackProbeDocument, StubConnector } from '../../utils/regression/platform/fakeConnector';

test('the stub answers the NG interfaces, echoes and records callbacks, injects faults, and advertises the docker alias', async () => {
    const stub = new StubConnector('stub-unit');
    await stub.start();
    try {
        const info = await (await fetch(`${stub.origin}/v2/info`)).json();
        expect(info.name).toBe(stub.name);
        expect(info.interfaces.map((i: { code: string }) => i.code)).toEqual(['info', 'health', 'metrics', 'attributes', 'discovery']);
        const health = await fetch(`${stub.origin}/v2/health`);
        expect(health.status).toBe(200);
        expect((await health.json()).components.liveness.status).toBe('UP');
        const attrs = await (await fetch(`${stub.origin}/v2/attributes`)).json();
        expect(attrs[0].uuid).toBe(CALLBACK_ATTRIBUTE.uuid);
        const probe = callbackProbeDocument();
        const cb = await fetch(`${stub.origin}/v2/attributes/callback`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ requestBody: probe }) });
        expect(cb.status).toBe(200);
        expect((await cb.json()).received).toEqual({ requestBody: probe });
        expect(stub.callbacks()).toHaveLength(1);
        expect(JSON.parse(stub.callbacks()[0].body).requestBody).toEqual(probe);
        stub.answerWith('/v2/health', { status: 503, body: { status: 'DOWN' } });
        expect((await fetch(`${stub.origin}/v2/health`)).status).toBe(503);
        stub.answerWith('/v2/health');
        expect((await fetch(`${stub.origin}/v2/health`)).status).toBe(200);
        expect((await fetch(`${stub.origin}/nope`)).status).toBe(404);
        expect(stub.advertisedUrl({})).toBe(`http://host.docker.internal:${new URL(stub.origin).port}`);
        expect(stub.advertisedUrl({ REG_STUB_ADVERTISED_HOST: 'gateway.local' })).toMatch(/^http:\/\/gateway\.local:\d+$/);
    } finally {
        await stub.close();
    }
});
