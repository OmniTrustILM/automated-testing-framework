import * as dotenv from 'dotenv';
dotenv.config();

type AuthMode = 'local' | 'oidc';

export type TestEnv = {
  baseUrl: string;
  authMode: AuthMode;
  username: string;
  password: string;
  clientSecret?: string;
  authClientId: string;
  authRealm: string;
  authBaseUrl?: string;
  localAuthProviderName: string;
  discoveryProviderName?: string;
  discoveryProviderUrl?: string;
  discoveryTarget?: string;

  // SMK-004 — Issue Certificate (per-run creation via API in globalSetup)
  ejbcaConnectorName: string;
  credentialConnectorName: string;
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

  return {
    baseUrl: required('BASE_URL'),
    authMode,
    username: required('SMOKE_USERNAME'),
    password: required('SMOKE_PASSWORD'),
    clientSecret: process.env.SMOKE_CLIENT_SECRET,
    authClientId: process.env.AUTH_CLIENT_ID || 'ilm',
    authRealm: process.env.AUTH_REALM || 'ILM',
    authBaseUrl: process.env.AUTH_BASE_URL, // Defaults to baseUrl/kc if not set
    localAuthProviderName: required('LOCAL_AUTH_PROVIDER_NAME'),
    discoveryProviderUrl: process.env.DISCOVERY_PROVIDER_URL,
    discoveryProviderName: process.env.DISCOVERY_PROVIDER_NAME,
    discoveryTarget: process.env.DISCOVERY_TARGET,

    // SMK-004 — Issue Certificate (per-run creation via API in globalSetup)
    ejbcaConnectorName: process.env.EJBCA_CONNECTOR_NAME || 'EJBCA-NG-Connector',
    credentialConnectorName: process.env.CREDENTIAL_CONNECTOR_NAME || 'Common-Credential-Connector',
    ejbcaWsUrl: process.env.EJBCA_WS_URL,
    ejbcaP12Base64: process.env.EJBCA_P12_BASE64,
    ejbcaP12Password: process.env.EJBCA_P12_PASSWORD,
    ejbcaCaName: process.env.EJBCA_CA_NAME,
    ejbcaEndEntityProfile: process.env.EJBCA_END_ENTITY_PROFILE,
    ejbcaCertificateProfile: process.env.EJBCA_CERTIFICATE_PROFILE,
  };
}
