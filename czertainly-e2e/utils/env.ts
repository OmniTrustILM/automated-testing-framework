/**
 * env.ts — single source of truth for test configuration.
 *
 * WHAT: loads `.env` via dotenv, builds a typed `TestEnv` object, validates it.
 * WHY: tests stay decoupled from raw `process.env` strings and get fail-fast errors
 *      when something is missing, instead of mysterious failures deep in a test.
 * HOW: `loadEnv()` reads env vars, applies defaults where it makes sense, calls
 *      `required()` for vars every test needs (baseUrl, credentials). Smoke-only
 *      vars live in nested `env.smoke` and are validated as a group: every smoke
 *      var must be present, otherwise loadEnv throws and the whole suite fails red.
 *
 *      `SMOKE_PERSIST=true` makes globalSetup reuse a previously-written state
 *      file (no re-provisioning) and globalTeardown preserve it. Strict env
 *      validation still applies in both modes.
 */

import * as dotenv from 'dotenv';
dotenv.config(); // reads .env in current dir, copies KEY=VALUE into process.env

type AuthMode = 'local' | 'oidc';

export type TestEnv = {
  baseUrl: string;
  authMode: AuthMode; // default 'local'
  username: string;
  password: string;
  clientSecret?: string; // needed only for oidc
  authClientId: string; // default 'ilm'
  authRealm: string; // default 'ILM'
  authBaseUrl?: string;
  localAuthProviderName: string;
  smokePersist: boolean;  // SMOKE_PERSIST=true → reuse state between runs, skip teardown
  smoke: SmokeEnv;
};

export type SmokeEnv = {
  // SMK-003 — Network Discovery
  discoveryProviderName?: string;
  discoveryProviderUrl?: string;
  discoveryTarget?: string;

  // SMK-004 — Issue Certificate (setup config + per-run data)
  ejbcaConnectorName?: string;        // name under which to register the EJBCA connector in Core
  ejbcaConnectorUrl?: string;         // cluster-internal service URL of the EJBCA connector pod
  credentialConnectorName?: string;   // name under which to register the credential-provider connector in Core
  credentialConnectorUrl?: string;    // cluster-internal service URL of the credential-provider connector pod
  ejbcaWsUrl?: string;
  ejbcaP12Base64?: string;
  ejbcaP12Password?: string;
  ejbcaCaName?: string;
  ejbcaEndEntityProfile?: string;
  ejbcaCertificateProfile?: string;
};

function required(name: string): string {
  const value = process.env[name];
  if (!value) {
    throw new Error(`Missing required env var: ${name}`);
  }
  return value;
}

export function loadEnv(): TestEnv {
  const authMode = (process.env.AUTH_MODE ?? 'local') as AuthMode;
  if (authMode !== 'local' && authMode !== 'oidc') {
    throw new Error(`AUTH_MODE must be either 'local' or 'oidc', but got: ${process.env.AUTH_MODE}`);
  }

  const env: TestEnv = { // build up the object
    baseUrl: required('BASE_URL'),
    authMode,
    username: required('SMOKE_USERNAME'),
    password: required('SMOKE_PASSWORD'),
    clientSecret: process.env.SMOKE_CLIENT_SECRET,
    authClientId: process.env.AUTH_CLIENT_ID || 'ilm',
    authRealm: process.env.AUTH_REALM || 'ILM',
    authBaseUrl: process.env.AUTH_BASE_URL, // Defaults to baseUrl/kc if not set
    localAuthProviderName: required('LOCAL_AUTH_PROVIDER_NAME'),
    smokePersist: process.env.SMOKE_PERSIST === 'true',
    smoke: {
      discoveryProviderName: process.env.DISCOVERY_PROVIDER_NAME,
      discoveryProviderUrl: process.env.DISCOVERY_PROVIDER_URL,
      discoveryTarget: process.env.DISCOVERY_TARGET,

      ejbcaConnectorName: process.env.EJBCA_CONNECTOR_NAME,
      ejbcaConnectorUrl: process.env.EJBCA_CONNECTOR_URL,
      credentialConnectorName: process.env.CREDENTIAL_CONNECTOR_NAME,
      credentialConnectorUrl: process.env.CREDENTIAL_CONNECTOR_URL,
      ejbcaWsUrl: process.env.EJBCA_WS_URL,
      ejbcaP12Base64: process.env.EJBCA_P12_BASE64,
      ejbcaP12Password: process.env.EJBCA_P12_PASSWORD,
      ejbcaCaName: process.env.EJBCA_CA_NAME,
      ejbcaEndEntityProfile: process.env.EJBCA_END_ENTITY_PROFILE,
      ejbcaCertificateProfile: process.env.EJBCA_CERTIFICATE_PROFILE,
    },
  };

  // Strict smoke validation — every smoke env var must be present, otherwise the
  // whole suite fails red. There's no bypass; if you don't have full secrets, get
  // them from the team. SMOKE_PERSIST only affects state reuse, not validation.
  const missing = getMissingSmokeVars(env);
  if (missing.length > 0) {
    throw new Error(`Smoke env incomplete: ${missing.join(', ')}.`);
  }

  return env;
}

/**
 * Returns names of SMK-required env vars that are currently missing.
 * Called by loadEnv() itself to enforce strict validation — if anything's missing,
 * loadEnv throws and the whole suite fails red.
 *
 * Field names in SmokeEnv use camelCase and are converted to SCREAMING_SNAKE_CASE
 * to match the .env variable names (e.g. ejbcaWsUrl → EJBCA_WS_URL).
 */
export function getMissingSmokeVars(env: TestEnv): string[] {
  const toEnvVarName = (key: string): string =>
    key.split(/(?=[A-Z])/).join('_').toUpperCase();
  return Object.entries(env.smoke)
    .filter(([, v]) => !v)
    .map(([k]) => toEnvVarName(k));
}
