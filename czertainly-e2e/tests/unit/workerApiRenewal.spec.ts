/**
 * workerApiRenewal — the worker-scoped admin context renews its token, and a block's worker guard needs a proven local stack.
 *
 * Checks `renewingContext` sends to the current context while its token has more than the margin left, opens one new context
 * for any number of waiting requests when it has less, retries after a failed grant and disposes every context it opened;
 * `withWorkerApi(..., { localStack: true })` refuses off a proven local stack before any request; every ledger type the key
 * onboarding block records is a registry type with a live ownership read. Uses stub contexts and an injected clock.
 */
import { expect, test } from '@playwright/test';
import type { APIRequestContext } from '@playwright/test';
import { withWorkerApi } from '../../fixtures/regressionFixtures';
import { renewingContext, type OpenedContext } from '../../utils/auth/renewingContext';
import type { TestEnv } from '../../utils/env';
import { RESOURCE_REGISTRY } from '../../utils/regression/resourceTypes';

function stubContext(label: string, log: string[]): APIRequestContext {
    return {
        get: async (url: string) => { log.push(`${label} get ${url}`); return label; },
        dispose: async () => { log.push(`${label} dispose`); },
    } as unknown as APIRequestContext;
}

test('the context keeps its token while it is fresh and renews it once when it runs low', async () => {
    const log: string[] = [];
    let clock = 0;
    let opened = 0;
    const open = async (): Promise<OpenedContext> => {
        opened += 1;
        return { context: stubContext(`c${opened}`, log), expiresAt: clock + 300_000 };
    };
    const api = renewingContext(open, { marginMs: 60_000, now: () => clock });
    expect(await api.get('/a')).toBe('c1');
    clock = 200_000;
    expect(await api.get('/b'), 'still 100 s left: the same context').toBe('c1');
    clock = 250_000;
    const answers = await Promise.all([api.get('/c'), api.get('/d'), api.get('/e')]);
    expect(answers, 'three waiting requests share one renewal').toEqual(['c2', 'c2', 'c2']);
    expect(opened).toBe(2);
    clock = 400_000;
    expect(await api.get('/f'), 'the renewed token is used until it runs low in turn').toBe('c2');
    await api.dispose();
    expect(log.filter((l) => l.endsWith('dispose')).sort(), 'every context it opened is disposed').toEqual(['c1 dispose', 'c2 dispose']);
    await expect(api.get('/g')).rejects.toThrow(/disposed/);
});

test('a failed grant fails that request and the next request tries again', async () => {
    let attempts = 0;
    const open = async (): Promise<OpenedContext> => {
        attempts += 1;
        if (attempts === 1) throw new Error('grant failed');
        return { context: stubContext('ok', []), expiresAt: Number.POSITIVE_INFINITY };
    };
    const api = renewingContext(open);
    await expect(api.get('/a')).rejects.toThrow('grant failed');
    expect(await api.get('/a')).toBe('ok');
    expect(attempts).toBe(2);
});

test('a context without a token (header mode) is never renewed', async () => {
    let opened = 0;
    const api = renewingContext(async () => ({ context: stubContext(`c${++opened}`, []), expiresAt: Number.POSITIVE_INFINITY }), { now: () => 9e15 });
    await api.get('/a');
    await api.get('/b');
    expect(opened).toBe(1);
});

test('the worker guard with the local-stack option is refused off a proven local stack, before any request', async () => {
    const saved = process.env.TIER_KIND;
    try {
        process.env.TIER_KIND = 'shared';
        let used = false;
        const grant = stubContext('grant', []);
        await expect(withWorkerApi(grant, { baseUrl: 'http://127.0.0.1:1' } as TestEnv, async () => { used = true; }, { localStack: true }))
            .rejects.toThrow(/^workerApi: only a local stack/);
        process.env.TIER_KIND = 'local';
        await expect(withWorkerApi(grant, { baseUrl: 'http://127.0.0.1:1' } as TestEnv, async () => { used = true; }, { localStack: true }))
            .rejects.toThrow(/^workerApi: this run holds no authenticated local-backend proof/);
        expect(used).toBe(false);
    } finally {
        if (saved === undefined) delete process.env.TIER_KIND; else process.env.TIER_KIND = saved;
    }
});

test('every ledger type the key onboarding block records is a registry type with a live ownership read', () => {
    for (const type of ['vaultInstances', 'vaultProfiles', 'secrets', 'tokens', 'tokenProfiles', 'keys', 'customAttributes']) {
        const entry = RESOURCE_REGISTRY.find((e) => e.type === type);
        expect(entry, type).toBeDefined();
        expect(entry!.ownership, `${type} has a live ownership read`).toBeDefined();
        expect(entry!.ownership.kind, type).not.toBe('id-named');
    }
});
