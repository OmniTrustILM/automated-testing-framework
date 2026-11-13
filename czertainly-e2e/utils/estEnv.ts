/**
 * estEnv.ts — configuration of the EST (RFC 7030) suite.
 *
 * WHAT: builds a typed `EstEnv` from the EST_* variables of `.env.est`.
 * WHY: the EST suite needs its own environment (an edge that serves /.well-known/est, an admin
 *      client certificate, pre-provisioned RA Profiles) and must never make the smoke suite
 *      require any of it.
 * HOW: `loadEstEnv()` validates every required variable as one group and throws a single error
 *      naming all that are missing. It is called from hooks, never at import time, so listing the
 *      specs works without any EST variable. It takes the environment as a parameter so tests can
 *      pass their own record. The revoked client certificates are an optional group: they need a CRL
 *      the platform can fetch, so they come from the environment's provisioning, all or none.
 */

export type RevokedClient = {
  /** Inventory UUID of the CA certificate that issued the revoked client certificate. */
  caUuid: string;
  certPath: string;
  keyPath: string;
};

export type EstEnv = {
  baseUrl: string;
  adminCertPath: string;
  adminKeyPath: string;
  authorityUuid: string;
  raProfileUuid: string;
  labelRaProfileUuid: string;
  approvalRaProfileUuid: string;
  pendingAuthorityUuid: string;
  pendingRaProfileUuid: string;
  vaultUuid: string;
  vaultProfileUuid: string;
  keyRecoveryTokenUuid: string;
  keyRecoveryTokenProfileUuid: string;
  estclientImage?: string;
  /** CA of the edge's TLS certificate, which a real EST client must trust. */
  edgeCaPath?: string;
  kubeconfigPath?: string;
  revoked?: { vendor: RevokedClient; ra: RevokedClient };
};

const REQUIRED: Array<[keyof EstEnv, string]> = [
  ['baseUrl', 'EST_BASE_URL'],
  ['adminCertPath', 'EST_ADMIN_CERT'],
  ['adminKeyPath', 'EST_ADMIN_KEY'],
  ['authorityUuid', 'EST_AUTHORITY_UUID'],
  ['raProfileUuid', 'EST_RA_PROFILE_UUID'],
  ['labelRaProfileUuid', 'EST_LABEL_RA_PROFILE_UUID'],
  ['approvalRaProfileUuid', 'EST_APPROVAL_RA_PROFILE_UUID'],
  ['pendingAuthorityUuid', 'EST_PENDING_AUTHORITY_UUID'],
  ['pendingRaProfileUuid', 'EST_PENDING_RA_PROFILE_UUID'],
  ['vaultUuid', 'EST_VAULT_UUID'],
  ['vaultProfileUuid', 'EST_VAULT_PROFILE_UUID'],
  ['keyRecoveryTokenUuid', 'EST_KEY_RECOVERY_TOKEN_UUID'],
  ['keyRecoveryTokenProfileUuid', 'EST_KEY_RECOVERY_TOKEN_PROFILE_UUID'],
];

const REVOKED = [
  'EST_REVOKED_VENDOR_CA_UUID',
  'EST_REVOKED_VENDOR_CERT',
  'EST_REVOKED_VENDOR_KEY',
  'EST_REVOKED_RA_CA_UUID',
  'EST_REVOKED_RA_CERT',
  'EST_REVOKED_RA_KEY',
];

function loadRevoked(source: Record<string, string | undefined>): EstEnv['revoked'] {
  const missing = REVOKED.filter((name) => !source[name]);
  if (missing.length === REVOKED.length) return undefined;
  if (missing.length > 0) {
    throw new Error(`EST revoked client certificates incomplete: ${missing.join(', ')}.`);
  }
  const client = (prefix: string): RevokedClient => ({
    caUuid: source[`${prefix}_CA_UUID`] as string,
    certPath: source[`${prefix}_CERT`] as string,
    keyPath: source[`${prefix}_KEY`] as string,
  });
  return { vendor: client('EST_REVOKED_VENDOR'), ra: client('EST_REVOKED_RA') };
}

export function loadEstEnv(source: Record<string, string | undefined> = process.env): EstEnv {
  const missing = REQUIRED.filter(([, name]) => !source[name]).map(([, name]) => name);
  if (missing.length > 0) {
    throw new Error(`EST env incomplete: ${missing.join(', ')}.`);
  }

  const env: Record<string, unknown> = {
    estclientImage: source.EST_ESTCLIENT_IMAGE || undefined,
    edgeCaPath: source.EST_EDGE_CA_CERT || undefined,
    kubeconfigPath: source.KUBECONFIG_PATH || undefined,
    revoked: loadRevoked(source),
  };
  for (const [key, name] of REQUIRED) env[key] = source[name];
  return env as EstEnv;
}
