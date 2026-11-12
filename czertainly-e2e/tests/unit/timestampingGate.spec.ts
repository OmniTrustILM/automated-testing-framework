/**
 * timestampingGate — how the timestamping block is selected on a shared tier (tests/timestamping/SHARED-TIER.md): the tags of a row, the
 * projects' tier filters, and the `timestamping` need that skips a row with a named reason when the tier lacks the components.
 *
 * WHAT: a shared-tier row carries `@needs:timestamping` and no `@local`; a docker-bound or disruptive row carries `@local`; the block's
 * four projects select the first on every tier and the second on a local one only; the need answers `undefined` for a tier with the connected
 * connectors, the authority and the vault instance, and a `deploy gate` reason for every missing piece, after reads only; the `needs` fixture
 * turns that reason into a skip, and a met need into no skip at all.
 * WHY: replaces the blanket `@local` that kept the block off every shared tier; a tier DevOps equipped should run it, one without should
 * say what is missing, and neither may be written to before the need is met.
 * HOW: the real guard (`guardApiWithSeams`) over a fake request context that answers the four reads the need makes and records every request;
 * the tool probe and the environment are seams.
 */
import { APIRequestContext, expect, test } from '@playwright/test';
import * as fs from 'fs';
import { needsApi } from '../../fixtures/regressionFixtures';
import type { TestEnv } from '../../utils/env';
import { devBlockProjects } from '../../utils/devBlocks/registry';
import { guardApiWithSeams } from '../../utils/regression/guard/createGuard';
import type { GuardedApi } from '../../utils/regression/guard/types';
import { declaredNeedsOf, resolveNeeds } from '../../utils/regression/needs';
import { resolveProjectFilters, selectsTest } from '../../utils/regression/projectFilters';
import { runId } from '../../utils/regression/ledger/runState';
import { NEEDS } from '../../utils/regression/tags';
import { timestampingConfig } from '../../utils/timestamping/config';
import { resetTimestampingNeedForTests, timestampingNeedProblem } from '../../utils/timestamping/need';
import { SetupError } from '../../utils/timestamping/provision/transport';
import { devTests } from '../../utils/timestamping/tags';
import { withProcessEnv } from './helpers/guardRig';

type Json = Record<string, any>;
const U = (n: number) => `00000000-0000-4000-8000-${String(n).padStart(12, '0')}`;
const C = { cred: U(1), ejbca: U(2), crypto: U(3), tfc: U(4), vault: U(5) };
const AUTHORITY_NAME = 'ejbca.3key.company';

const v1 = (): Json[] => [
    { uuid: C.cred, name: 'cred', status: 'connected', functionGroups: [{ functionGroupCode: 'credentialProvider', kinds: ['SoftKeyStore'] }] },
    { uuid: C.ejbca, name: 'ejbca', status: 'connected', functionGroups: [{ functionGroupCode: 'authorityProvider', kinds: ['EJBCA'] }] },
];
const v2 = (): Json[] => [
    { uuid: C.crypto, name: 'crypto-v2', version: 'v2', status: 'connected', interfaces: [{ code: 'cryptography' }] },
    { uuid: C.tfc, name: 'formatter', version: 'v2', status: 'connected', interfaces: [{ code: 'signatureFormatting', features: ['timestamping'] }] },
    { uuid: C.vault, name: 'vault-v2', version: 'v2', status: 'connected', interfaces: [{ code: 'secret' }] },
];

interface Tier {
    v1?: Json[];
    v2?: Json[];
    authorities?: Json[];
    vaults?: Json[];
    /** `METHOD /path` → a status answered instead. */
    status?: Record<string, number>;
}

/** A guarded context over a fake core that serves the reads of the need and records every request. */
function guarded(tier: Tier = {}): { api: GuardedApi; sent: string[] } {
    const sent: string[] = [];
    const answer = (method: string, url: string) => {
        const path = url.replace(/^\/api/, '').split('?')[0];
        sent.push(`${method} ${path}`);
        const forced = tier.status?.[`${method} ${path}`];
        const routes: Record<string, unknown> = {
            'GET /v1/connectors': tier.v1 ?? v1(),
            'POST /v2/connectors/list': { items: tier.v2 ?? v2() },
            'GET /v1/authorities': tier.authorities ?? [{ uuid: U(10), name: AUTHORITY_NAME, attributes: [{ name: 'credential', content: [{ data: { uuid: U(12), name: 'c' } }] }] }],
            'POST /v1/vaults/list': { items: tier.vaults ?? [{ uuid: U(11), name: 'vault', connector: { uuid: C.vault } }] },
        };
        const status = forced ?? (`${method} ${path}` in routes ? 200 : 404);
        const body = forced ? { message: 'x' } : routes[`${method} ${path}`] ?? {};
        return { status: () => status, ok: () => status < 300, text: async () => JSON.stringify(body), json: async () => body, headers: () => ({}) };
    };
    const raw = {
        get: async (url: string) => answer('GET', url),
        head: async () => answer('HEAD', '/'),
        fetch: async (url: string, o: { method?: string } = {}) => answer((o.method ?? 'GET').toUpperCase(), url),
        dispose: async () => undefined,
        storageState: async () => ({ cookies: [], origins: [] }),
    } as unknown as APIRequestContext;
    return { api: guardApiWithSeams(raw, { env: { BASE_URL: 'https://tier.example/' }, lines: [], runId: runId(), tier: null }), sent };
}

const env = (extra: NodeJS.ProcessEnv = {}): NodeJS.ProcessEnv => ({ BASE_URL: 'https://tier.example/', TSA_AUTHORITY_NAME: AUTHORITY_NAME, ...extra });
const cfg = (e: NodeJS.ProcessEnv = env()) => timestampingConfig(e);
const withOpenssl = { requireTool: () => undefined };
const withoutOpenssl = { requireTool: () => 'OpenSSL 3.x required, found "LibreSSL 3.3.6" (LibreSSL has no cmp)' };

test.beforeEach(() => resetTimestampingNeedForTests());

// ------------------------------------------------------------------ the tags

test('a shared-tier row carries the need and no @local; a docker-bound or disruptive one is @local; the setup and teardown carry neither', () => {
    const base = ['@dev-tests', '@timestamping', '@issue:automated-testing-framework#41'];
    expect(devTests().tag).toEqual([...base, '@needs:timestamping']);
    expect(devTests({ local: true }).tag).toEqual([...base, '@needs:timestamping', '@local']);
    expect(devTests({ slow: true, disruptive: true }).tag, 'a disruptive row is local whatever else it says').toEqual([...base, '@needs:timestamping', '@local', '@slow', '@disruptive']);
    expect(devTests({ infrastructure: true }).tag).toEqual(base);
    expect(NEEDS).toContain('timestamping');
    expect(declaredNeedsOf(devTests().tag)).toEqual(['timestamping']);
    expect(declaredNeedsOf(devTests({ infrastructure: true }).tag)).toEqual([]);
});

test('the block\'s projects select a shared-tier row on every tier and a local row on a local stack only', () => {
    const row = `a row ${devTests().tag.join(' ')}`;
    const local = `a local row ${devTests({ local: true }).tag.join(' ')}`;
    const setup = `the setup ${devTests({ infrastructure: true }).tag.join(' ')}`;
    for (const [name, tierEnv, wantRow, wantLocal] of [['shared', {}, true, false], ['local', { TIER_KIND: 'local' }, true, true]] as const) {
        const filters = resolveProjectFilters({ projects: devBlockProjects('timestamping', tierEnv) });
        expect(filters.map((f) => selectsTest(f, row)), `${name}: a shared-tier row`).toEqual([wantRow, wantRow, wantRow, wantRow]);
        expect(filters.map((f) => selectsTest(f, local)), `${name}: a local row`).toEqual([wantLocal, wantLocal, wantLocal, wantLocal]);
        expect(filters.map((f) => selectsTest(f, setup)), `${name}: setup and teardown`).toEqual([true, true, true, true]);
    }
});

// ------------------------------------------------------------------ the need: a tier without the components skips with a reason

test('a tier with every component meets the need after reads only; the second ask reads nothing', async () => {
    const { api, sent } = guarded();
    expect(await timestampingNeedProblem(api, env(), cfg(), withOpenssl)).toBeUndefined();
    expect(sent).toEqual(['GET /v1/connectors', 'POST /v2/connectors/list', 'GET /v1/authorities', 'POST /v1/vaults/list']);
    expect(await timestampingNeedProblem(api, env(), cfg(), withOpenssl)).toBeUndefined();
    expect(sent, 'remembered per tier').toHaveLength(4);
});

test('every missing component is a named deploy-gate reason, found by reads only', async () => {
    const reason = async (tier: Tier, e = env()) => {
        resetTimestampingNeedForTests();
        const { api, sent } = guarded(tier);
        const r = await timestampingNeedProblem(api, e, cfg(e), withOpenssl);
        expect(sent.every((s) => s.startsWith('GET ') || /\/list$/.test(s)), `reads only: ${sent.join(', ')}`).toBe(true);
        return r;
    };
    const without = (uuid: string, list: Json[]) => list.filter((c) => c.uuid !== uuid);
    expect(await reason({ v2: without(C.tfc, v2()) })).toBe('deploy gate: no timestamp-formatting (signatureFormatting / timestamping) connector is registered (@needs:timestamping)');
    expect(await reason({ v2: without(C.crypto, v2()) })).toBe('deploy gate: no cryptography-provider v2 (software) connector is registered (@needs:timestamping)');
    expect(await reason({ v1: without(C.ejbca, v1()) })).toBe('deploy gate: no authority-provider (EJBCA) connector is registered (@needs:timestamping)');
    expect(await reason({ v1: without(C.cred, v1()) })).toBe('deploy gate: no credential-provider (SoftKeyStore) connector is registered (@needs:timestamping)');
    expect(await reason({ v2: v2().map((c) => (c.uuid === C.vault ? { ...c, interfaces: [] } : c)) })).toMatch(/^deploy gate: no vault \(credential-provider v2, secret interface.*\) connector is registered \(@needs:timestamping\)$/);
    expect(await reason({ v2: v2().map((c) => (c.uuid === C.tfc ? { ...c, status: 'waitingForApproval' } : c)) })).toMatch(/^deploy gate: the timestamp-formatting .* connector is waiting for approval .* \(@needs:timestamping\)$/);
    expect(await reason({ v2: v2().map((c) => (c.uuid === C.crypto ? { ...c, status: 'offline' } : c)) })).toMatch(/^deploy gate: the cryptography-provider v2 \(software\) connector is offline, not connected \(@needs:timestamping\)$/);
    expect(await reason({ authorities: [] })).toBe('deploy gate: no authority instance has the name TSA_AUTHORITY_NAME gives; the setup never creates one (@needs:timestamping)');
    expect(await reason({ vaults: [] })).toBe('deploy gate: no vault instance has the name TSA_VAULT_INSTANCE_NAME gives; the setup never creates one (@needs:timestamping)');
    // A reason names the variable, never the configured value.
    expect(await reason({ authorities: [] })).not.toContain(AUTHORITY_NAME);
    // The tier answering a read with an error is the tier's "no" (a named reason); a refused identity is the run's failure.
    expect(await reason({ status: { 'GET /v1/connectors': 503 } })).toMatch(/^deploy gate: the tier did not answer a read of the timestamping components \(GET \/v1\/connectors answered HTTP 503\) \(@needs:timestamping\)$/);
    resetTimestampingNeedForTests();
    await expect(timestampingNeedProblem(guarded({ status: { 'GET /v1/connectors': 401 } }).api, env(), cfg(), withOpenssl)).rejects.toThrow(SetupError);
});

test('a runner without OpenSSL 3, a software-v1 or pkcs11 provider off a local stack: a reason, no request', async () => {
    const { api, sent } = guarded();
    expect(await timestampingNeedProblem(api, env(), cfg(), withoutOpenssl)).toBe('deploy gate: OpenSSL 3.x required, found "LibreSSL 3.3.6" (LibreSSL has no cmp) (@needs:timestamping)');
    const v1Env = env({ TSA_CRYPTO_PROVIDER: 'software-v1' });
    expect(await timestampingNeedProblem(api, v1Env, cfg(v1Env), withOpenssl)).toMatch(/^deploy gate: TSA_CRYPTO_PROVIDER=software-v1 is provisioned on a proven local stack only/);
    const pkcsEnv = env({ TSA_CRYPTO_PROVIDER: 'pkcs11' });
    expect(await timestampingNeedProblem(api, pkcsEnv, cfg(pkcsEnv), withOpenssl)).toMatch(/^deploy gate: TSA_CRYPTO_PROVIDER=pkcs11 is not provisioned/);
    expect(sent).toEqual([]);
});

// ------------------------------------------------------------------ through the fixture: the row skips with the reason

test('the needs fixture skips a row with the reason when the tier lacks a component, and does not skip when it has them', async ({}, testInfo) => {
    const bin = testInfo.outputPath('openssl');
    fs.writeFileSync(bin, '#!/bin/sh\ncase "$1" in version) echo "OpenSSL 3.5.0 8 Apr 2025";; cmp) echo "Usage: openssl cmp";; esac\n', { mode: 0o755 });
    await withProcessEnv({ REG_OPENSSL_BIN: bin, BASE_URL: 'https://tier.example/', TSA_AUTHORITY_NAME: AUTHORITY_NAME }, async () => {
        const skips: string[] = [];
        const missing = guarded({ v2: v2().filter((c) => c.uuid !== C.tfc) });
        await needsApi(async () => missing.api, {} as TestEnv, (reason) => skips.push(reason)).require('timestamping');
        expect(skips).toEqual(['deploy gate: no timestamp-formatting (signatureFormatting / timestamping) connector is registered (@needs:timestamping)']);
        resetTimestampingNeedForTests();
        const full = guarded();
        const met: string[] = [];
        await needsApi(async () => full.api, {} as TestEnv, (reason) => met.push(reason)).timestamping();
        expect(met, 'a tier with the components runs the row').toEqual([]);
        resetTimestampingNeedForTests();
        expect(await resolveNeeds(['timestamping'], { api: guarded().api, env: {} as TestEnv })).toBeUndefined();
    });
});
