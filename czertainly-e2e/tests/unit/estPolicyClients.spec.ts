/**
 * Unit tests for the per-policy EST clients against a fake request context: which objects each
 * policy creates, what its enrollments carry, and that every object is registered for cleanup.
 */
import { test, expect } from '@playwright/test';
import { EstEnv, loadEstEnv } from '../../utils/estEnv';
import { createPolicyClient, ID_KP_CMC_RA, POLICIES } from '../../utils/estPolicyClients';
import { clearCleanupFailures, readCleanupFailures } from '../../utils/cleanupLedger';
import { Call, FAKE_EST_ENV, fakeApi, fakePlatform } from './estFakeApi';
import * as crypto from 'crypto';

const env: EstEnv = loadEstEnv(FAKE_EST_ENV);

function profileCreation(log: Call[]): Record<string, unknown> {
    return log.find((c) => c.method === 'POST' && c.url === '/api/v1/estProfiles')?.data as Record<string, unknown>;
}

async function setUp(policy: (typeof POLICIES)[number], options = {}) {
    const { api, calls: log } = fakeApi(fakePlatform);
    const steps: Array<() => Promise<unknown>> = [];
    const client = await createPolicyClient(api, env, (step) => steps.push(step), policy, 'unit', options);
    return { client, log, steps };
}

test.beforeEach(() => clearCleanupFailures());
test.afterEach(() => clearCleanupFailures());

test('the four policies are covered in a fixed order', () => {
    expect(POLICIES).toEqual(['raBasic', 'certificateRegistration', 'vendorMtls', 'raMtls']);
});

test('raBasic creates a secret and a profile on the main RA Profile, and enrolls with Basic credentials', async () => {
    const { client, log, steps } = await setUp('raBasic', { renewalThreshold: 3650 });
    expect(profileCreation(log)).toMatchObject({
        authenticationPolicy: 'raBasic',
        raProfileUuid: 'ra',
        renewalThreshold: 3650,
        basicCredentialSecretUuids: [expect.any(String)],
    });
    const enrollment = await client.nextEnrollment();
    expect(enrollment.credentials.basicAuth?.password).toMatch(/^[0-9a-f]{32}$/);
    expect(enrollment.reenrollBasicAuth).toBeUndefined();
    expect(enrollment.subject[0].value).not.toBe((await client.nextEnrollment()).subject[0].value);
    expect(steps).toHaveLength(2);
});

test('certificateRegistration registers a fresh subject per enrollment on the chosen RA Profile', async () => {
    const { client, log, steps } = await setUp('certificateRegistration', { raProfileUuid: 'ra-approval' });
    expect(profileCreation(log)).toMatchObject({ authenticationPolicy: 'certificateRegistration', raProfileUuid: 'ra-approval' });
    const enrollment = await client.nextEnrollment();
    const registration = log.at(-1)!;
    expect(registration.url).toBe('/api/v2/operations/authorities/auth/raProfiles/ra-approval/certificates/register');
    expect(registration.data).toMatchObject({ subjectDn: `CN=${enrollment.subject[0].value}` });
    expect(enrollment.credentials.basicAuth?.username).toMatch(/^u-\d+$/);
    expect(enrollment.reenrollBasicAuth).toEqual(enrollment.credentials.basicAuth);
    expect(steps).toHaveLength(2);
});

test('vendorMtls trusts a vendor CA and enrolls with a device certificate for the same identity', async () => {
    const { client, log, steps } = await setUp('vendorMtls');
    expect(log[0].url).toBe('/api/v1/certificates/upload');
    expect(profileCreation(log)).toMatchObject({ trustedCaCertificateUuids: [expect.any(String)] });
    const enrollment = await client.nextEnrollment();
    const device = new crypto.X509Certificate(enrollment.credentials.clientCert!.cert);
    expect(device.subject).toContain(`CN=${enrollment.subject[0].value}`);
    expect(device.subjectAltName).toBe(`DNS:${enrollment.sans![0]}`);
    expect(steps).toHaveLength(2);
});

test('raMtls trusts an RA CA and enrolls other subjects with one RA certificate carrying id-kp-cmcRA', async () => {
    const { client, steps } = await setUp('raMtls');
    const first = await client.nextEnrollment();
    const second = await client.nextEnrollment();
    expect(first.credentials.clientCert).toBe(second.credentials.clientCert);
    const ra = new crypto.X509Certificate(first.credentials.clientCert!.cert);
    expect(ra.keyUsage).toContain(ID_KP_CMC_RA);
    expect(ra.subject).not.toContain(String(first.subject[0].value));
    expect(steps).toHaveLength(2);
});

test('the registered cleanup steps remove what was created and record nothing when they succeed', async () => {
    const { log, steps } = await setUp('raBasic');
    for (const step of steps.reverse()) await step();
    expect(log.filter((c) => c.method === 'DELETE').map((c) => c.url)).toEqual([
        expect.stringMatching(/^\/api\/v1\/estProfiles\//),
        expect.stringMatching(/^\/api\/v1\/secrets\//),
    ]);
    expect(readCleanupFailures()).toEqual([]);
});
