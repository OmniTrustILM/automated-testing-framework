/**
 * estFakeApi — a minimal stand-in for Playwright's APIRequestContext, and a complete EST
 * environment, for unit tests.
 *
 * It records every call and answers from a responder, so the helpers that talk to the platform
 * can be tested for the requests they make without a platform.
 */
import { APIRequestContext } from '@playwright/test';
import { DEFAULT_RESPONSE_TIMING } from '../../utils/estProfileUtils';

/** A complete set of `EST_*` variables for helpers that need an EST environment. */
export const FAKE_EST_ENV: Record<string, string> = {
    EST_BASE_URL: 'https://ilm.example.com:8443',
    EST_ADMIN_CERT: '/x/admin.crt',
    EST_ADMIN_KEY: '/x/admin.key',
    EST_AUTHORITY_UUID: 'auth',
    EST_RA_PROFILE_UUID: 'ra',
    EST_LABEL_RA_PROFILE_UUID: 'ra-label',
    EST_APPROVAL_RA_PROFILE_UUID: 'ra-approval',
    EST_PENDING_RA_PROFILE_UUID: 'ra-pending',
    EST_VAULT_UUID: 'vault',
    EST_VAULT_PROFILE_UUID: 'vp',
    EST_KEY_RECOVERY_TOKEN_PROFILE_UUID: 'tokp',
};

export interface Call {
    method: string;
    url: string;
    data?: unknown;
}

export interface FakeReply {
    status?: number;
    body?: unknown;
}

export function fakeApi(responder: (call: Call) => FakeReply | undefined = () => undefined) {
    const calls: Call[] = [];
    const send = async (method: string, url: string, options?: { data?: unknown }) => {
        const call = { method, url, data: options?.data };
        calls.push(call);
        const { status = 200, body = {} } = responder(call) ?? {};
        const text = typeof body === 'string' ? body : JSON.stringify(body);
        return { ok: () => status >= 200 && status < 300, status: () => status, text: async () => text, json: async () => body };
    };
    const api = {
        get: (url: string, o?: { data?: unknown }) => send('GET', url, o),
        post: (url: string, o?: { data?: unknown }) => send('POST', url, o),
        patch: (url: string, o?: { data?: unknown }) => send('PATCH', url, o),
        delete: (url: string, o?: { data?: unknown }) => send('DELETE', url, o),
    } as unknown as APIRequestContext;
    return { api, calls };
}

/**
 * Answers like the platform: a certificate search finds nothing, other created objects get a UUID,
 * secrets are active, profiles have a URL.
 */
let created = 0;
export function fakePlatform(call: Call): FakeReply | undefined {
    if (call.method === 'POST' && call.url === '/api/v1/certificates') return { body: { certificates: [] } };
    if (call.method === 'POST') return { body: { uuid: `u-${++created}` } };
    if (call.url.startsWith('/api/v1/secrets/')) return { body: { state: 'active' } };
    if (call.url.startsWith('/api/v1/estProfiles/')) return { body: { estUrl: 'https://ilm/.well-known/est/x', ...DEFAULT_RESPONSE_TIMING } };
    return undefined;
}
