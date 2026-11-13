/**
 * Unit tests for the EST environment loader: validated as one group, with every missing
 * variable named, and optional values left undefined.
 */
import { test, expect } from '@playwright/test';
import { loadEstEnv } from '../../utils/estEnv';

const COMPLETE: Record<string, string> = {
    EST_BASE_URL: 'https://ilm.example.com:8443',
    EST_ADMIN_CERT: '/tmp/admin.crt',
    EST_ADMIN_KEY: '/tmp/admin.key',
    EST_AUTHORITY_UUID: 'a-1',
    EST_RA_PROFILE_UUID: 'r-1',
    EST_LABEL_RA_PROFILE_UUID: 'r-2',
    EST_APPROVAL_RA_PROFILE_UUID: 'r-3',
    EST_PENDING_RA_PROFILE_UUID: 'r-4',
    EST_VAULT_UUID: 'v-1',
    EST_VAULT_PROFILE_UUID: 'vp-1',
    EST_KEY_RECOVERY_TOKEN_PROFILE_UUID: 'tp-1',
};

test('a complete environment maps to the typed object', () => {
    const env = loadEstEnv({ ...COMPLETE, EST_ESTCLIENT_IMAGE: 'img:1', EST_EDGE_CA_CERT: '/tmp/edge.crt', KUBECONFIG_PATH: '/tmp/kube' });
    expect(env.baseUrl).toBe('https://ilm.example.com:8443');
    expect(env.adminCertPath).toBe('/tmp/admin.crt');
    expect(env.keyRecoveryTokenProfileUuid).toBe('tp-1');
    expect(env.estclientImage).toBe('img:1');
    expect(env.edgeCaPath).toBe('/tmp/edge.crt');
    expect(env.kubeconfigPath).toBe('/tmp/kube');
});

test('optional variables may be absent', () => {
    const env = loadEstEnv(COMPLETE);
    expect(env.estclientImage).toBeUndefined();
    expect(env.edgeCaPath).toBeUndefined();
    expect(env.kubeconfigPath).toBeUndefined();
});

test('every missing variable is named in one error', () => {
    const { EST_BASE_URL, EST_VAULT_UUID, ...rest } = COMPLETE;
    expect(() => loadEstEnv({ ...rest, EST_RA_PROFILE_UUID: '' })).toThrow(
        /EST_BASE_URL, EST_RA_PROFILE_UUID, EST_VAULT_UUID/,
    );
});

test('nothing is validated until the loader is called', () => {
    expect(() => loadEstEnv({})).toThrow(/EST env incomplete/);
});

const REVOKED: Record<string, string> = {
    EST_REVOKED_VENDOR_CA_UUID: 'vca',
    EST_REVOKED_VENDOR_CERT: '/tmp/v.crt',
    EST_REVOKED_VENDOR_KEY: '/tmp/v.key',
    EST_REVOKED_RA_CA_UUID: 'rca',
    EST_REVOKED_RA_CERT: '/tmp/r.crt',
    EST_REVOKED_RA_KEY: '/tmp/r.key',
};

test('the revoked client certificates are absent, or read as one group', () => {
    expect(loadEstEnv(COMPLETE).revoked).toBeUndefined();
    expect(loadEstEnv({ ...COMPLETE, ...REVOKED }).revoked).toEqual({
        vendor: { caUuid: 'vca', certPath: '/tmp/v.crt', keyPath: '/tmp/v.key' },
        ra: { caUuid: 'rca', certPath: '/tmp/r.crt', keyPath: '/tmp/r.key' },
    });
});

test('a partial revoked group names what is missing', () => {
    const { EST_REVOKED_RA_KEY, EST_REVOKED_VENDOR_CERT, ...partial } = REVOKED;
    expect(() => loadEstEnv({ ...COMPLETE, ...partial })).toThrow(
        'EST revoked client certificates incomplete: EST_REVOKED_VENDOR_CERT, EST_REVOKED_RA_KEY.',
    );
});
