/**
 * env.ts — loads `.env` and builds the validated, typed `TestEnv`.
 * Every smoke var must be present, otherwise `loadEnv` throws. `SMOKE_PERSIST=true` reuses the state file and keeps it at teardown.
 */

import { loadDotenv } from './envFile';
import { assertAuthModeAllowed } from './regression/tier/localProof';
// REG_ENV_FILE, when set, is the only env file read; existing variables win. API_ENV_FILE is not read here.
loadDotenv();

// header: local development stack: the frontend dev proxy injects the client certificate; no identity provider.
type AuthMode = 'local' | 'oidc' | 'header';

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
  kubeconfigPath?: string;  // KUBECONFIG_PATH — for local k8s access; ignored in-cluster (uses ServiceAccount token)
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

  // SMK-005 - Issue Certificate through ACME
  namespace?: string;  // SMOKE_TESTS_NAMESPACE — where the test creates Issuer / Certificate / Secret
  acmeSolverDomain?: string;  // ACME_SOLVER_DOMAIN — parent domain of the name the HTTP-01 solver answers on
  acmeSolver: AcmeSolver;     // ACME_SOLVER_GATEWAY, else ACME_INGRESS_CLASS — how the solver is routed
};

export type AcmeSolver =
  | { kind: 'ingress'; ingressClassName: string }
  | { kind: 'gateway'; gatewayName: string };

/**
 * A solver of the kind the cluster's ingress controller does not serve is never reached; ACME_SOLVER_GATEWAY selects an HTTPRoute solver,
 * else an Ingress of ACME_INGRESS_CLASS.
 */
export function acmeSolverFrom(gatewayName?: string, ingressClass?: string): AcmeSolver {
  if (gatewayName) return { kind: 'gateway', gatewayName };
  return { kind: 'ingress', ingressClassName: ingressClass || 'nginx' };
}

/** The solver's name must sit under the cluster's wildcard DNS: `fe-pr-1.preview.example.com` gives `preview.example.com`. */
export function parentDomainOf(baseUrl: string): string {
  const labels = new URL(baseUrl).hostname.split('.');
  return labels.slice(1).join('.');
}

function required(name: string): string {
  const value = process.env[name];
  if (!value) {
    throw new Error(`Missing required env var: ${name}`);
  }
  return value;
}

export function loadEnv(): TestEnv {
  const authMode = (process.env.AUTH_MODE ?? 'local') as AuthMode;
  if (authMode !== 'local' && authMode !== 'oidc' && authMode !== 'header') {
    throw new Error(`AUTH_MODE must be 'local', 'oidc' or 'header', but got: ${process.env.AUTH_MODE}`);
  }
  // header mode trusts a dev proxy: only on a loopback / TIER_LOCAL_HOSTS stack.
  assertAuthModeAllowed(process.env);

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
    kubeconfigPath: process.env.KUBECONFIG_PATH,
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

      namespace: process.env.SMOKE_TESTS_NAMESPACE,
      acmeSolverDomain: process.env.ACME_SOLVER_DOMAIN || parentDomainOf(required('BASE_URL')),
      acmeSolver: acmeSolverFrom(process.env.ACME_SOLVER_GATEWAY, process.env.ACME_INGRESS_CLASS),
    },
  };

  // No bypass: every smoke env var must be present. SMOKE_PERSIST affects only state reuse.
  const missing = getMissingSmokeVars(env);
  if (missing.length > 0) {
    throw new Error(`Smoke env incomplete: ${missing.join(', ')}.`);
  }

  return env;
}

/** Names of the SMK-required env vars that are missing (camelCase field names as SCREAMING_SNAKE_CASE). */
export function getMissingSmokeVars(env: TestEnv): string[] {
  const toEnvVarName = (key: string): string =>
    key.split(/(?=[A-Z])/).join('_').toUpperCase();
  return Object.entries(env.smoke)
    .filter(([, v]) => !v)
    .map(([k]) => toEnvVarName(k));
}
