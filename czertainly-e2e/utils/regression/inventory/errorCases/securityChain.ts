/**
 * The security-chain rows of the error-contract spec: the protected endpoints, the identities a row sends (anonymous,
 * a forged `alg: none` token, a tampered token), the Authorization header of each and the secrets an answer must not
 * echo. The anonymous health read is the control.
 */
import { base64Url } from '../../text';
import { Req } from './requests';

// ------------------------------------------------------------------ API-GEN-08: the security chain

export interface Protected {
    resource: string;
    url: string;
}

/** ≥ 20 protected GET endpoints across resources (each a read-only controller mapping in `interfaces`; none persists anything). */
export const PROTECTED_ENDPOINTS: readonly Protected[] = [
    { resource: 'certificates', url: '/api/v1/certificates/search' },
    { resource: 'keys', url: '/api/v1/keys/search' },
    { resource: 'discoveries', url: '/api/v1/discoveries/search' },
    { resource: 'groups', url: '/api/v1/groups' },
    { resource: 'credentials', url: '/api/v1/credentials' },
    { resource: 'raProfiles', url: '/api/v1/raProfiles' },
    { resource: 'authorities', url: '/api/v1/authorities' },
    { resource: 'connectors', url: '/api/v1/connectors' },
    { resource: 'users', url: '/api/v1/users' },
    { resource: 'roles', url: '/api/v1/roles' },
    { resource: 'acmeProfiles', url: '/api/v1/acmeProfiles' },
    { resource: 'scepProfiles', url: '/api/v1/scepProfiles' },
    { resource: 'cmpProfiles', url: '/api/v1/cmpProfiles' },
    { resource: 'listViews', url: '/api/v1/listViews' },
    { resource: 'statistics', url: '/api/v1/statistics' },
    { resource: 'customAttributes', url: '/api/v1/attributes/custom' },
    { resource: 'auditLogs', url: '/api/v1/auditLogs/search' },
    { resource: 'oids', url: '/api/v1/oids/search' },
    { resource: 'trustedCertificates', url: '/api/v1/trustedCertificates' },
    { resource: 'tokens', url: '/api/v1/tokens' },
    { resource: 'entities', url: '/api/v1/entities/search' },
    { resource: 'locations', url: '/api/v1/locations/search' },
    { resource: 'secrets', url: '/api/v1/secrets/search' },
    { resource: 'vaults', url: '/api/v1/vaults/search' },
    { resource: 'notificationProfiles', url: '/api/v1/notificationProfiles' },
    { resource: 'complianceProfiles', url: '/api/v1/complianceProfiles' },
    { resource: 'approvalProfiles', url: '/api/v1/approvalProfiles' },
    { resource: 'settings', url: '/api/v1/settings/platform' },
    { resource: 'enums', url: '/api/v1/enums' },
    { resource: 'resources', url: '/api/v1/resources' },
    { resource: 'profile', url: '/api/v1/auth/profile' },
    { resource: 'info', url: '/api/v1/info' },
];

export type Identity = 'none' | 'garbage-bearer' | 'garbage-jwt' | 'alg-none' | 'garbage-basic' | 'tampered-bearer';

export interface ForgeOptions {
    /** The `alg` header value (default `none`). */
    alg?: string;
    /** Claims of the forged token (fixed by the caller; nothing of a real identity). */
    claims?: Record<string, unknown>;
}

/** An unsecured JWT (RFC 7519 §6): `{"alg":"none"}` header, claims, an EMPTY signature segment. */
export function forgeAlgNone(opts: ForgeOptions = {}): string {
    const header = { alg: opts.alg ?? 'none', typ: 'JWT' };
    const claims = opts.claims ?? { sub: 'qa-forged', iat: 1_700_000_000, exp: 4_102_444_800 };
    return `${base64Url(JSON.stringify(header))}.${base64Url(JSON.stringify(claims))}.`;
}

/** The Authorization header value of a fabricated identity (never the run's own token), or undefined for `none` / `tampered-bearer`. */
export function authorizationOf(identity: Identity, marker: string): string | undefined {
    switch (identity) {
        case 'garbage-bearer': return `Bearer ${marker}`;
        case 'garbage-jwt': return `Bearer ${base64Url('{"alg":"RS256"}')}.${base64Url(`{"sub":"${marker}"}`)}.${base64Url('not-a-signature')}`;
        case 'alg-none': return `Bearer ${forgeAlgNone({ claims: { sub: marker, iat: 1_700_000_000, exp: 4_102_444_800 } })}`;
        case 'garbage-basic': return `Basic ${Buffer.from(`${marker}:${marker}`).toString('base64')}`;
        default: return undefined;
    }
}

/** The credential strings an answer must not repeat. */
export function secretsOf(authorization: string | undefined, marker: string): string[] {
    if (!authorization) return [];
    const value = authorization.replace(/^(?:Bearer|Basic) /, '');
    return [...new Set([marker, value, ...value.split('.').filter((s) => s.length >= 8)])];
}

/** An identity row request: a GET with the fabricated Authorization header (`identityOverride`, the guard's switch for 401 negatives). */
export const identityReq = (url: string, authorization: string): Req => ({ method: 'GET', url, headers: { authorization }, identityOverride: true });

export const ANONYMOUS_HEALTH = [
    { id: 'health', path: '/api/v1/health', exactBody: false },
    { id: 'liveness', path: '/api/v1/health/liveness', exactBody: true },
    { id: 'readiness', path: '/api/v1/health/readiness', exactBody: true },
] as const;
