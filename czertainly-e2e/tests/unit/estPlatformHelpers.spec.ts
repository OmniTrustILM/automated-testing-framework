/**
 * Unit tests for the helpers that talk to the platform (admin API, EST Profiles, fixtures),
 * against a fake request context: what matters is which requests they make, in what order, and
 * how they treat failures.
 */
import { test, expect } from '@playwright/test';
import * as fs from 'fs';
import { ensureOk, getRaProfileCaFingerprints, getRaProfileName, newEstAdminContext } from '../../utils/estAdminApi';
import { EstEnv, loadEstEnv } from '../../utils/estEnv';
import {
    activateEstOnRaProfile,
    cleanupEstProfile,
    createEstProfile,
    deactivateEstOnRaProfile,
    DEFAULT_RESPONSE_TIMING,
    deleteEstProfile,
    estProfileName,
    findSystemDefaultEstProfile,
    restoreSystemDefaultEstProfile,
    setEstProfileEnabled,
} from '../../utils/estProfileUtils';
import {
    approve,
    createBasicSecret,
    getCertificateApprovals,
    createPreRegistration,
    createRaProfile,
    deleteRaProfile,
    setSecretEnabled,
    deletePreRegistration,
    deleteSecret,
    deleteTrustedCa,
    importTrustedCa,
} from '../../utils/estFixtures';
import { createCa, certToDer } from '../../utils/estPki';
import { cleanupLedgerFile, clearCleanupFailures, readCleanupFailures } from '../../utils/cleanupLedger';
import estGlobalSetup from '../../utils/estGlobalSetup';
import estGlobalTeardown from '../../utils/estGlobalTeardown';
import { FAKE_EST_ENV, fakeApi } from './estFakeApi';

const env: EstEnv = loadEstEnv(FAKE_EST_ENV);

// Each test has a ledger of its own, whatever another test left in CLEANUP_LEDGER_FILE.
let savedLedgerFile: string | undefined;
test.beforeEach(({}, testInfo) => {
    savedLedgerFile = process.env.CLEANUP_LEDGER_FILE;
    fs.mkdirSync(testInfo.outputDir, { recursive: true });
    process.env.CLEANUP_LEDGER_FILE = testInfo.outputPath('cleanup.jsonl');
    clearCleanupFailures();
});
test.afterEach(() => {
    clearCleanupFailures();
    if (savedLedgerFile === undefined) delete process.env.CLEANUP_LEDGER_FILE;
    else process.env.CLEANUP_LEDGER_FILE = savedLedgerFile;
});

test.describe('admin API', () => {
    test('ensureOk passes on ok and on allowed statuses, throws with status and body otherwise', async () => {
        const reply = (status: number) => ({ ok: () => status < 300, status: () => status, text: async () => 'body' });
        await ensureOk(reply(200), 'x');
        await ensureOk(reply(404), 'x', [404]);
        await expect(ensureOk(reply(500), 'Do thing')).rejects.toThrow('Do thing failed: 500 - body');
    });

    test('CA fingerprints come back lowercase', async () => {
        const { api, calls } = fakeApi(() => ({ body: [{ fingerprint: 'AB12' }, { fingerprint: 'cd34' }] }));
        expect(await getRaProfileCaFingerprints(api, 'auth', 'ra')).toEqual(['ab12', 'cd34']);
        expect(calls[0].url).toBe('/api/v1/authorities/auth/raProfiles/ra/caCertificates');
    });

    test('an RA Profile name is read from its detail, and a failure is raised', async () => {
        const ok = fakeApi(() => ({ body: { name: 'ra-one' } }));
        expect(await getRaProfileName(ok.api, 'ra')).toBe('ra-one');
        expect(ok.calls[0].url).toBe('/api/v1/raProfiles/ra');
        const bad = fakeApi(() => ({ status: 403, body: 'no' }));
        await expect(getRaProfileName(bad.api, 'ra')).rejects.toThrow(/403/);
    });

    test('the admin context is built with the client certificate for the edge origin', async () => {
        const context = await newEstAdminContext({ ...env, adminCertPath: __filename, adminKeyPath: __filename });
        await context.dispose();
    });
});

test.describe('EST profiles', () => {
    test('names carry the EST prefix', () => {
        expect(estProfileName('basic')).toMatch(/^est-e2e-basic-/);
    });

    test('create posts, enables, then reads the URL', async () => {
        const { api, calls } = fakeApi(({ method }) => {
            if (method === 'POST') return { body: { uuid: 'p-1' } };
            if (method === 'GET') return { body: { estUrl: 'https://ilm/.well-known/est/p', ...DEFAULT_RESPONSE_TIMING } };
            return undefined;
        });
        const profile = await createEstProfile(api, {
            name: 'p',
            raProfileUuid: 'ra',
            authenticationPolicy: 'raBasic',
            basicCredentialSecretUuids: ['s-1'],
        });
        expect(profile).toEqual({ uuid: 'p-1', name: 'p', estUrl: 'https://ilm/.well-known/est/p' });
        expect(calls.map((c) => `${c.method} ${c.url}`)).toEqual([
            'POST /api/v1/estProfiles',
            'PATCH /api/v1/estProfiles/p-1/enable',
            'GET /api/v1/estProfiles/p-1',
        ]);
        expect(calls[0].data).toMatchObject({
            name: 'p',
            raProfileUuid: 'ra',
            authenticationPolicy: 'raBasic',
            serverKeyGeneration: false,
            customAttributes: [],
            basicCredentialSecretUuids: ['s-1'],
        });
    });

    test('create sends the response timing it is given and expects it back', async () => {
        const timing = { issueWaitTimeout: 0, retryAfter: 7, serverKeyGenerationTimeout: 45 };
        const { api, calls } = fakeApi(({ method }) => {
            if (method === 'POST') return { body: { uuid: 'p-1' } };
            if (method === 'GET') return { body: { estUrl: 'u', ...timing } };
            return undefined;
        });
        await createEstProfile(api, { name: 'p', raProfileUuid: 'ra', authenticationPolicy: 'raMtls', ...timing });
        expect(calls[0].data).toMatchObject(timing);
    });

    test('create fails when the platform reports a response timing other than the default', async () => {
        const { api, calls } = fakeApi(({ method }) => {
            if (method === 'POST') return { body: { uuid: 'p-1' } };
            if (method === 'GET') return { body: { estUrl: 'u', ...DEFAULT_RESPONSE_TIMING, retryAfter: 60 } };
            return undefined;
        });
        await expect(
            createEstProfile(api, { name: 'p', raProfileUuid: 'ra', authenticationPolicy: 'raMtls' }),
        ).rejects.toThrow('EST Profile p-1 reports retryAfter 60, expected 30');
        expect(calls[0].data).not.toHaveProperty('retryAfter');
        expect(calls.at(-1)).toMatchObject({ method: 'DELETE', url: '/api/v1/estProfiles/p-1' });
    });

    test('create fails when the platform reports no URL', async () => {
        const { api } = fakeApi(({ method }) => (method === 'POST' ? { body: { uuid: 'p-1' } } : { body: {} }));
        await expect(
            createEstProfile(api, { name: 'p', raProfileUuid: 'ra', authenticationPolicy: 'raMtls' }),
        ).rejects.toThrow(/no estUrl/);
    });

    test('a profile whose setup fails after creation is removed and the original error is raised', async () => {
        const { api, calls } = fakeApi(({ method, url }) => {
            if (method === 'POST') return { body: { uuid: 'p-1' } };
            if (url === '/api/v1/estProfiles/p-1/enable') return { status: 500, body: 'enable broke' };
            return undefined;
        });
        await expect(
            createEstProfile(api, { name: 'p', raProfileUuid: 'ra', authenticationPolicy: 'raMtls' }),
        ).rejects.toThrow('Enable EST Profile p-1 failed: 500 - enable broke');
        expect(calls.at(-1)).toMatchObject({ method: 'DELETE', url: '/api/v1/estProfiles/p-1' });
        expect(calls.some((c) => c.method === 'PATCH' && c.url === '/api/v1/estProfiles/p-1/disable')).toBe(true);
    });

    test('activation and deactivation address the RA Profile; deactivation tolerates 404', async () => {
        const { api, calls } = fakeApi(({ url }) => (url.endsWith('/deactivate') ? { status: 404 } : undefined));
        await activateEstOnRaProfile(api, { authorityUuid: 'a', raProfileUuid: 'r', estProfileUuid: 'e' });
        expect(calls[0].url).toBe('/api/v1/authorities/a/raProfiles/r/protocols/est/activate/e');
        expect(calls[0].data).toEqual({ issueCertificateAttributes: [] });
        await activateEstOnRaProfile(api, {
            authorityUuid: 'a', raProfileUuid: 'r', estProfileUuid: 'e', issueCertificateAttributes: [{ n: 1 }],
        });
        expect(calls[1].data).toEqual({ issueCertificateAttributes: [{ n: 1 }] });
        await deactivateEstOnRaProfile(api, { authorityUuid: 'a', raProfileUuid: 'r' });
        expect(calls[2].url).toBe('/api/v1/authorities/a/raProfiles/r/protocols/est/deactivate');
    });

    test('delete disables then deletes, tolerating 404', async () => {
        const { api, calls } = fakeApi(() => ({ status: 404 }));
        await deleteEstProfile(api, 'p-1');
        expect(calls.map((c) => `${c.method} ${c.url}`)).toEqual([
            'PATCH /api/v1/estProfiles/p-1/disable',
            'DELETE /api/v1/estProfiles/p-1',
        ]);
    });

    test('cleanup deactivates first when asked and records nothing on success', async () => {
        const { api, calls } = fakeApi();
        const ok = await cleanupEstProfile(api, { uuid: 'p', name: 'n', estUrl: 'u' }, { authorityUuid: 'a', raProfileUuid: 'r' });
        expect(ok).toBe(true);
        expect(calls[0].url).toContain('/est/deactivate');
        expect(calls.at(-1)?.url).toBe('/api/v1/estProfiles/p');
        expect(readCleanupFailures()).toEqual([]);
        await cleanupEstProfile(api, { uuid: 'p', name: 'n', estUrl: 'u' });
    });

    test('cleanup that cannot remove the profile lands in the ledger', async () => {
        const { api } = fakeApi(({ method }) => (method === 'DELETE' ? { status: 500, body: 'boom' } : undefined));
        const original = global.setTimeout;
        global.setTimeout = ((fn: () => void) => original(fn, 0)) as typeof setTimeout;
        try {
            expect(await cleanupEstProfile(api, { uuid: 'p', name: 'n', estUrl: 'u' })).toBe(false);
        } finally {
            global.setTimeout = original;
        }
        expect(readCleanupFailures()).toMatchObject([{ resource: 'estProfile', uuid: 'p', name: 'n', status: 500 }]);
    });
});

test.describe('system default EST Profile', () => {
    test('the default is the listed profile flagged as system default, if any', async () => {
        const list = [{ uuid: 'a' }, { uuid: 'b', systemDefault: true }];
        const { api, calls } = fakeApi(() => ({ body: list }));
        expect(await findSystemDefaultEstProfile(api)).toBe('b');
        expect(calls).toEqual([{ method: 'GET', url: '/api/v1/estProfiles', data: undefined }]);

        const none = fakeApi(() => ({ body: [{ uuid: 'a', systemDefault: false }] }));
        expect(await findSystemDefaultEstProfile(none.api)).toBeUndefined();
    });

    test('a failed list is raised', async () => {
        const { api } = fakeApi(() => ({ status: 500, body: 'boom' }));
        await expect(findSystemDefaultEstProfile(api)).rejects.toThrow(/List EST Profiles/);
    });

    test('restoring rebuilds the whole profile from its detail and sets the flag', async () => {
        const detail = {
            description: 'd',
            raProfile: { uuid: 'ra-1' },
            systemDefault: false,
            authenticationPolicy: 'raBasic',
            basicCredentialSecrets: [{ uuid: 's-1', name: 'n' }],
            trustedCaCertificates: [{ uuid: 'ca-1', name: 'c' }],
            allowRenewal: true,
            allowRekey: false,
            renewalThreshold: 5,
            serverKeyGeneration: true,
            keyRecovery: true,
            keyRecoveryTokenProfile: { uuid: 'tp-1', name: 't' },
            keyRecoveryKeyAttributes: [{ uuid: 'ka', name: 'k', version: 'v2', content: [1], contentType: 'string' }],
            issueWaitTimeout: 11,
            retryAfter: 12,
            serverKeyGenerationTimeout: 13,
            issueCertificateAttributes: [{ uuid: 'ia', name: 'i', content: [2] }],
            customAttributes: [],
            certificateAssociations: { ownerUuid: 'o-1', groupUuids: ['g-1'], customAttributes: [{ name: 'x', version: 'v3', contentType: 'integer', content: [3] }] },
        };
        const { api, calls } = fakeApi((call) => (call.method === 'GET' ? { body: detail } : undefined));
        await restoreSystemDefaultEstProfile(api, 'p-1');
        expect(calls.map((c) => `${c.method} ${c.url}`)).toEqual(['GET /api/v1/estProfiles/p-1', 'PUT /api/v1/estProfiles/p-1']);
        expect(calls[1].data).toEqual({
            description: 'd',
            raProfileUuid: 'ra-1',
            systemDefault: true,
            authenticationPolicy: 'raBasic',
            basicCredentialSecretUuids: ['s-1'],
            trustedCaCertificateUuids: ['ca-1'],
            allowRenewal: true,
            allowRekey: false,
            renewalThreshold: 5,
            serverKeyGeneration: true,
            keyRecovery: true,
            keyRecoveryTokenProfileUuid: 'tp-1',
            keyRecoveryKeyAttributes: [{ uuid: 'ka', name: 'k', version: 'v2', contentType: 'string', content: [1] }],
            issueWaitTimeout: 11,
            retryAfter: 12,
            serverKeyGenerationTimeout: 13,
            issueCertificateAttributes: [{ uuid: 'ia', name: 'i', content: [2] }],
            customAttributes: [],
            certificateAssociations: { ownerUuid: 'o-1', groupUuids: ['g-1'], customAttributes: [{ name: 'x', version: 'v3', contentType: 'integer', content: [3] }] },
        });
    });

    test('a profile that is still the default is not rewritten', async () => {
        const { api, calls } = fakeApi(() => ({ body: { systemDefault: true, authenticationPolicy: 'raBasic' } }));
        await restoreSystemDefaultEstProfile(api, 'p-1');
        expect(calls.map((c) => c.method)).toEqual(['GET']);
    });

    test('a bare profile restores with empty lists, and a refused update is raised', async () => {
        const bare = { authenticationPolicy: 'certificateRegistration', raProfile: { uuid: 'ra-1' } };
        const ok = fakeApi((call) => (call.method === 'GET' ? { body: bare } : undefined));
        await restoreSystemDefaultEstProfile(ok.api, 'p-1');
        expect(ok.calls[1].data).toMatchObject({
            basicCredentialSecretUuids: [],
            trustedCaCertificateUuids: [],
            customAttributes: [],
            certificateAssociations: undefined,
        });

        const refused = fakeApi((call) => (call.method === 'PUT' ? { status: 422, body: 'no' } : { body: bare }));
        await expect(restoreSystemDefaultEstProfile(refused.api, 'p-1')).rejects.toThrow(/Restore system default/);
    });
});

test.describe('fixtures', () => {
    test('a Basic secret is created in the vault profile, awaited active, then enabled', async () => {
        let polls = 0;
        const { api, calls } = fakeApi(({ method, url }) => {
            if (method === 'POST') return { body: { uuid: 's-1' } };
            if (method === 'GET' && url === '/api/v1/secrets/s-1') return { body: { state: ++polls < 2 ? 'pending' : 'active' } };
            return undefined;
        });
        const secret = await createBasicSecret(api, env, { name: 'n', username: 'u', password: 'p', pollIntervalMs: 1 });
        expect(secret).toEqual({ uuid: 's-1', name: 'n' });
        expect(calls[0].url).toBe('/api/v1/vaults/vault/vaultProfiles/vp/secrets');
        expect(calls[0].data).toMatchObject({ secret: { type: 'basicAuth', username: 'u', password: 'p' } });
        expect(calls.at(-1)).toMatchObject({ method: 'PATCH', url: '/api/v1/secrets/s-1/enable' });
        expect(polls).toBe(2);
    });

    test('a secret that never becomes active times out without leaking its password', async () => {
        const { api } = fakeApi(({ method }) => (method === 'POST' ? { body: { uuid: 's-1' } } : { body: { state: 'pending' } }));
        const error = await createBasicSecret(api, env, {
            name: 'n', username: 'u', password: 'hunter2', timeoutMs: 5, pollIntervalMs: 1,
        }).catch((e) => String(e));
        expect(error).toMatch(/did not become active, last state: pending/);
        expect(error).not.toContain('hunter2');
    });

    test('a secret whose setup fails after creation is disabled and deleted, and the original error is raised', async () => {
        const { api, calls } = fakeApi(({ method, url }) => {
            if (method === 'POST') return { body: { uuid: 's-1' } };
            if (method === 'GET') return { body: { state: 'active' } };
            if (url === '/api/v1/secrets/s-1/enable') return { status: 500, body: 'enable broke' };
            return undefined;
        });
        await expect(
            createBasicSecret(api, env, { name: 'n', username: 'u', password: 'p', pollIntervalMs: 1 }),
        ).rejects.toThrow('Enable secret s-1 failed: 500 - enable broke');
        expect(calls.some((c) => c.method === 'PATCH' && c.url === '/api/v1/secrets/s-1/disable')).toBe(true);
        expect(calls.at(-1)).toMatchObject({ method: 'DELETE', url: '/api/v1/secrets/s-1' });
    });

    test('a secret delete disables then deletes, tolerating 404', async () => {
        const { api, calls } = fakeApi(() => ({ status: 404 }));
        await deleteSecret(api, 's-1');
        expect(calls.map((c) => `${c.method} ${c.url}`)).toEqual(['PATCH /api/v1/secrets/s-1/disable', 'DELETE /api/v1/secrets/s-1']);
    });

    test('a CA is uploaded as base64 DER and then trusted; deleting it deletes the certificate', async () => {
        const ca = createCa({ cn: 'fixture-ca' });
        const { api, calls } = fakeApi(({ method }) => (method === 'POST' ? { body: { uuid: 'c-1' } } : undefined));
        expect(await importTrustedCa(api, ca.cert)).toEqual({ uuid: 'c-1' });
        expect(calls[0].data).toEqual({ certificate: certToDer(ca.cert).toString('base64'), customAttributes: [] });
        expect(calls[1]).toMatchObject({ method: 'PATCH', url: '/api/v1/certificates/c-1', data: { trustedCa: true } });
        await deleteTrustedCa(api, 'c-1');
        expect(calls.at(-1)).toMatchObject({ method: 'DELETE', url: '/api/v1/certificates/c-1' });
    });

    test('a CA that cannot be trusted is deleted again and the original error is raised', async () => {
        const ca = createCa({ cn: 'fixture-ca' });
        const { api, calls } = fakeApi(({ method }) => {
            if (method === 'POST') return { body: { uuid: 'c-1' } };
            if (method === 'PATCH') return { status: 500, body: 'trust broke' };
            return undefined;
        });
        await expect(importTrustedCa(api, ca.cert)).rejects.toThrow('Trust CA c-1 failed: 500 - trust broke');
        expect(calls.at(-1)).toMatchObject({ method: 'DELETE', url: '/api/v1/certificates/c-1' });
    });

    test('a pre-registration defaults to the main RA Profile and can target another', async () => {
        const { api, calls } = fakeApi(() => ({ body: { uuid: 'reg-1' } }));
        expect(await createPreRegistration(api, env, { subjectDn: 'CN=a', secret: 's' })).toEqual({ uuid: 'reg-1' });
        await createPreRegistration(api, env, { subjectDn: 'CN=b', secret: 's', raProfileUuid: 'other' });
        expect(calls[0].url).toBe('/api/v2/operations/authorities/auth/raProfiles/ra/certificates/register');
        expect(calls[0].data).toEqual({ subjectDn: 'CN=a', authorizationSecret: 's' });
        expect(calls[1].url).toContain('/raProfiles/other/');
        await deletePreRegistration(api, 'reg-1');
        expect(calls.at(-1)).toMatchObject({ method: 'DELETE', url: '/api/v1/certificates/reg-1' });
    });
});

test.describe('approvals', () => {
    test('a certificate\'s approvals are listed and one is approved by PATCH', async () => {
        const { api, calls } = fakeApi(({ method }) =>
            method === 'GET' ? { body: { approvals: [{ approvalUuid: 'a-1', status: 'pending' }] } } : undefined,
        );
        expect(await getCertificateApprovals(api, 'c-1')).toEqual([{ approvalUuid: 'a-1', status: 'pending' }]);
        await approve(api, 'a-1');
        expect(calls.map((c) => `${c.method} ${c.url}`)).toEqual([
            'GET /api/v1/certificates/c-1/approvals',
            'PATCH /api/v1/approvals/a-1/approve',
        ]);
    });

    test('a failed approval is raised', async () => {
        const { api } = fakeApi(() => ({ status: 403, body: 'no' }));
        await expect(approve(api, 'a-1')).rejects.toThrow('Approve a-1 failed: 403 - no');
    });
});

test.describe('enable switches and RA Profiles', () => {
    test('an EST Profile and a secret are enabled and disabled by PATCH, and a failure is raised', async () => {
        const { api, calls } = fakeApi((call) => (call.url.endsWith('/s-9/disable') ? { status: 409, body: 'in use' } : undefined));
        await setEstProfileEnabled(api, 'e-1', false);
        await setEstProfileEnabled(api, 'e-1', true);
        await setSecretEnabled(api, 's-1', false);
        await setSecretEnabled(api, 's-1', true);
        expect(calls.map((c) => `${c.method} ${c.url}`)).toEqual([
            'PATCH /api/v1/estProfiles/e-1/disable',
            'PATCH /api/v1/estProfiles/e-1/enable',
            'PATCH /api/v1/secrets/s-1/disable',
            'PATCH /api/v1/secrets/s-1/enable',
        ]);
        await expect(setSecretEnabled(api, 's-9', false)).rejects.toThrow('disable secret s-9 failed: 409 - in use');
    });

    test('an RA Profile is created enabled on the main authority, and deleted after disabling, tolerating 404', async () => {
        const { api, calls } = fakeApi((call) => (call.method === 'POST' ? { body: { uuid: 'rp-1' } } : { status: 404 }));
        expect(await createRaProfile(api, env, 'clash')).toEqual({ uuid: 'rp-1' });
        expect(calls[0]).toEqual({
            method: 'POST',
            url: '/api/v1/authorities/auth/raProfiles',
            data: { name: 'clash', attributes: [], customAttributes: [], enabled: true },
        });
        await deleteRaProfile(api, env, 'rp-1');
        expect(calls.slice(1).map((c) => `${c.method} ${c.url}`)).toEqual([
            'PATCH /api/v1/authorities/auth/raProfiles/rp-1/disable',
            'DELETE /api/v1/authorities/auth/raProfiles/rp-1',
        ]);
    });
});

test.describe('global hooks', () => {
    test('setup empties the ledger and teardown is silent when it is empty', async () => {
        fs.writeFileSync(cleanupLedgerFile(), '{"resource":"estProfile","message":"x"}\n');
        await estGlobalSetup();
        expect(readCleanupFailures()).toEqual([]);
        await estGlobalTeardown();
    });

    test('teardown fails the run with the report when objects were left behind', async () => {
        fs.writeFileSync(cleanupLedgerFile(), '{"resource":"estProfile","uuid":"p-1","name":"n","status":500,"message":"x"}\n');
        await expect(estGlobalTeardown()).rejects.toThrow(/1 object\(s\) could not be removed[\s\S]*estProfile\s+p-1 n/);
    });
});
