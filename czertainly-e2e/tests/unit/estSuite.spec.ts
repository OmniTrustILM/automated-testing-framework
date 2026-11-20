/**
 * Unit tests for the EST spec lifecycle against a fake request context: what `open` provides,
 * the order `close` cleans up in, and what the client and common-name helpers register.
 */
import { APIRequestContext, expect, test } from '@playwright/test';
import { EstSuite } from '../../utils/estSuite';
import { clearCleanupFailures, readCleanupFailures } from '../../utils/cleanupLedger';
import { FAKE_EST_ENV, fakeApi, fakePlatform } from './estFakeApi';

function suiteWithFake() {
    const { api, calls } = fakeApi(fakePlatform);
    let disposed = 0;
    const context = Object.assign(api, { dispose: async () => void disposed++ }) as APIRequestContext;
    const suite = new EstSuite(async () => context);
    return { suite, calls, context, disposed: () => disposed };
}

test.beforeEach(() => clearCleanupFailures());
test.afterEach(() => clearCleanupFailures());

test('open loads the environment and the admin context', async () => {
    const { suite, context } = suiteWithFake();
    const { env, api } = await suite.open(FAKE_EST_ENV);
    expect(env.baseUrl).toBe('https://ilm.example.com:8443');
    expect(api).toBe(context);
});

test('close runs the cleanup steps newest first, then disposes the context', async () => {
    const { suite, disposed } = suiteWithFake();
    await suite.open(FAKE_EST_ENV);
    const order: number[] = [];
    suite.undo.push(async () => order.push(1), async () => order.push(2));
    await suite.close();
    expect(order).toEqual([2, 1]);
    expect(disposed()).toBe(1);
});

test('close does nothing when the suite never opened', async () => {
    const { suite, disposed } = suiteWithFake();
    await suite.close();
    expect(disposed()).toBe(0);
});

test('the helpers need an open suite', () => {
    const { suite } = suiteWithFake();
    expect(() => suite.uniqueCommonName('x')).toThrow('EstSuite is not open');
});

test('uniqueCommonName is unique and removes its certificates at close', async () => {
    const { suite, calls } = suiteWithFake();
    await suite.open(FAKE_EST_ENV);
    const cn = suite.uniqueCommonName('unit');
    expect(cn).toMatch(/^est-e2e-unit-[0-9a-f]{8}$/);
    expect(suite.uniqueCommonName('unit')).not.toBe(cn);
    await suite.close();
    const searched = calls.filter((c) => c.url === '/api/v1/certificates').map((c) => (c.data as { filters: Array<{ value: string }> }).filters[0].value);
    expect(searched).toContain(cn);
    expect(readCleanupFailures()).toEqual([]);
});

test('raBasicClient creates a raBasic profile on the given RA Profile and registers its cleanup', async () => {
    const { suite, calls } = suiteWithFake();
    await suite.open(FAKE_EST_ENV);
    const client = await suite.raBasicClient('unit', 'ra-pending');
    expect(client.policy).toBe('raBasic');
    const profile = calls.find((c) => c.method === 'POST' && c.url === '/api/v1/estProfiles');
    expect(profile?.data).toMatchObject({ authenticationPolicy: 'raBasic', raProfileUuid: 'ra-pending' });
    expect(suite.undo.length).toBeGreaterThan(0);
});

test('raBasicClient passes profile options on to the EST Profile', async () => {
    const { suite, calls } = suiteWithFake();
    await suite.open(FAKE_EST_ENV);
    await suite.raBasicClient('unit', 'ra-approval', { issueWaitTimeout: 10, retryAfter: 30, renewalThreshold: 5 });
    const profile = calls.find((c) => c.method === 'POST' && c.url === '/api/v1/estProfiles');
    expect(profile?.data).toMatchObject({ raProfileUuid: 'ra-approval', retryAfter: 30, renewalThreshold: 5 });
});
